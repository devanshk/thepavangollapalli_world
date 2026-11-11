// Pitch, scale, chord and rhythm arithmetic. Pure functions: no DOM, no audio.

export const mod = (n, m) => ((n % m) + m) % m;
export const mtof = (midi) => 440 * Math.pow(2, (midi - 69) / 12);

// Each mode lists its scale steps and the scale degrees that serve the three harmonic
// functions (tonic, pre-dominant, dominant). The degree that carries the diminished triad
// is left out of every list, so the grammar never lands on it.
export const MODES = {
  lydian: { name: 'Lydian', steps: [0, 2, 4, 6, 7, 9, 11], tonic: [0, 5, 2], pre: [1, 5], dom: [4, 1, 6] },
  dorian: { name: 'Dorian', steps: [0, 2, 3, 5, 7, 9, 10], tonic: [0, 2], pre: [3, 1], dom: [6, 4] },
  aeolian: { name: 'Aeolian', steps: [0, 2, 3, 5, 7, 8, 10], tonic: [0, 2, 5], pre: [3, 5], dom: [6, 4] },
  phrygian: { name: 'Phrygian', steps: [0, 1, 3, 5, 7, 8, 10], tonic: [0, 2], pre: [3, 5], dom: [1, 6] },
};

const LETTERS = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];
const LETTER_PC = [0, 2, 4, 5, 7, 9, 11];
const NUMERALS = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII'];
const ACCIDENTALS = { '-2': '♭♭', '-1': '♭', 0: '', 1: '♯', 2: '♯♯' };
const signed = (semitones) => mod(semitones + 6, 12) - 6;

/**
 * Bjorklund's algorithm: k onsets spread as evenly as possible over n steps.
 * euclid(3, 8) → [1,0,0,1,0,0,1,0]
 */
export function euclid(k, n) {
  if (k <= 0) return new Array(n).fill(0);
  if (k >= n) return new Array(n).fill(1);
  let head = Array.from({ length: k }, () => [1]);
  let tail = Array.from({ length: n - k }, () => [0]);
  while (tail.length > 1) {
    const m = Math.min(head.length, tail.length);
    const merged = [];
    for (let i = 0; i < m; i++) merged.push(head[i].concat(tail[i]));
    const restHead = head.slice(m);
    const restTail = tail.slice(m);
    head = merged;
    tail = restHead.length ? restHead : restTail;
  }
  return head.concat(tail).flat();
}

export const rotate = (pattern, by) => pattern.map((_, i) => pattern[mod(i + by, pattern.length)]);

/**
 * Spell a seven-note scale so that every letter is used exactly once, choosing the tonic
 * spelling (C♯ or D♭, say) that needs the fewest accidentals.
 */
export function spellScale(tonic, steps) {
  let best = null;
  for (let letter = 0; letter < 7; letter++) {
    if (Math.abs(signed(tonic - LETTER_PC[letter])) > 1) continue;
    const names = [];
    let cost = 0;
    for (let i = 0; i < 7; i++) {
      const l = (letter + i) % 7;
      const acc = signed(tonic + steps[i] - LETTER_PC[l]);
      cost += Math.abs(acc) > 1 ? 8 : Math.abs(acc);
      names.push(LETTERS[l] + (ACCIDENTALS[acc] === undefined ? '?' : ACCIDENTALS[acc]));
    }
    if (!best || cost < best.cost) best = { cost, names };
  }
  return best.names;
}

/** A key is a tonic pitch class plus a mode. Scale indices count scale steps upward from MIDI `tonic`. */
export function makeKey(tonic, modeId) {
  const mode = MODES[modeId];
  const names = spellScale(tonic, mode.steps);
  return { tonic, modeId, mode, steps: mode.steps, names, label: `${names[0]} ${mode.name}` };
}

export const idxToPitch = (key, idx) => key.tonic + 12 * Math.floor(idx / 7) + key.steps[mod(idx, 7)];
export const inScale = (key, pitch) => key.steps.includes(mod(pitch - key.tonic, 12));

/** The scale index whose pitch is closest to `pitch`. */
export function nearestIdx(key, pitch) {
  const guess = Math.round(((pitch - key.tonic) * 7) / 12);
  let best = guess;
  for (let i = guess - 2; i <= guess + 2; i++) {
    if (Math.abs(idxToPitch(key, i) - pitch) < Math.abs(idxToPitch(key, best) - pitch)) best = i;
  }
  return best;
}

/** Diatonic triad (or seventh chord) on a scale degree, with its name and Roman numeral. */
export function buildChord(key, degree, seventh) {
  const classes = (seventh ? [0, 2, 4, 6] : [0, 2, 4]).map((t) => mod(degree + t, 7));
  const pcs = classes.map((c) => mod(key.tonic + key.steps[c], 12));
  const intervals = pcs.map((pc) => mod(pc - pcs[0], 12));
  const minor = intervals[1] === 3;
  const diminished = minor && intervals[2] === 6;
  const quality = diminished ? '°' : minor ? 'm' : '';
  let ext = '';
  if (seventh) ext = intervals[3] === 11 ? (minor ? '(maj7)' : 'maj7') : '7';
  // Roman numerals are written relative to the major scale: ♭VII, ♯iv° and so on.
  const shift = key.steps[degree] - LETTER_PC[degree];
  const numeral = minor ? NUMERALS[degree].toLowerCase() : NUMERALS[degree];
  return {
    degree,
    classes,
    pcs,
    root: pcs[0],
    name: key.names[degree] + quality + ext,
    roman: (shift < 0 ? '♭' : shift > 0 ? '♯' : '') + numeral + (diminished ? '°' : '') + ext,
  };
}

/** Nearest scale index to `idx` that is a tone of the chord; ties go in the `prefer` direction. */
export function nearestChordIdx(chord, idx, prefer = 1) {
  for (let d = 0; d < 7; d++) {
    if (chord.classes.includes(mod(idx + prefer * d, 7))) return idx + prefer * d;
    if (chord.classes.includes(mod(idx - prefer * d, 7))) return idx - prefer * d;
  }
  return idx;
}

/** The pitch with pitch class `pc` inside [lo, hi] that lies closest to `target`. */
export function pitchNear(pc, target, lo, hi) {
  let best = -1;
  for (let p = lo; p <= hi; p++) {
    if (mod(p, 12) !== pc) continue;
    if (best < 0 || Math.abs(p - target) < Math.abs(best - target)) best = p;
  }
  return best;
}
