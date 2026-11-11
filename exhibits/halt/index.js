// HALT — the board, the instruction picker, the tape, and the table of what has been proved.
import { el, button, segmented, select, loadCSS, cssVar, view, rng } from '../../assets/js/kit.js';
import { EMPTY, LONGEST, STATE, decode, encode, trace } from './machine.js';
import { ORDERS, options, start, place, played, toMove, referee } from './game.js';
import { createSolver, sampleMove } from './solve.js';

const NAME = { H: 'Halter', R: 'Runner' };
const spell = (order) => [...order].map((c) => NAME[c]).join(', ');
const count = (n) => n.toLocaleString('en-US');
const words = (code) => {
  const { write, right, next } = decode(code);
  return `write ${write}, step ${right ? 'right' : 'left'}, go to ${STATE[next]}`;
};

export async function mount(root, env) {
  await loadCSS(new URL('./style.css', import.meta.url));
  const random = rng((Date.now() ^ 0x9e3779b9) >>> 0);
  let n = 4;
  let order = 'HRH';
  let human = 'H'; // 'H', 'R', or 'HR' for two people sharing the device
  let table = start(n);
  let picked = -1; // the empty box being filled
  let draft = { write: 1, right: 0, next: 0 };
  let verdict = null;
  let hint = null;
  const solvers = new Map();
  const solver = () => {
    if (n > 4) return null;
    const k = `${n}${order}`;
    if (!solvers.has(k)) solvers.set(k, createSolver(n, order));
    return solvers.get(k);
  };

  /* ── controls ── */
  const sizePick = segmented({ label: 'States', options: [3, 4, 5], value: n, onChange: (v) => { n = v; order = ORDERS[n][0]; fillOrders(); reset(); proveAll(); } });
  const orderPick = select({ label: 'Turns', id: 'halt-order', options: [], onChange: (v) => { order = v; reset(); } });
  const sidePick = segmented({ label: 'You play', options: [{ value: 'H', label: 'Halter' }, { value: 'R', label: 'Runner' }, { value: 'HR', label: 'Both' }], value: human, onChange: (v) => { human = v; reset(); } });
  const fillOrders = () => {
    orderPick.input.textContent = '';
    for (const o of ORDERS[n]) orderPick.input.append(el('option', { value: o }, spell(o)));
    orderPick.value = order;
  };
  const status = el('p', { class: 'halt-status', role: 'status', 'aria-live': 'polite' });
  root.append(el('div', { class: 'kit-bar halt-top' }, sizePick, orderPick, sidePick, button({ label: 'New game', id: 'halt-new', onClick: () => reset() })), status);

  /* ── board, picker, tape ── */
  const board = el('div', { class: 'halt-board', role: 'group', 'aria-label': 'Instruction table' });
  const picker = el('div', { class: 'halt-picker', hidden: true });
  const hintBtn = button({ label: 'Show a winning move', kind: 'ghost', id: 'halt-hint', onClick: showHint });
  const v = view(root, { aspect: 1.25, aspectNarrow: 0.95, label: 'The tape, one row per step, as the machine would run right now' });
  v.wrap.classList.add('halt-tape');
  const caption = el('p', { class: 'halt-caption' });
  const rules = el('p', { class: 'halt-rules' }, 'Take turns writing instructions into the empty boxes. Then the machine runs from state A on a tape of 0s. An empty box stops it. If it ever stops, the Halter wins. If it runs forever, the Runner wins.');
  const left = el('div', { class: 'halt-left' }, rules, board, picker, hintBtn);
  const right = el('div', { class: 'halt-right' }, v.wrap, caption);
  root.append(el('div', { class: 'halt-main' }, left, right));

  /* ── what has been proved ── */
  const proofs = el('div', { class: 'halt-proofs' });
  root.append(proofs);
  let proving = 0;
  function proveAll() {
    const mine = ++proving;
    proofs.textContent = '';
    proofs.append(el('p', { class: 'halt-proofs-title' }, n > 4 ? 'Nobody knows who wins on five states' : `Solved on this device, ${n} states`));
    if (n > 4) {
      proofs.append(
        el('p', { class: 'halt-note' }, `There are too many five-state games to try them all here, so these are open questions. Each finished game is still judged exactly: in 2024 it was proved that no five-state machine that halts runs longer than ${count(LONGEST[5])} steps, so the referee runs your machine that far and then knows.`),
      );
      return;
    }
    const list = el('ul', { class: 'halt-theorems', role: 'list' });
    proofs.append(list);
    const todo = [...ORDERS[n]];
    const step = () => {
      if (mine !== proving || !todo.length) return;
      const o = todo.shift();
      const t0 = performance.now();
      const s = createSolver(n, o);
      const r = s.opening();
      solvers.set(`${n}${o}`, s);
      const first = NAME[o[0]];
      const winner = r.halterWins ? 'Halter' : 'Runner';
      const how = first === winner ? `${first} writes first and wins, but only ${r.winning} of the ${r.total} possible first moves ${r.winning === 1 ? 'does' : 'do'} it.` : `${first} writes first and loses whatever they do: the ${winner} wins.`;
      list.append(el('li', null, el('span', { class: 'halt-order' }, spell(o)), el('span', null, how), el('span', { class: 'halt-work' }, `${count(s.positions)} positions tried in ${Math.max(1, Math.round(performance.now() - t0))} ms`)));
      setTimeout(step, 30);
    };
    setTimeout(step, 60);
  }

  /* ── drawing ── */
  const ctx = v.canvas.getContext('2d');
  function drawTape() {
    const { pw, ph } = v.size;
    if (!pw) return;
    const ink = { bg: cssVar(root, '--st-bg'), one: cssVar(root, '--st-accent'), line: cssVar(root, '--st-line'), head: cssVar(root, '--st-text'), bad: cssVar(root, '--st-bad') };
    const cols = env.small ? 21 : 31;
    const rows = Math.max(8, Math.floor((ph / pw) * cols * 1.0));
    const cell = pw / cols;
    const steps = trace(table, rows, cols);
    ctx.fillStyle = ink.bg;
    ctx.fillRect(0, 0, pw, ph);
    // the blank tape: a faint grid, one row per step still to come
    ctx.strokeStyle = ink.line;
    ctx.globalAlpha = 0.45;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = 0; x <= cols; x++) {
      ctx.moveTo(Math.round(x * cell) + 0.5, 0);
      ctx.lineTo(Math.round(x * cell) + 0.5, rows * cell);
    }
    for (let y = 0; y <= rows; y++) {
      ctx.moveTo(0, Math.round(y * cell) + 0.5);
      ctx.lineTo(pw, Math.round(y * cell) + 0.5);
    }
    ctx.stroke();
    ctx.globalAlpha = 1;
    steps.forEach((row, y) => {
      for (let x = 0; x < cols; x++) {
        if (row.tape[x]) {
          ctx.fillStyle = ink.one;
          ctx.fillRect(x * cell + 1, y * cell + 1, cell - 2, cell - 2);
        }
      }
      // the head: a ring, with the state's letter when there is room for it
      ctx.strokeStyle = row.halt ? ink.bad : ink.head;
      ctx.lineWidth = Math.max(1.5, cell * 0.12);
      ctx.strokeRect(row.head * cell + 1, y * cell + 1, cell - 2, cell - 2);
      if (cell >= 13) {
        ctx.fillStyle = row.tape[row.head] ? cssVar(root, '--st-accent-ink') : ink.head;
        ctx.font = `600 ${Math.round(cell * 0.62)}px ${cssVar(root, '--font-mono')}`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(STATE[row.state], row.head * cell + cell / 2, y * cell + cell / 2 + 1);
      }
    });
    const last = steps[steps.length - 1];
    const live = referee(table);
    if (!toMove(table, order)) caption.textContent = 'Each row is one step. Filled squares are 1s; the ring is where the machine is reading.';
    else if (live.halted) caption.textContent = `As it stands the machine stops after ${live.steps} step${live.steps === 1 ? '' : 's'}: in state ${STATE[live.state]} reading ${live.symbol}, where no instruction has been written.`;
    else caption.textContent = `As it stands the machine never stops. ${last && !last.halt ? 'The Halter has to change that.' : ''}`;
  }
  v.onResize(drawTape);

  function drawBoard() {
    board.textContent = '';
    board.append(el('span', { class: 'halt-corner' }), el('span', { class: 'halt-colhead' }, 'reads 0'), el('span', { class: 'halt-colhead' }, 'reads 1'));
    const turn = toMove(table, order);
    const mayPick = turn && human.includes(turn);
    for (let s = 0; s < n; s++) {
      board.append(el('span', { class: 'halt-rowhead' }, STATE[s]));
      for (let sym = 0; sym < 2; sym++) {
        const c = s * 2 + sym;
        const code = table[c];
        const label = `State ${STATE[s]} reading ${sym}`;
        if (code === EMPTY) {
          const stops = verdict && verdict.halted && verdict.state === s && verdict.symbol === sym;
          board.append(
            el('button', { type: 'button', class: `halt-box halt-box--empty${picked === c ? ' halt-box--picked' : ''}${stops ? ' halt-box--stop' : ''}${hint && hint.cell === c ? ' halt-box--hint' : ''}`, disabled: !mayPick, 'aria-label': `${label}: empty`, onClick: () => pick(c) }, turn ? '' : stops ? 'stopped here' : 'stops'),
          );
        } else {
          const d = decode(code);
          board.append(el('div', { class: `halt-box${c === 0 ? ' halt-box--given' : ''}`, 'aria-label': `${label}: ${words(code)}` }, el('b', null, String(d.write)), el('span', null, d.right ? '→' : '←'), el('b', null, STATE[d.next])));
        }
      }
    }
  }

  function drawPicker() {
    const turn = toMove(table, order);
    picker.hidden = picked < 0 || !turn;
    hintBtn.hidden = n > 4 || !turn || !human.includes(turn);
    if (picker.hidden) return;
    const state = picked >> 1;
    const others = [...STATE.slice(0, n)].map((_, i) => i).filter((i) => i !== state);
    if (!others.includes(draft.next)) draft.next = others[0];
    picker.textContent = '';
    picker.append(
      el('p', { class: 'halt-picker-title' }, `In state ${STATE[state]}, reading ${picked & 1}:`),
      segmented({ label: 'Write', options: [1, 0], value: draft.write, onChange: (x) => (draft.write = x) }),
      segmented({ label: 'Step', options: [{ value: 0, label: 'Left' }, { value: 1, label: 'Right' }], value: draft.right, onChange: (x) => (draft.right = x) }),
      segmented({ label: 'Go to', options: others.map((i) => ({ value: i, label: STATE[i] })), value: draft.next, onChange: (x) => (draft.next = x) }),
      button({ label: 'Write it', kind: 'primary', id: 'halt-write', onClick: () => move(picked, encode(draft.write, !!draft.right, draft.next)) }),
    );
  }

  function say() {
    const turn = toMove(table, order);
    if (verdict) {
      const who = verdict.halted ? 'Halter' : 'Runner';
      const you = human === 'HR' ? '' : human === (verdict.halted ? 'H' : 'R') ? ' You win.' : ' You lose.';
      let why;
      if (verdict.reason === 'memory') {
        status.textContent = 'No verdict: this machine wandered further along the tape than this device can follow.';
        return;
      }
      if (verdict.halted) why = `The machine stops after ${count(verdict.steps)} step${verdict.steps === 1 ? '' : 's'}.`;
      else if (verdict.reason === 'pattern') why = `After ${count(verdict.steps)} steps the machine is repeating one stretch over and over as it drifts along the blank tape. It will never stop.`;
      else why = `After ${count(LONGEST[n])} steps the machine is still running, and no ${n}-state machine that stops runs that long. It will never stop.`;
      status.textContent = `${why} The ${who} wins.${you}`;
    } else if (!turn) status.textContent = 'The referee is running the machine…';
    else if (human.includes(turn)) status.textContent = `${NAME[turn]} to write (move ${played(table) + 1} of ${order.length}). ${human === 'HR' ? '' : 'That is you. '}Tap an empty box.`;
    else status.textContent = `${NAME[turn]} is thinking…`;
  }

  function render() {
    drawBoard();
    drawPicker();
    drawTape();
    say();
  }

  /* ── play ── */
  function pick(c) {
    picked = picked === c ? -1 : c;
    hint = null;
    render();
  }
  function move(cell, code) {
    table = place(table, cell, code);
    picked = -1;
    hint = null;
    advance();
  }
  function advance() {
    const turn = toMove(table, order);
    render();
    if (!turn) {
      // five-state machines can take a moment: let the message paint first
      setTimeout(() => {
        verdict = referee(table);
        render();
      }, n > 4 ? 40 : 0);
    } else if (!human.includes(turn)) {
      const mine = table;
      setTimeout(() => {
        if (table !== mine) return;
        const s = solver();
        const m = s ? s.best(table) : sampleMove(table, order, random, 16);
        table = place(table, m.cell, m.code);
        advance();
      }, 350);
    }
  }
  function showHint() {
    const s = solver();
    const m = s && s.best(table);
    if (!m) return;
    hint = m.winning ? m : null;
    drawBoard();
    status.textContent = m.winning ? `A winning move: in state ${STATE[m.cell >> 1]} reading ${m.cell & 1}, ${words(m.code)}.` : 'There is no winning move from here. Every move loses against perfect play.';
  }
  function reset() {
    table = start(n);
    picked = -1;
    verdict = null;
    hint = null;
    advance();
  }

  fillOrders();
  reset();
  proveAll();
  return { start() {}, stop() {}, destroy() { proving++; v.destroy(); } };
}
