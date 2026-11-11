// The composer: (seed, mood) → an endless, deterministic stream of bars.
// Pure: no DOM, no audio, no clock. Time is measured in beats from the start of each bar.
import { rng, hashString, clamp } from '../../assets/js/kit.js';
import { mod, euclid, rotate, makeKey, buildChord, idxToPitch, inScale, nearestIdx, nearestChordIdx, pitchNear } from './theory.js';
import { MOODS } from './moods.js';

export const BEATS = 4;
export const STEPS = 16;
export const SECTION_BARS = 8;
export const FORM = ['A', 'A′', 'B', 'A'];
export const RANGES = { bass: [28, 47], pad: [48, 72], arp: [52, 81], lead: [60, 84] };

const KEEP_BARS = 48;
const ARP_ORDERS = [[0, 1, 2, 3], [0, 2, 1, 3], [3, 1, 2, 0], [0, 1, 2, 3, 2, 1], [0, 3, 1, 2]];
const GATE = { pad: 1, bass: 0.9, arp: 0.8, lead: 0.85, drums: 0.4 };
const JITTER = { pad: 0, bass: 0, arp: 0.006, lead: 0.007, drums: 0.003 };
const MAX_JITTER = 0.016;
const LAYER_LEVEL = [0.85, 0.95, 0.8, 1];

function pickNot(r, list, avoid) {
  const options = list.filter((d) => d !== avoid);
  return r.pick(options.length ? options : list);
}

/* ───────────── harmony: a small functional grammar, eight bars per section ───────────── */

// Tonic, departure, pre-dominant, half cadence | tonic area, pre-dominant, dominant, tonic.
function progressionA(r, m) {
  const p = [0];
  p.push(pickNot(r, m.pre.concat(m.tonic.slice(1)), 0));
  p.push(pickNot(r, m.pre, p[1]));
  p.push(pickNot(r, m.dom, p[2]));
  p.push(r() < 0.6 ? 0 : pickNot(r, m.tonic.slice(1), p[3]));
  p.push(pickNot(r, m.pre, p[4]));
  p.push(r() < 0.7 && m.dom[0] !== p[5] ? m.dom[0] : pickNot(r, m.dom, p[5]));
  p.push(0);
  return p;
}

// The contrasting section starts away from the tonic and only finds it again in its last bar.
function progressionB(r, m) {
  const p = [m.pre[0]];
  p.push(pickNot(r, m.tonic.slice(1).concat(m.dom), p[0]));
  p.push(pickNot(r, m.pre, p[1]));
  p.push(pickNot(r, m.dom, p[2]));
  p.push(pickNot(r, m.tonic.slice(1).concat(m.pre), p[3]));
  p.push(pickNot(r, m.pre.concat(m.dom.slice(1)), p[4]));
  p.push(m.dom[0] !== p[5] ? m.dom[0] : m.dom[1]);
  p.push(0);
  return p;
}

function varyProgression(p, r, m) {
  p[1] = pickNot(r, m.pre.concat(m.tonic.slice(1)), p[2]);
  p[5] = pickNot(r, m.pre, p[6]);
}

/* ───────────── pad: four voices, each new chord chosen for the least motion ───────────── */

function openingVoicing(chord) {
  const notes = [pitchNear(chord.root, 53, 48, 59)];
  for (let i = 1; i < 4; i++) {
    const pc = chord.pcs[i % chord.pcs.length];
    let p = notes[i - 1] + 1;
    while (mod(p, 12) !== pc) p++;
    notes.push(p);
  }
  return notes;
}

function leadVoicing(prev, chord) {
  const [lo, hi] = RANGES.pad;
  const full = (1 << chord.pcs.length) - 1;
  const options = prev.map((p) => {
    const list = [];
    for (let q = Math.max(lo, p - 7); q <= Math.min(hi, p + 7); q++) {
      const i = chord.pcs.indexOf(mod(q, 12));
      if (i >= 0) list.push({ q, bit: 1 << i, move: Math.abs(q - p) });
    }
    return list;
  });
  let best = null;
  let bestCost = Infinity;
  for (const a of options[0]) {
    for (const b of options[1]) {
      if (b.q <= a.q) continue;
      for (const c of options[2]) {
        if (c.q <= b.q) continue;
        for (const d of options[3]) {
          if (d.q <= c.q || (a.bit | b.bit | c.bit | d.bit) !== full) continue;
          const span = d.q - a.q;
          let cost = a.move + b.move + c.move + d.move;
          cost += 0.35 * Math.abs((a.q + b.q + c.q + d.q) / 4 - 59);
          if (span < 7) cost += 3;
          if (span > 17) cost += 0.5 * (span - 17);
          if (b.q - a.q < 3) cost += 2; // seconds at the bottom of a chord sound muddy
          if (cost < bestCost) {
            bestCost = cost;
            best = [a.q, b.q, c.q, d.q];
          }
        }
      }
    }
  }
  return best || openingVoicing(chord);
}

/* ───────────── bass: single notes below C3 ───────────── */

const bassRoot = (chord) => pitchNear(chord.root, 36, 31, 42);

function bassBar(r, piece, chords, b) {
  const chord = chords[b];
  const root = bassRoot(chord);
  const fifth = pitchNear(chord.pcs[2], root + 7 <= RANGES.bass[1] ? root + 7 : root - 5, RANGES.bass[0], RANGES.bass[1]);
  const octave = root + 12 <= RANGES.bass[1] ? root + 12 : root;
  // Random draws happen before any branching so a repeated section stays aligned.
  const x = r();
  const y = r();
  if (b === SECTION_BARS - 1) return [{ step: 0, len: 12, pitch: root, vel: 0.8 }];
  const nextRoot = bassRoot(chords[b + 1]);
  const neighbour = idxToPitch(piece.key, nearestIdx(piece.key, nextRoot) + (y < 0.5 ? -1 : 1));
  switch (piece.mood.bass) {
    case 'long':
      return b % 4 === 2 && x < 0.6
        ? [{ step: 0, len: 8, pitch: root, vel: 0.8 }, { step: 8, len: 6, pitch: fifth, vel: 0.68 }]
        : [{ step: 0, len: 14, pitch: root, vel: 0.8 }];
    case 'slow': {
      const notes = [{ step: 0, len: 12, pitch: root, vel: 0.78 }];
      if (x < 0.3) notes.push({ step: 12, len: 3, pitch: fifth, vel: 0.55 });
      return notes;
    }
    case 'tresillo': {
      const notes = [
        { step: 0, len: 5, pitch: root, vel: 0.85 },
        { step: 6, len: 5, pitch: y < 0.5 ? fifth : octave, vel: 0.7 },
        { step: 12, len: 2, pitch: root, vel: 0.72 },
      ];
      if (x < 0.25) {
        // a walking-bass approach from a semitone below the next root, chromatic if need be
        const pitch = nextRoot - 1;
        notes.push({ step: 14, len: 2, pitch, vel: 0.62, chromatic: !inScale(piece.key, pitch) });
      } else if (x < 0.55) notes.push({ step: 14, len: 2, pitch: neighbour, vel: 0.62 });
      return notes;
    }
    default: {
      const notes = [];
      for (let i = 0; i < 8; i++) {
        if (!piece.bassMask[i]) continue;
        let pitch = i % 2 ? octave : root;
        if (i === 4 && x < 0.3) pitch = fifth;
        if (i === 7 && y < 0.4) pitch = neighbour;
        notes.push({ step: i * 2, len: 2, pitch, vel: i % 2 ? 0.66 : 0.82 });
      }
      return notes;
    }
  }
}

/* ───────────── accompaniment and percussion on Euclidean grids ───────────── */

function gridMask([k, n, rot = 0]) {
  const mask = new Array(STEPS).fill(0);
  rotate(euclid(k, n), rot).forEach((on, i) => {
    mask[(i * STEPS) / n] = on;
  });
  return mask;
}

function arpBar(piece, pad, b, level) {
  const pool = [...new Set(pad.map((p) => (p < 55 ? p + 12 : p)))].sort((x, y) => x - y);
  if (pool[0] + 12 <= 79) pool.push(pool[0] + 12);
  const notes = [];
  let k = 0;
  for (let s = 0; s < STEPS; s++) {
    if (!piece.arpMask[s]) continue;
    if (b === SECTION_BARS - 1 && s >= 8) break; // leave air after the cadence
    const pitch = pool[piece.arpOrder[k++ % piece.arpOrder.length] % pool.length];
    notes.push({ step: s, len: Math.min(2, STEPS - s), pitch, vel: (s % 4 === 0 ? 0.62 : 0.5) * level });
  }
  return notes;
}

function drumBar(r, piece, slot, b, level) {
  const d = piece.mood.drums;
  if (!d) return [];
  const last = b === SECTION_BARS - 1;
  const notes = [];
  for (let s = 0; s < STEPS; s++) {
    if (d.kick[slot] && piece.kickMask[s] && !(last && s > 8)) notes.push({ step: s, len: 1, drum: 'kick', vel: s === 0 ? 0.95 : 0.8 });
    if (d.snare[slot] && (s === 4 || s === 12)) notes.push({ step: s, len: 1, drum: 'snare', vel: 0.7 * level });
    if (d.hat[slot] && piece.hatMask[s]) notes.push({ step: s, len: 1, drum: 'hat', vel: (s % 4 === 2 ? 0.75 : 0.5) * level });
  }
  if (last && d.snare[slot] && r() < 0.6) notes.push({ step: 14, len: 1, drum: 'snare', vel: 0.5 * level });
  return notes;
}

/* ───────────── melody: one short motif, repeated, transposed, inverted, answered ───────────── */

// A one-bar cell: a Euclidean rhythm on the eighth-note grid plus a contour in scale steps.
function makeMotif(r, mood) {
  const pattern = euclid(r.pick(mood.motifNotes), 8);
  const onsets = [];
  pattern.forEach((on, i) => on && onsets.push(i));
  const downbeat = r.pick(onsets);
  const steps = onsets.map((o) => mod(o - downbeat, 8) * 2).sort((a, b) => a - b);
  let level = 0;
  return steps.map((step, j) => {
    const last = j === steps.length - 1;
    if (j > 0) level = clamp(level + r.pick([-2, -1, -1, 1, 1, 2]), -3, 3);
    return { step, len: last ? Math.min(STEPS - step, 4) : Math.min(steps[j + 1] - step, 6), rel: level };
  });
}

function retrograde(motif) {
  const rels = motif.map((n) => n.rel).reverse();
  return motif.map((n, i) => ({ step: n.step, len: n.len, rel: clamp(rels[i] - rels[0], -4, 4) }));
}

function melodySection(r, sec) {
  const bars = [];
  const lift = [0, r.pick([1, 2]), r.pick([2, 3, -1])];
  const invert = r() < 0.5;
  let last = sec.centre;
  for (let b = 0; b < SECTION_BARS; b++) {
    const chord = sec.chords[b];
    const inPhrase = b % 4;
    const rest = r() < sec.restProb;
    if (inPhrase === 3) {
      // every phrase ends on one long chord tone, then silence
      const target = b < SECTION_BARS - 1 ? chord : { classes: sec.endOnTonic ? [0] : [2, 4] };
      last = nearestChordIdx(target, last, -1);
      bars.push([{ step: 0, len: b === SECTION_BARS - 1 ? 12 : 8, idx: last }]);
      continue;
    }
    if (inPhrase === 1 && rest) {
      bars.push([]);
      continue;
    }
    const anchor = nearestChordIdx(chord, sec.centre + lift[inPhrase] + (b >= 4 ? 1 : 0));
    const flip = inPhrase === 2 && invert ? -1 : 1;
    const cell = sec.motif.map((n) => {
      const idx = anchor + flip * n.rel;
      // strong beats (1 and 3) always land on a chord tone
      return { step: n.step, len: n.len, idx: n.step % 8 === 0 ? nearestChordIdx(chord, idx) : idx };
    });
    bars.push(cell);
    last = cell[cell.length - 1].idx;
  }
  return bars;
}

// The A′ treatment: split some long notes with a neighbour tone and add a pickup into the answer.
function ornament(bars, r) {
  for (const b of [0, 2, 4, 6]) {
    const cell = bars[b];
    for (let i = cell.length - 1; i >= 0; i--) {
      const n = cell[i];
      const half = n.len >> 1;
      const split = r() < 0.5;
      const up = r() < 0.5;
      if (!split || n.len < 4 || (n.step + half) % 8 === 0) continue;
      cell.splice(i, 1, { step: n.step, len: half, idx: n.idx }, { step: n.step + half, len: n.len - half, idx: n.idx + (up ? 1 : -1) });
    }
  }
  if (bars[4].length) bars[3].push({ step: 14, len: 2, idx: bars[4][0].idx - 1 });
}

function leadPitch(key, idx) {
  let p = idxToPitch(key, idx);
  while (p > RANGES.lead[1]) p -= 12;
  while (p < RANGES.lead[0]) p += 12;
  return p;
}

/* ───────────── performance: grid notes → timed, gently humanised events ───────────── */

function humanise(raw, r) {
  const events = raw.map((n) => {
    const jitter = JITTER[n.voice] ? clamp(r.gauss() * JITTER[n.voice], -MAX_JITTER, MAX_JITTER) : 0;
    const ev = {
      voice: n.voice,
      step: n.step,
      start: Math.max(0, n.step / 4 + jitter),
      dur: (n.len / 4) * GATE[n.voice],
      vel: clamp(n.vel + (n.voice === 'pad' ? 0 : r.range(-0.05, 0.05)), 0.05, 1),
    };
    if (n.pitch !== undefined) ev.pitch = n.pitch;
    if (n.drum) ev.drum = n.drum;
    if (n.chromatic) ev.chromatic = true;
    return ev;
  });
  return events.sort((a, b) => a.start - b.start);
}

/**
 * createComposer('amber-tide', 'drift') → { key, tempo, mood, bar(n) }
 * bar(n) → { index, cycle, slot, section, sectionBar, chord, pad, events } where each event is
 * { voice, step, start, dur, vel, pitch? , drum?, chromatic? } with start and dur in beats.
 * Bars are composed in order, a section at a time; only the most recent ones are kept.
 */
export function createComposer(seed, moodId) {
  const mood = MOODS[moodId];
  const stream = (label) => rng(hashString(`${seed}|${moodId}|${label}`));
  const r0 = stream('piece');
  const key = makeKey(r0.pick(mood.tonics), mood.mode);
  const tempo = Math.round(r0.range(mood.tempo[0], mood.tempo[1]));
  const motif = makeMotif(stream('motif'), mood);
  const piece = {
    mood,
    key,
    arpOrder: r0.pick(ARP_ORDERS),
    arpMask: gridMask(r0.pick(mood.arp.patterns).concat(r0.int(8)).slice(0, 3)),
    bassMask: euclid(r0.pick([5, 6, 8]), 8),
    kickMask: mood.drums ? gridMask(r0.pick(mood.drums.kicks)) : null,
    hatMask: mood.drums ? gridMask(r0.pick(mood.drums.hats)) : null,
  };
  const motifs = { A: motif, B: retrograde(motif) };
  const centre = nearestIdx(key, mood.leadCentre);
  const chordCache = new Map();
  const chordFor = (degree) => {
    if (!chordCache.has(degree)) chordCache.set(degree, buildChord(key, degree, mood.sevenths));
    return chordCache.get(degree);
  };

  const bars = new Map();
  let generated = 0;
  let voicing = null;

  function composeSection() {
    const sectionIndex = generated / SECTION_BARS;
    const cycle = Math.floor(sectionIndex / FORM.length);
    const slot = sectionIndex % FORM.length;
    const kind = slot === 2 ? 'B' : 'A';
    // The theme streams depend only on the cycle and the section type, so A′ and the
    // returning A are built from exactly the same choices as the first A.
    const theme = (part) => stream(`${cycle}|${kind}|${part}`);
    const degrees = kind === 'A' ? progressionA(theme('chords'), key.mode) : progressionB(theme('chords'), key.mode);
    if (slot === 1) varyProgression(degrees, stream(`${cycle}|vary-chords`), key.mode);
    const chords = degrees.map(chordFor);
    const melody = melodySection(theme('melody'), {
      chords,
      motif: motifs[kind],
      centre: centre + (kind === 'B' ? 2 : 0),
      restProb: mood.restProb,
      endOnTonic: kind === 'A',
    });
    if (slot === 1) ornament(melody, stream(`${cycle}|vary-melody`));
    const bassRng = theme('bass');
    const drumRng = stream(`drums|${sectionIndex}`);
    const human = stream(`human|${sectionIndex}`);
    const level = LAYER_LEVEL[slot];

    for (let b = 0; b < SECTION_BARS; b++) {
      const chord = chords[b];
      voicing = voicing ? leadVoicing(voicing, chord) : openingVoicing(chord);
      const raw = voicing.map((pitch) => ({ voice: 'pad', step: 0, len: STEPS, pitch, vel: 0.7 }));
      for (const n of bassBar(bassRng, piece, chords, b)) raw.push({ voice: 'bass', ...n });
      if (mood.arp.sections[slot]) for (const n of arpBar(piece, voicing, b, level)) raw.push({ voice: 'arp', ...n });
      for (const n of melody[b]) {
        const accent = (n.step % 8 === 0 ? 0.08 : 0) + (b % 4 === 2 ? 0.06 : 0);
        raw.push({ voice: 'lead', step: n.step, len: n.len, pitch: leadPitch(key, n.idx), vel: 0.64 + accent });
      }
      for (const n of drumBar(drumRng, piece, slot, b, level)) raw.push({ voice: 'drums', ...n });
      bars.set(generated, {
        index: generated,
        cycle,
        slot,
        section: FORM[slot],
        sectionBar: b,
        chord,
        pad: voicing.slice(),
        events: humanise(raw, human),
      });
      generated++;
    }
    for (const k of bars.keys()) {
      if (k >= generated - KEEP_BARS) break;
      bars.delete(k);
    }
  }

  return {
    seed,
    mood,
    key,
    tempo,
    bar(n) {
      if (n < 0) return null;
      while (generated <= n) composeSection();
      return bars.get(n) || null;
    },
  };
}
