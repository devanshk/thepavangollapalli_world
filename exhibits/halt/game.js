// The rules of Halt.
//
//   1. The table of an n-state machine starts with one instruction written: in state A reading 0,
//      write 1, step right, go to state B.
//   2. Two players, the Halter and the Runner, write one instruction at a time into any empty
//      box, in an agreed order such as Halter, Runner, Halter. An instruction writes 0 or 1,
//      steps left or right, and must lead to a different state.
//   3. Then the machine starts in state A on a blank tape. A box that is still empty stops it.
//      If the machine ever stops, the Halter wins. If it runs forever, the Runner wins.
import { EMPTY, LONGEST, encode, run } from './machine.js';

/** Turn orders offered for each machine size: who writes each instruction, first to last. */
export const ORDERS = {
  3: ['HRH', 'HRHH', 'RHHR', 'RHHRH'],
  4: ['HRH', 'HRHH', 'RHHR'],
  5: ['HRH', 'HRHH', 'RHHR', 'HRHRH', 'HRHRHRHR'],
};

/** Every instruction that may be written in a row of `state`: 4·(n − 1) of them. */
export function options(n, state) {
  const out = [];
  for (let next = 0; next < n; next++) if (next !== state) for (const right of [1, 0]) for (const write of [1, 0]) out.push(encode(write, right, next));
  return out;
}

export function start(n) {
  const table = new Int8Array(2 * n).fill(EMPTY);
  table[0] = encode(1, true, 1);
  return table;
}

export const empties = (table) => {
  const out = [];
  for (let i = 0; i < table.length; i++) if (table[i] === EMPTY) out.push(i);
  return out;
};
/** How many moves have been played (the opening instruction is not a move). */
export const played = (table) => table.length - 1 - empties(table).length;

/** The table after writing `code` in `cell`. */
export function place(table, cell, code) {
  if (table[cell] !== EMPTY) throw new Error('that box is already filled');
  if (code < 0 || code >> 2 === cell >> 1 || code >> 2 >= table.length / 2) throw new Error('that instruction is not allowed there');
  const next = table.slice();
  next[cell] = code;
  return next;
}

/** Does this machine halt? Decided by the busy beaver theorem. → run()'s result */
export function referee(table) {
  const n = table.length / 2;
  return run(table, LONGEST[n], { pattern: n >= 5 });
}

/** Whose turn it is, 'H' or 'R', or null when the game is over. */
export const toMove = (table, order) => order[played(table)] || null;
