import { assert, equal } from '../../assets/js/check.js';
import { rng } from '../../assets/js/kit.js';
import { EMPTY, LONGEST, run, trace, parseTable, show, encode } from './machine.js';
import { ORDERS, options, start, place, played, toMove, referee } from './game.js';
import { createSolver, sampleMove } from './solve.js';

// the record holders: the longest-running machines that halt, for 2 to 5 states
const CHAMPIONS = {
  2: '1RB 1LB 1LA HALT',
  3: '1RB HALT 1LB 0RC 1LC 1LA',
  4: '1RB 1LB 1LA 0LC HALT 1LD 1RD 0RA',
  5: '1RB 1LC 1RC 1RB 1RD 0LE 1LA 1LD HALT 0LA',
};

/** Every table of the game's kind for n states: each free box empty or holding a legal instruction. */
function* everyTable(n) {
  const opts = Array.from({ length: n }, (_, s) => [EMPTY, ...options(n, s)]);
  const table = start(n);
  const digit = new Array(2 * n).fill(0);
  for (;;) {
    for (let c = 1; c < 2 * n; c++) table[c] = opts[c >> 1][digit[c]];
    yield table;
    let c = 1;
    while (c < 2 * n && ++digit[c] === opts[c >> 1].length) digit[c++] = 0;
    if (c === 2 * n) return;
  }
}

function randomTable(n, r) {
  const table = start(n);
  for (let c = 1; c < 2 * n; c++) table[c] = r() < 0.25 ? EMPTY : r.pick(options(n, c >> 1));
  return table;
}

export default [
  {
    name: 'the record machines halt after exactly 6, 21 and 107 steps',
    fn() {
      for (const n of [2, 3, 4]) {
        const r = run(parseTable(CHAMPIONS[n]), 100000);
        equal([r.halted, r.steps], [true, LONGEST[n]], `${n} states`);
      }
    },
  },
  {
    name: 'the five-state record machine halts after exactly 47,176,870 steps',
    fn() {
      const r = run(parseTable(CHAMPIONS[5]), LONGEST[5], { pattern: true });
      equal([r.halted, r.steps, r.ones], [true, 47176870, 4097]);
      // one step fewer and the referee would wrongly call it endless: the bound is exact
      equal(run(parseTable(CHAMPIONS[5]), LONGEST[5] - 2).reason, 'limit');
    },
  },
  {
    name: 'no three-state machine in the game outlasts the theorem',
    fn() {
      let halting = 0;
      let longest = 0;
      for (const table of everyTable(3)) {
        const r = run(table, 300);
        if (!r.halted) continue;
        halting++;
        longest = Math.max(longest, r.steps);
      }
      assert(halting > 10000, `${halting} of the tables halt`);
      assert(longest <= LONGEST[3], `one runs ${longest} steps and still halts`);
    },
  },
  {
    name: 'the pattern shortcut never calls a halting machine endless',
    fn() {
      const r = rng(7);
      let caught = 0;
      const check = (table, n) => {
        const quick = run(table, 400, { pattern: true });
        if (quick.reason !== 'pattern') return;
        caught++;
        const slow = run(table, LONGEST[n]);
        assert(!slow.halted, `${[...table].map(show).join(' ')} halts after ${slow.steps} steps but was called endless`);
      };
      for (const table of everyTable(3)) check(table, 3);
      for (let i = 0; i < 20000; i++) check(randomTable(4, r), 4);
      assert(caught > 3000, `the shortcut fired ${caught} times`);
    },
  },
  {
    name: 'on five states, machines the shortcut calls endless are still running 200,000 steps later',
    fn() {
      const r = rng(11);
      let caught = 0;
      for (let i = 0; i < 1500; i++) {
        const table = randomTable(5, r);
        if (run(table, 5000, { pattern: true }).reason !== 'pattern') continue;
        caught++;
        assert(!run(table, 200000).halted, `${[...table].map(show).join(' ')} halts`);
      }
      assert(caught > 100, `the shortcut fired ${caught} times`);
    },
  },
  {
    name: 'the rules: one instruction per turn, never back to the same state, empty boxes halt',
    fn() {
      const t = start(4);
      equal(show(t[0]), '1RB', 'the opening instruction');
      equal(options(4, 1).length, 12);
      assert(options(4, 1).every((c) => c >> 2 !== 1), 'no instruction keeps the machine in the same state');
      equal([played(t), toMove(t, 'HRH')], [0, 'H']);
      const after = place(t, 2, encode(1, false, 0));
      equal([played(after), toMove(after, 'HRH'), t[2]], [1, 'R', EMPTY], 'place() returns a new table');
      let refused = 0;
      for (const bad of [() => place(after, 2, encode(0, true, 0)), () => place(t, 2, encode(1, true, 1)), () => place(t, 3, encode(1, true, 4))]) {
        try {
          bad();
        } catch {
          refused++;
        }
      }
      equal(refused, 3, 'a filled box, a self-loop and a state that does not exist are all refused');
      const r = referee(after); // A0 = 1RB, B0 = 1LA, then A reads 1: an empty box
      equal([r.halted, r.steps, r.state, r.symbol], [true, 3, 0, 1]);
      equal(trace(after, 10, 9).length, 3);
    },
  },
  {
    name: 'theorem: Halter, Runner, Halter on four states is won by the Halter, by one first move in 84',
    fn() {
      const s = createSolver(4, 'HRH');
      equal(s.opening(), { halterWins: true, winning: 1, total: 84 });
      const only = s.moves(start(4)).find((m) => m.winning);
      equal([only.cell, show(only.code)], [2, '1LA'], 'the move: in state B reading 0, write 1, step left, go to A');
    },
  },
  {
    name: 'theorem: the same holds on three states, by one first move in 40',
    fn() {
      equal(createSolver(3, 'HRH').opening(), { halterWins: true, winning: 1, total: 40 });
      equal(createSolver(3, 'HRHH').opening(), { halterWins: true, winning: 1, total: 40 });
    },
  },
  {
    name: 'theorem: when the Runner writes first and last, the Runner wins, by 10 first moves in 84',
    fn() {
      equal(createSolver(4, 'RHHR').opening(), { halterWins: false, winning: 10, total: 84 });
      equal(createSolver(3, 'RHHR').opening().halterWins, false);
    },
  },
  {
    name: 'perfect play really wins: the solver’s line beats every possible defence',
    fn() {
      // Follow the solver for the side that should win and try every reply for the other side.
      const n = 3;
      for (const order of ORDERS[n]) {
        const s = createSolver(n, order);
        const winner = s.halterWins(start(n)) ? 'H' : 'R';
        let games = 0;
        const walk = (table) => {
          const who = toMove(table, order);
          if (!who) {
            games++;
            equal(referee(table).halted, winner === 'H', `${order}: a finished game went the wrong way`);
            return;
          }
          if (who === winner) {
            const m = s.best(table);
            assert(m.winning, `${order}: the solver lost the thread`);
            walk(place(table, m.cell, m.code));
          } else for (const m of s.moves(table)) walk(place(table, m.cell, m.code));
        };
        walk(start(n));
        assert(games > 0);
      }
    },
  },
  {
    name: 'a losing side is given the move that leaves the fewest winning replies',
    fn() {
      const s = createSolver(4, 'HRH');
      const afterBest = place(start(4), 2, encode(1, false, 0));
      const reply = s.best(afterBest); // the Runner is lost here
      equal(reply.winning, false);
      const counts = s.moves(afterBest).map((m) => s.moves(place(afterBest, m.cell, m.code)).filter((x) => x.winning).length);
      equal(reply.replies, Math.min(...counts));
    },
  },
  {
    name: 'the sampling player for five states always returns a legal move',
    fn() {
      const r = rng(3);
      let table = start(5);
      const order = 'HRHRH';
      while (toMove(table, order)) {
        const m = sampleMove(table, order, r, 6);
        table = place(table, m.cell, m.code);
      }
      equal(played(table), 5);
      assert(['halt', 'limit', 'pattern'].includes(referee(table).reason));
    },
  },
];
