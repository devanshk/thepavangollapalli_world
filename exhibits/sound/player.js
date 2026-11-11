// Transport and look-ahead scheduler: turns the composer's bars into precisely timed synth calls.
// A short timer wakes up often and schedules everything that falls inside the next half second
// on the AudioContext clock, so timer jitter never reaches the ear.
import { BEATS } from './compose.js';
import { createSynth } from './synth.js';

const HORIZON = 0.5; // seconds scheduled ahead of the audio clock
const INTERVAL = 50; // milliseconds between scheduler wake-ups
const LEAD_IN = 0.15;
const FADE_OUT = 0.15;

const AudioCtor = () => globalThis.AudioContext || globalThis.webkitAudioContext;
export const audioSupported = () => !!AudioCtor();

/**
 * createPlayer(onChange) → transport. Nothing is created until play() is called from a tap.
 * `playing` is the visitor's choice; `active` is whether sound is actually running right now
 * (the page shell may hold a playing piece while it is off screen).
 */
export function createPlayer(onChange) {
  let ctx = null;
  let synth = null;
  let composer = null;
  let playing = false;
  let active = false;
  let timer = 0;
  let sleepTimer = 0;
  let spb = 0.5;
  let anchorTime = 0;
  let anchorBeat = 0;
  let queue = [];
  let queueBar = 0;
  let cursor = 0;
  let volume = 0.7;
  const muted = {};

  const timeOf = (beat) => anchorTime + (beat - anchorBeat) * spb;
  const beatAt = (time) => anchorBeat + (time - anchorTime) / spb;

  function restart() {
    if (synth) synth.dispose();
    synth = createSynth(ctx, composer.mood, spb);
    for (const voice of Object.keys(muted)) if (muted[voice]) synth.setMute(voice, true);
    anchorBeat = 0;
    anchorTime = ctx.currentTime + LEAD_IN;
    queueBar = 0;
    queue = composer.bar(0).events;
    cursor = 0;
  }

  function tick() {
    const now = ctx.currentTime;
    const due = timeOf(queueBar * BEATS + (cursor < queue.length ? queue[cursor].start : BEATS));
    // A starved timer (a throttled tab, a long frame) must not make the music rush to catch up:
    // slide the whole timeline forward instead.
    if (due < now - 0.1) anchorTime += now + 0.05 - due;
    for (;;) {
      if (cursor >= queue.length) {
        if (timeOf((queueBar + 1) * BEATS) > now + HORIZON) break;
        queueBar++;
        queue = composer.bar(queueBar).events;
        cursor = 0;
        continue;
      }
      const ev = queue[cursor];
      const t = timeOf(queueBar * BEATS + ev.start);
      if (t > now + HORIZON) break;
      synth.play(ev, Math.max(t, now + 0.005), spb);
      cursor++;
    }
  }

  function wake(fadeSeconds) {
    clearTimeout(sleepTimer);
    sleepTimer = 0;
    const resumed = ctx.resume();
    if (resumed && resumed.catch) resumed.catch(() => {});
    synth.fade(volume, fadeSeconds);
    active = true;
    if (!timer) timer = setInterval(tick, INTERVAL);
    tick();
  }

  // Fade out first, then suspend the context so a silent piece costs nothing.
  function sleep() {
    clearInterval(timer);
    timer = 0;
    active = false;
    synth.fade(0, FADE_OUT);
    clearTimeout(sleepTimer);
    sleepTimer = setTimeout(() => {
      sleepTimer = 0;
      const suspended = ctx.suspend();
      if (suspended && suspended.then) suspended.then(onChange, () => {});
    }, FADE_OUT * 1000 + 130);
  }

  return {
    /** Swap in a new piece. If sound is running, the old one is faded and the new one starts. */
    load(next, bpm) {
      composer = next;
      spb = 60 / bpm;
      if (!ctx) return;
      restart();
      if (active) {
        synth.fade(volume, 0.4);
        tick();
      }
    },
    /** Must be called from inside a tap handler: this is where the AudioContext is created. */
    play() {
      if (!ctx) {
        const Ctor = AudioCtor();
        ctx = new Ctor();
        restart();
      }
      // On an iPhone this keeps the hardware silent switch from muting the piece.
      try {
        if (navigator.audioSession) navigator.audioSession.type = 'playback';
      } catch {}
      playing = true;
      wake(0.5);
      onChange();
    },
    pause() {
      playing = false;
      if (active) sleep();
      onChange();
    },
    /** Shell lifecycle: resume only if the visitor had pressed Play. */
    start() {
      if (playing && !active && ctx) wake(0.3);
    },
    stop() {
      if (active) sleep();
    },
    setTempo(bpm) {
      if (ctx) {
        const now = ctx.currentTime;
        anchorBeat = beatAt(now);
        anchorTime = now;
      }
      spb = 60 / bpm;
      if (synth) synth.setTempo(spb);
    },
    setVolume(level) {
      volume = level;
      if (synth && active) synth.fade(volume, 0.1);
    },
    setMute(voice, on) {
      muted[voice] = on;
      if (synth) synth.setMute(voice, on);
    },
    /** Position of the sound now leaving the speakers, in beats from the start of the piece. */
    beat() {
      if (!ctx) return 0;
      return beatAt(ctx.currentTime - (ctx.outputLatency || ctx.baseLatency || 0));
    },
    get playing() {
      return playing;
    },
    get active() {
      return active;
    },
    get analyser() {
      return synth ? synth.analyser : null;
    },
    get sampleRate() {
      return ctx ? ctx.sampleRate : 44100;
    },
    get voices() {
      return synth ? synth.voices : 0;
    },
    destroy() {
      clearInterval(timer);
      clearTimeout(sleepTimer);
      timer = 0;
      active = false;
      playing = false;
      if (!ctx) return;
      synth.dispose();
      const closed = ctx.close();
      if (closed && closed.catch) closed.catch(() => {});
    },
  };
}
