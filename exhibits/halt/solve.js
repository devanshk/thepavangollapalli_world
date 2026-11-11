// Perfect play, by trying everything. A position is a partly filled table; the Halter wins it if
// some move of theirs leads to a position they win, or every move of the Runner's does.
import { EMPTY, LONGEST, run } from './machine.js';
import { options, start } from './game.js';

/**
 * createSolver(n, order) → solver for the game on n states with turn order `order` (e.g. 'HRH').
 *   halterWins(table)   with perfect play from this position, does the machine halt?
 *   best(table)         → { cell, code, winning, replies }: a winning move if there is one,
 *                         otherwise the move that leaves the opponent the fewest winning replies
 *   opening()           → { halterWins, winning, total }: the verdict, and how many first moves win
 *   positions           how many positions have been settled so far
 */
export function createSolver(n, order) {
  const cells = 2 * n;
  const moves = order.length;
  const opts = Array.from({ length: n }, (_, s) => options(n, s));
  const base = opts[0].length + 1;
  const pow = Array.from({ length: cells }, (_, i) => base ** Math.max(0, i - 1));
  const work = new Int8Array(cells);
  const memo = new Map();
  const solver = { positions: 0 };

  const keyOf = (table) => {
    let key = 0;
    for (let c = 1; c < cells; c++) if (table[c] >= 0) key += (opts[c >> 1].indexOf(table[c]) + 1) * pow[c];
    return key;
  };

  /** Halter wins from the position in `work`, after `done` moves? */
  function wins(key, done) {
    const known = memo.get(key);
    if (known !== undefined) return known;
    let result;
    if (done === moves) result = run(work, LONGEST[n]).halted;
    else {
      const halter = order[done] === 'H';
      result = !halter;
      search: for (let c = 1; c < cells; c++) {
        if (work[c] !== EMPTY) continue;
        const list = opts[c >> 1];
        for (let i = 0; i < list.length; i++) {
          work[c] = list[i];
          const child = wins(key + (i + 1) * pow[c], done + 1);
          work[c] = EMPTY;
          if (child === halter) {
            result = halter;
            break search;
          }
        }
      }
    }
    solver.positions++;
    memo.set(key, result);
    return result;
  }

  const load = (table) => {
    let done = -1;
    for (let c = 0; c < cells; c++) {
      work[c] = table[c];
      if (table[c] !== EMPTY) done++;
    }
    return done;
  };

  solver.halterWins = (table) => wins(keyOf(table), load(table));

  /** Every legal move with whether it wins for the player making it. */
  solver.moves = (table) => {
    const done = load(table);
    const key = keyOf(table);
    const halter = order[done] === 'H';
    const out = [];
    for (let c = 1; c < cells; c++) {
      if (table[c] !== EMPTY) continue;
      opts[c >> 1].forEach((code, i) => {
        work[c] = code;
        out.push({ cell: c, code, winning: wins(key + (i + 1) * pow[c], done + 1) === halter });
        work[c] = EMPTY;
      });
    }
    return out;
  };

  solver.best = (table) => {
    const all = solver.moves(table);
    const winning = all.find((m) => m.winning);
    if (winning) return { ...winning, replies: 0 };
    // every move loses: make the opponent's task as hard as possible
    const last = load(table) + 1 === moves;
    let best = null;
    for (const m of all) {
      const after = table.slice();
      after[m.cell] = m.code;
      const replies = last ? 0 : solver.moves(after).filter((r) => r.winning).length;
      if (!best || replies < best.replies) best = { ...m, replies };
    }
    return best;
  };

  solver.opening = () => {
    const table = start(n);
    const all = solver.moves(table);
    return { halterWins: solver.halterWins(table), winning: all.filter((m) => m.winning).length, total: all.length };
  };
  return solver;
}

/**
 * A move chosen by sampling, for machines too large to solve: finish the game at random many
 * times after each candidate move and prefer the move whose machines halt most (or least) often.
 * `random` is a function returning numbers in [0, 1).
 */
export function sampleMove(table, order, random, samples = 20) {
  const moves = order.length;
  const n = table.length / 2;
  const done = table.length - 1 - table.filter((c) => c === EMPTY).length;
  const halter = order[done] === 'H';
  const opts = Array.from({ length: n }, (_, s) => options(n, s));
  let best = null;
  for (let c = 1; c < table.length; c++) {
    if (table[c] !== EMPTY) continue;
    for (const code of opts[c >> 1]) {
      let halts = 0;
      for (let k = 0; k < samples; k++) {
        const t = table.slice();
        t[c] = code;
        for (let m = done + 1; m < moves; m++) {
          const open = [];
          for (let i = 1; i < t.length; i++) if (t[i] === EMPTY) open.push(i);
          const cell = open[Math.floor(random() * open.length)];
          t[cell] = opts[cell >> 1][Math.floor(random() * opts[cell >> 1].length)];
        }
        const r = run(t, 3000, { pattern: true });
        halts += r.halted ? 1 : r.reason === 'limit' ? 0.35 : 0; // still going after 3000 steps: probably forever
      }
      const score = halter ? halts : samples - halts;
      if (!best || score > best.score) best = { cell: c, code, score };
    }
  }
  return best;
}
