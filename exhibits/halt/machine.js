// Turing machines with two symbols, where a box with no instruction halts, and the referee that decides
// whether one halts. The referee leans on a theorem: among n-state machines started on a blank
// tape, the longest run that ever halts is known (the busy beaver values). A machine still
// running after that many steps will never stop.

/** Longest halting run for n states: Lin and Radó (2, 3), Brady 1983 (4), bbchallenge 2024, verified in Coq (5). */
export const LONGEST = { 2: 6, 3: 21, 4: 107, 5: 47176870 };

export const EMPTY = -1;
export const HALT = -2;

// An instruction is one small integer: ((next * 2 + direction) * 2 + write).
export const encode = (write, right, next) => (next * 2 + (right ? 1 : 0)) * 2 + write;
export const decode = (code) => ({ write: code & 1, right: (code >> 1) & 1, next: code >> 2 });
export const STATE = 'ABCDE';
export const show = (code) => (code === HALT ? 'HALT' : code === EMPTY ? '' : `${code & 1}${(code >> 1) & 1 ? 'R' : 'L'}${STATE[code >> 2]}`);

/** A table from text such as "1RB 1LB  1LA HALT" (cells A0 A1 B0 B1 …; "-" is empty). */
export function parseTable(text) {
  return Int8Array.from(text.trim().split(/\s+/), (t) => (t === 'HALT' ? HALT : t === '-' ? EMPTY : encode(+t[0], t[1] === 'R', STATE.indexOf(t[2]))));
}

/**
 * Run a machine from state A on a blank tape. A box with no instruction halts the machine.
 * → { halted, steps, reason: 'halt' | 'limit' | 'pattern' | 'memory', ones, state, symbol }
 *   'halt'    reached an empty box on step `steps` (in `state`, reading `symbol`)
 *   'limit'   took more than `limit` steps, so by the busy beaver theorem it never halts
 *   'pattern' caught repeating itself while drifting across blank tape, so it never halts
 *   'memory'  wandered further than this device can follow (possible only with 5 states)
 * The pattern check is a shortcut for long runs; the tests confirm it never contradicts the theorem.
 */
export function run(table, limit, { pattern = false, maxTape = 1 << 26 } = {}) {
  let size = 1 << 12;
  let tape = new Uint8Array(size);
  let head = size >> 1;
  let state = 0;
  let steps = 0;
  let lo = head; // leftmost and rightmost cells visited so far
  let hi = head;
  // The pattern check. Each time the head steps onto a never-visited cell (a "record") we note,
  // per side and state: where that was, the K cells behind it, and from then on how far back the
  // head goes. If the same state makes a later record and every cell it read in between looks the
  // same as it did last time, relative to the head, the whole stretch will repeat forever, shifted
  // along the blank tape. Such a machine never halts.
  const K = 64;
  const at = pattern ? [new Int32Array(8).fill(-1), new Int32Array(8).fill(-1)] : null;
  const far = pattern ? [new Int32Array(8), new Int32Array(8)] : null;
  const shot = pattern ? [new Uint8Array(8 * K), new Uint8Array(8 * K)] : null;
  let runMin = head; // extremes of the head since the last record on the right / on the left
  let runMax = head;

  for (;;) {
    const code = table[state * 2 + tape[head]];
    if (code < 0) {
      let ones = 0;
      for (let i = lo; i <= hi; i++) ones += tape[i];
      return { halted: true, steps: steps + 1, reason: 'halt', ones, state, symbol: tape[head] };
    }
    if (steps >= limit) return { halted: false, steps, reason: 'limit', ones: 0 };
    tape[head] = code & 1;
    head += code & 2 ? 1 : -1;
    state = code >> 2;
    steps++;
    if (head < runMin) runMin = head;
    if (head > runMax) runMax = head;
    if (head > hi || head < lo) {
      const side = head > hi ? 1 : 0;
      if (side) hi = head;
      else lo = head;
      if (pattern) {
        const back = side ? -1 : 1; // from the head toward the tape already visited
        const where = at[side];
        const reach = far[side];
        for (let s = 0; s < 8; s++) if (where[s] >= 0) reach[s] = side ? Math.min(reach[s], runMin) : Math.max(reach[s], runMax);
        if (where[state] >= 0) {
          const read = Math.abs(where[state] - reach[state]); // cells behind the old record that were visited since
          if (read <= K) {
            let same = true;
            for (let k = 1; k <= read && same; k++) same = tape[head + back * k] === shot[side][state * K + k - 1];
            if (same) return { halted: false, steps, reason: 'pattern', ones: 0 };
          }
        }
        where[state] = head;
        reach[state] = head;
        for (let k = 1; k <= K; k++) {
          const p = head + back * k;
          shot[side][state * K + k - 1] = p >= 0 && p < size ? tape[p] : 0;
        }
        if (side) runMin = head;
        else runMax = head;
      }
      if (head === 0 || head === size - 1) {
        if (size * 4 > maxTape) return { halted: false, steps, reason: 'memory', ones: 0 };
        const bigger = new Uint8Array(size * 4);
        const shift = (size * 3) >> 1;
        bigger.set(tape, shift);
        tape = bigger;
        size *= 4;
        head += shift;
        lo += shift;
        hi += shift;
        runMin += shift;
        runMax += shift;
        if (pattern)
          for (const side of [0, 1])
            for (let s = 0; s < 8; s++)
              if (at[side][s] >= 0) {
                at[side][s] += shift;
                far[side][s] += shift;
              }
      }
    }
  }
}

/** The first `rows` configurations, for drawing: [{ state, head, tape: Uint8Array(width) }] centred on the start. */
export function trace(table, rows, width) {
  const tape = new Uint8Array(width);
  let head = width >> 1;
  let state = 0;
  const out = [];
  for (let step = 0; step < rows; step++) {
    out.push({ state, head, tape: tape.slice() });
    const code = table[state * 2 + tape[head]];
    if (code < 0) {
      out[out.length - 1].halt = true;
      break;
    }
    tape[head] = code & 1;
    head += code & 2 ? 1 : -1;
    state = code >> 2;
    if (head < 0 || head >= width) break;
  }
  return out;
}
