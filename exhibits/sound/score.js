// The scrolling score: a piano roll of upcoming and sounding notes, a chord line above it,
// a drum lane and a live spectrum below. Draws one frame from a snapshot of the state.
import { cssVar } from '../../assets/js/kit.js';
import { BEATS } from './compose.js';

const LOW = 28;
const HIGH = 86;
const HEAD = 40;
const SPECTRUM = 46;
const DRUM_LANE = 22;
const VOICE_TOKENS = { pad: '--st-c5', bass: '--st-c1', arp: '--st-c3', lead: '--st-c2', drums: '--st-c6' };
const PITCHED = ['pad', 'bass', 'arp', 'lead'];
const DRUM_ROW = { hat: 0, snare: 1, kick: 2 };
const SPECTRUM_LOW = 40;
const SPECTRUM_HIGH = 14000;

export function createScore(canvas, root) {
  const ctx = canvas.getContext('2d');
  const token = (name) => cssVar(root, name);
  const color = {
    bg: token('--st-bg'),
    line: token('--st-line'),
    text: token('--st-text'),
    muted: token('--st-muted'),
    accent: token('--st-accent'),
  };
  const voiceColor = {};
  for (const v of Object.keys(VOICE_TOKENS)) voiceColor[v] = token(VOICE_TOKENS[v]);
  const fontUi = token('--font-ui') || 'sans-serif';
  const fontMono = token('--font-mono') || 'monospace';
  const bins = new Uint8Array(1024);

  function drawGrid(g) {
    ctx.strokeStyle = color.line;
    ctx.lineWidth = 1;
    ctx.font = `10px ${fontMono}`;
    ctx.fillStyle = color.muted;
    ctx.textBaseline = 'middle';
    for (let pitch = 36; pitch <= HIGH; pitch += 12) {
      const y = Math.round(g.yOf(pitch) + g.rowH) + 0.5;
      ctx.globalAlpha = 0.55;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(g.w, y);
      ctx.stroke();
      ctx.globalAlpha = 0.8;
      ctx.fillText(`C${pitch / 12 - 1}`, 5, y - 7);
    }
    for (let beat = g.firstBar * BEATS; beat <= (g.lastBar + 1) * BEATS; beat++) {
      if (beat < 0) continue;
      const x = Math.round(g.xOf(beat)) + 0.5;
      const barLine = beat % BEATS === 0;
      ctx.globalAlpha = barLine ? 1 : 0.35;
      ctx.beginPath();
      ctx.moveTo(x, barLine ? 0 : HEAD);
      ctx.lineTo(x, g.laneBottom);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    ctx.beginPath();
    ctx.moveTo(0, HEAD - 0.5);
    ctx.lineTo(g.w, HEAD - 0.5);
    ctx.stroke();
  }

  function drawHeader(g, bar) {
    const x = g.xOf(bar.index * BEATS) + 7;
    const room = g.barW - 12;
    const current = bar.index === g.currentBar;
    ctx.globalAlpha = bar.index < g.currentBar ? 0.45 : 1;
    ctx.textBaseline = 'alphabetic';
    ctx.font = `10px ${fontMono}`;
    ctx.fillStyle = color.muted;
    const number = String(bar.index + 1);
    ctx.fillText(number, x, 14);
    if (bar.sectionBar === 0) {
      ctx.fillStyle = color.accent;
      ctx.font = `600 11px ${fontUi}`;
      ctx.fillText(bar.section, x + ctx.measureText(number).width + 10, 14);
    }
    ctx.font = `600 13px ${fontUi}`;
    ctx.fillStyle = current ? color.accent : color.text;
    ctx.fillText(bar.chord.name, x, 32, room);
    const nameW = Math.min(room, ctx.measureText(bar.chord.name).width);
    ctx.font = `11px ${fontUi}`;
    if (nameW + 8 + ctx.measureText(bar.chord.roman).width <= room) {
      ctx.fillStyle = color.muted;
      ctx.fillText(bar.chord.roman, x + nameW + 8, 32);
    }
    ctx.globalAlpha = 1;
  }

  function drawNotes(g, bar, voice, mutedVoice) {
    const origin = bar.index * BEATS;
    const soft = voice === 'pad';
    const h = Math.max(3, g.rowH - (soft ? 0 : 1));
    ctx.fillStyle = voiceColor[voice];
    for (const ev of bar.events) {
      if (ev.voice !== voice) continue;
      const start = origin + ev.start;
      const end = start + ev.dur;
      const x = g.xOf(start);
      const w = Math.max(2, ev.dur * g.pxPerBeat - 1.5);
      const y = g.yOf(ev.pitch);
      const sounding = g.beat >= start && g.beat < end;
      let alpha = soft ? 0.3 : 0.85;
      if (sounding) alpha = soft ? 0.62 : 1;
      else if (end <= g.beat) alpha = soft ? 0.13 : 0.28;
      if (mutedVoice) alpha *= 0.3;
      if (sounding && !soft && !mutedVoice) {
        ctx.globalAlpha = 0.22;
        ctx.fillRect(x - 3, y - 3, w + 6, h + 6);
      }
      ctx.globalAlpha = alpha;
      ctx.fillRect(x, y, w, h);
    }
  }

  function drawDrums(g, bar, mutedVoice) {
    const rowH = (DRUM_LANE - 4) / 3;
    ctx.fillStyle = voiceColor.drums;
    for (const ev of bar.events) {
      if (ev.voice !== 'drums') continue;
      const beat = bar.index * BEATS + ev.start;
      const hit = g.beat >= beat && g.beat < beat + 0.25;
      ctx.globalAlpha = (beat + 0.25 <= g.beat ? 0.28 : hit ? 1 : 0.8) * (mutedVoice ? 0.3 : 1);
      const wide = ev.drum === 'kick' ? 6 : ev.drum === 'snare' ? 4 : 2.5;
      ctx.fillRect(g.xOf(beat), g.laneTop + 2 + DRUM_ROW[ev.drum] * rowH, wide, rowH - 1);
    }
  }

  function drawPlayhead(g) {
    ctx.globalAlpha = 1;
    ctx.fillStyle = color.accent;
    ctx.fillRect(g.headX - 0.75, HEAD, 1.5, g.laneBottom - HEAD);
    ctx.beginPath();
    ctx.moveTo(g.headX - 5, HEAD - 7);
    ctx.lineTo(g.headX + 5, HEAD - 7);
    ctx.lineTo(g.headX, HEAD);
    ctx.fill();
  }

  // Log-spaced bars from 40 Hz to 14 kHz; each bar shows the loudest FFT bin it covers.
  function drawSpectrum(g, analyser, sampleRate) {
    const top = g.h - SPECTRUM;
    const count = Math.max(24, Math.floor(g.w / 7));
    const step = g.w / count;
    const hzPerBin = sampleRate / 2 / bins.length;
    if (analyser) analyser.getByteFrequencyData(bins);
    ctx.fillStyle = color.accent;
    for (let i = 0; i < count; i++) {
      let level = 0;
      if (analyser) {
        const lo = SPECTRUM_LOW * Math.pow(SPECTRUM_HIGH / SPECTRUM_LOW, i / count);
        const hi = SPECTRUM_LOW * Math.pow(SPECTRUM_HIGH / SPECTRUM_LOW, (i + 1) / count);
        const first = Math.min(bins.length - 1, Math.floor(lo / hzPerBin));
        const last = Math.min(bins.length - 1, Math.max(first, Math.floor(hi / hzPerBin)));
        for (let b = first; b <= last; b++) if (bins[b] > level) level = bins[b];
        level /= 255;
      }
      const barH = 2 + level * (SPECTRUM - 14);
      ctx.globalAlpha = 0.3 + 0.7 * level;
      ctx.fillRect(i * step + 1, g.h - 4 - barH, Math.max(1, step - 2), barH);
    }
    ctx.globalAlpha = 1;
    ctx.font = `10px ${fontMono}`;
    ctx.fillStyle = color.muted;
    ctx.textBaseline = 'alphabetic';
    ctx.fillText('spectrum · 40 Hz to 14 kHz', 6, top + 11);
  }

  /**
   * draw(size, { composer, beat, analyser, sampleRate, mutes })
   * size is the kit view's size; analyser may be null (nothing sounding).
   */
  function draw(size, state) {
    const { w, h, dpr } = size;
    const hasDrums = !!state.composer.mood.drums;
    const narrow = w < 520;
    const barsVisible = narrow ? 3 : w < 820 ? 4 : 6;
    const pxPerBeat = w / (barsVisible * BEATS);
    const headX = Math.round(w * (narrow ? 0.18 : 0.14));
    const laneBottom = h - SPECTRUM - 6;
    const laneTop = laneBottom - (hasDrums ? DRUM_LANE : 0);
    const rollBottom = laneTop - 4;
    const rowH = (rollBottom - HEAD - 6) / (HIGH - LOW + 1);
    const beat = state.beat;
    const g = {
      w,
      h,
      beat,
      pxPerBeat,
      headX,
      laneTop,
      laneBottom,
      rowH,
      barW: pxPerBeat * BEATS,
      currentBar: Math.max(0, Math.floor(beat / BEATS)),
      firstBar: Math.floor((beat - headX / pxPerBeat) / BEATS),
      lastBar: Math.floor((beat + (w - headX) / pxPerBeat) / BEATS),
      xOf: (b) => headX + (b - beat) * pxPerBeat,
      yOf: (pitch) => rollBottom - (pitch - LOW + 1) * rowH,
    };

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.globalAlpha = 1;
    ctx.fillStyle = color.bg;
    ctx.fillRect(0, 0, w, h);
    drawGrid(g);
    for (const voice of PITCHED) {
      for (let n = g.firstBar; n <= g.lastBar; n++) {
        const bar = state.composer.bar(n);
        if (bar) drawNotes(g, bar, voice, !!state.mutes[voice]);
      }
    }
    for (let n = g.firstBar; n <= g.lastBar; n++) {
      const bar = state.composer.bar(n);
      if (!bar) continue;
      if (hasDrums) drawDrums(g, bar, !!state.mutes.drums);
      drawHeader(g, bar);
    }
    drawPlayhead(g);
    drawSpectrum(g, state.analyser, state.sampleRate);
  }

  return { draw };
}
