// The instruments and effects, built from Web Audio nodes. The same graph runs on a live
// AudioContext and on an OfflineAudioContext, so the tests render exactly what a visitor hears.
import { rng } from '../../assets/js/kit.js';
import { mtof } from './theory.js';
import { VOICES } from './moods.js';
import { BEATS } from './compose.js';

const CEILING = 0.98;
const KNEE = 0.8;

// Last line of defence: the identity up to ±0.8, then a smooth knee that cannot pass the ceiling.
function softClipCurve() {
  const n = 2049;
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    const a = Math.abs(x);
    const y = a <= KNEE ? a : KNEE + (CEILING - KNEE) * Math.tanh((a - KNEE) / (CEILING - KNEE));
    curve[i] = x < 0 ? -y : y;
  }
  return curve;
}

// A room made of noise: exponentially decaying, independent in each ear, and filtered so the
// high frequencies die away first.
function impulseResponse(ctx, seconds) {
  const rate = ctx.sampleRate;
  const length = Math.floor(seconds * rate);
  const buffer = ctx.createBuffer(2, length, rate);
  const predelay = Math.floor(0.012 * rate);
  for (let ch = 0; ch < 2; ch++) {
    const noise = rng(0x5eed + ch * 7919);
    const data = buffer.getChannelData(ch);
    let low = 0;
    for (let i = predelay; i < length; i++) {
      const t = (i - predelay) / rate;
      const a = 0.08 + 0.6 * Math.exp((-4 * t) / seconds);
      low += a * (noise() * 2 - 1 - low);
      data[i] = low * Math.exp((-6.9 * t) / seconds) * Math.min(1, t / 0.004);
    }
  }
  return buffer;
}

function noiseBuffer(ctx) {
  const buffer = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  const noise = rng(0xbeef);
  for (let i = 0; i < data.length; i++) data[i] = noise() * 2 - 1;
  return buffer;
}

/**
 * createSynth(ctx, mood, secondsPerBeat) → { analyser, play(event, time, spb), setTempo, setMute,
 * fade, silence, dispose, voices }. Every gain is ramped; every voice disconnects itself when done.
 */
export function createSynth(ctx, mood, spb) {
  const s = mood.sound;
  const live = new Set();
  const gain = (value) => {
    const g = ctx.createGain();
    g.gain.value = value;
    return g;
  };
  const panner = (pan) => {
    if (!ctx.createStereoPanner) return ctx.createGain();
    const p = ctx.createStereoPanner();
    p.pan.value = pan;
    return p;
  };
  const filter = (type, frequency, q) => {
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = frequency;
    f.Q.value = q;
    return f;
  };
  const dynamics = (threshold, knee, ratio, attack, release) => {
    const d = ctx.createDynamicsCompressor();
    d.threshold.value = threshold;
    d.knee.value = knee;
    d.ratio.value = ratio;
    d.attack.value = attack;
    d.release.value = release;
    return d;
  };
  const chain = (...nodes) => nodes.reduce((a, b) => (a.connect(b), b));

  // master: sum → gentle compression → volume / fades → limiter → safety clip → analyser
  const sum = gain(1);
  const master = gain(0);
  const clip = ctx.createWaveShaper();
  clip.curve = softClipCurve();
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 2048;
  analyser.smoothingTimeConstant = 0.78;
  chain(sum, dynamics(-20, 12, 3, 0.01, 0.25), master, dynamics(-4, 0, 20, 0.002, 0.12), clip, analyser, ctx.destination);

  // reverb
  const reverbIn = gain(1);
  const convolver = ctx.createConvolver();
  convolver.buffer = impulseResponse(ctx, s.reverb.seconds);
  chain(reverbIn, convolver, gain(0.9), sum);

  // ping-pong delay locked to the tempo: a dotted eighth on the left, an eighth later on the right
  const delayIn = gain(1);
  const delayL = ctx.createDelay(2.5);
  const delayR = ctx.createDelay(2.5);
  const delayTimes = (beat) => [Math.min(2.4, 0.75 * beat), Math.min(2.4, 0.5 * beat)];
  [delayL.delayTime.value, delayR.delayTime.value] = delayTimes(spb);
  chain(delayIn, delayL, panner(-0.75), gain(0.8), sum);
  chain(delayL, filter('lowpass', 2600, 0.5), delayR, panner(0.75), gain(0.8), sum);
  chain(delayR, gain(s.delay.feedback), delayL);

  const buses = {};
  for (const v of VOICES) {
    const bus = gain(s.mix[v]);
    bus.connect(sum);
    if (s.reverb.sends[v]) chain(bus, gain(s.reverb.sends[v]), reverbIn);
    if (s.delay.sends[v]) chain(bus, gain(s.delay.sends[v]), delayIn);
    buses[v] = bus;
  }

  // every pad note shares one low-pass filter whose cutoff drifts on a slow LFO
  const padFilter = filter('lowpass', s.padCutoff, 0.6);
  padFilter.connect(buses.pad);
  const lfo = ctx.createOscillator();
  lfo.frequency.value = 0.09;
  chain(lfo, gain(s.padCutoff * 0.3), padFilter.frequency);
  lfo.start();

  const hiss = noiseBuffer(ctx);
  let hits = 0;
  let side = 1;

  const osc = (type, frequency, detune, t, dest) => {
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.value = frequency;
    o.detune.value = detune;
    o.connect(dest);
    o.start(t);
    return o;
  };
  const strike = (param, t, peak, attack) => {
    param.setValueAtTime(0, t);
    param.linearRampToValueAtTime(peak, t + attack);
  };
  // Register a voice: stop its sources at `end` and disconnect every node once they have ended.
  const voice = (sources, others, vca, end) => {
    const v = { vca, sources };
    live.add(v);
    for (const src of sources) src.stop(end);
    sources[0].onended = () => {
      live.delete(v);
      for (const n of sources) n.disconnect();
      for (const n of others) n.disconnect();
      vca.disconnect();
    };
  };

  function pad(t, pitch, dur, vel) {
    const vca = gain(0);
    const f = mtof(pitch);
    const sources = [-7, 7, 0].map((cents, i) => osc(i < 2 ? 'sawtooth' : 'triangle', f, cents, t, vca));
    strike(vca.gain, t, 0.05 * vel, Math.min(0.7, dur * 0.4));
    vca.gain.setTargetAtTime(0, t + dur, 0.4);
    vca.connect(padFilter);
    voice(sources, [], vca, t + dur + 2.4);
  }

  function pluck(t, pitch, vel) {
    const f = mtof(pitch);
    const vca = gain(0);
    const lp = filter('lowpass', 1000, 1.5);
    lp.frequency.setValueAtTime(Math.min(f * s.pluckBright, 9000), t);
    lp.frequency.exponentialRampToValueAtTime(Math.max(f * 1.2, 250), t + 0.22);
    const sources = [osc('sawtooth', f, -4, t, lp), osc('triangle', f * 2, 3, t, lp)];
    strike(vca.gain, t, 0.1 * vel, 0.004);
    vca.gain.setTargetAtTime(0, t + 0.004, 0.13);
    side = -side;
    const pan = panner(0.4 * side);
    chain(lp, vca, pan, buses.arp);
    voice(sources, [lp, pan], vca, t + 1);
  }

  // Two-operator FM: a sine whose frequency is modulated by another sine. The modulation depth
  // falls quickly after the attack, which is what makes it read as a struck bell or tine.
  function bell(t, pitch, dur, vel) {
    const f = mtof(pitch);
    const vca = gain(0);
    const carrier = osc('sine', f, 0, t, vca);
    const depth = gain(0);
    const modulator = osc('sine', f * s.bell.ratio, 0, t, depth);
    const index = s.bell.index * Math.sqrt(Math.min(1, 523 / f));
    depth.gain.setValueAtTime(index * f, t);
    depth.gain.setTargetAtTime(index * f * 0.12, t, 0.28);
    depth.connect(carrier.frequency);
    const peak = 0.17 * vel;
    strike(vca.gain, t, peak, 0.005);
    vca.gain.setTargetAtTime(peak * 0.45, t + 0.005, 0.6);
    vca.gain.setTargetAtTime(0, t + dur, s.bell.release / 3);
    vca.connect(buses.lead);
    voice([carrier, modulator], [depth], vca, t + dur + s.bell.release * 2);
  }

  function bass(t, pitch, dur, vel) {
    const f = mtof(pitch);
    const vca = gain(0);
    const lp = filter('lowpass', Math.min(f * 6, 700), 0.7);
    const saw = gain(0.22);
    const sources = [osc('sine', f, 0, t, lp), osc('sawtooth', f, 0, t, saw)];
    saw.connect(lp);
    const peak = 0.34 * vel;
    strike(vca.gain, t, peak, 0.012);
    vca.gain.setTargetAtTime(peak * 0.75, t + 0.012, 0.5);
    vca.gain.setTargetAtTime(0, t + dur, 0.045);
    chain(lp, vca, buses.bass);
    voice(sources, [saw, lp], vca, t + dur + 0.35);
  }

  function kick(t, vel) {
    const vca = gain(0);
    const o = osc('sine', 150, 0, t, vca);
    o.frequency.setValueAtTime(150, t);
    o.frequency.exponentialRampToValueAtTime(46, t + 0.12);
    strike(vca.gain, t, 0.55 * vel, 0.002);
    vca.gain.setTargetAtTime(0, t + 0.03, 0.075);
    vca.connect(buses.drums);
    voice([o], [], vca, t + 0.6);
  }

  function noiseHit(t, vel, band, peak, decay, pan) {
    const src = ctx.createBufferSource();
    src.buffer = hiss;
    const vca = gain(0);
    const p = panner(pan);
    strike(vca.gain, t, peak * vel, 0.001);
    vca.gain.setTargetAtTime(0, t + 0.001, decay);
    chain(src, band, vca, p, buses.drums);
    src.start(t, (hits++ * 0.137) % 0.5);
    voice([src], [band, p], vca, t + decay * 8 + 0.02);
  }

  return {
    analyser,
    /** Schedule one composer event at context time t. */
    play(ev, t, beat) {
      const dur = ev.dur * beat;
      if (ev.voice === 'pad') pad(t, ev.pitch, dur, ev.vel);
      else if (ev.voice === 'bass') bass(t, ev.pitch, dur, ev.vel);
      else if (ev.voice === 'arp') pluck(t, ev.pitch, ev.vel);
      else if (ev.voice === 'lead') bell(t, ev.pitch, dur, ev.vel);
      else if (ev.drum === 'kick') kick(t, ev.vel);
      else if (ev.drum === 'snare') noiseHit(t, ev.vel, filter('bandpass', 1700, 0.8), 0.2, 0.055, -0.15);
      else noiseHit(t, ev.vel, filter('highpass', 7500, 0.7), 0.07, 0.02, 0.3);
    },
    setTempo(beat) {
      const [l, r] = delayTimes(beat);
      delayL.delayTime.setTargetAtTime(l, ctx.currentTime, 0.05);
      delayR.delayTime.setTargetAtTime(r, ctx.currentTime, 0.05);
    },
    setMute(v, muted) {
      buses[v].gain.setTargetAtTime(muted ? 0 : s.mix[v], ctx.currentTime, 0.02);
    },
    /** Move the master level to `level` over roughly `seconds` (0 sets it at once). */
    fade(level, seconds) {
      const t = ctx.currentTime;
      master.gain.cancelScheduledValues(t);
      if (seconds > 0) master.gain.setTargetAtTime(level, t, seconds / 3);
      else master.gain.setValueAtTime(level, t);
    },
    /** Quickly quiet every voice that is sounding or already scheduled. */
    silence() {
      const t = ctx.currentTime;
      for (const v of live) {
        v.vca.gain.cancelScheduledValues(t);
        v.vca.gain.setTargetAtTime(0, t, 0.02);
        for (const src of v.sources) {
          try {
            src.stop(t + 0.2);
          } catch {}
        }
      }
    },
    dispose() {
      this.fade(0, 0.09);
      this.silence();
      try {
        lfo.stop(ctx.currentTime + 0.5);
      } catch {}
      setTimeout(() => analyser.disconnect(), 500);
    },
    get voices() {
      return live.size;
    },
  };
}

/** Render the first `barCount` bars of a piece through the real graph, faster than real time. */
export function renderBars(composer, barCount) {
  const Offline = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
  const spb = 60 / composer.tempo;
  const rate = 44100;
  const ctx = new Offline(2, Math.ceil((barCount * BEATS * spb + 1.5) * rate), rate);
  const synth = createSynth(ctx, composer.mood, spb);
  synth.fade(1, 0);
  for (let b = 0; b < barCount; b++) {
    for (const ev of composer.bar(b).events) synth.play(ev, 0.05 + (b * BEATS + ev.start) * spb, spb);
  }
  return new Promise((resolve, reject) => {
    ctx.oncomplete = (e) => resolve(e.renderedBuffer);
    const pending = ctx.startRendering();
    if (pending && pending.then) pending.then(resolve, reject);
  });
}
