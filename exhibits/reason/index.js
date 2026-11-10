// REASON — the notebook: an input line, example chips, and one card per calculation.
import { el, button, loadCSS } from '../../assets/js/kit.js';
import { run } from './engine.js';
import { toHTML } from './display.js';
import { createPlot } from './plot.js';

const EXAMPLES = [
  ['d/dx sin(x^2) e^x', 'd/dx sin(x²)·eˣ'],
  ['integrate(x^2 e^x, x)', '∫ x² eˣ dx'],
  ['factor(x^4 + 4)', 'factor x⁴ + 4'],
  ['x^2 - 2x - 4 = 0', 'solve x² − 2x − 4 = 0'],
  ['series(cos(x), x, 8)', 'series of cos x'],
  ['integrate(1/(x^2 + 2x + 5), x)', '∫ dx / (x² + 2x + 5)'],
  ['expand((x + 1)^8)', 'expand (x + 1)⁸'],
  ['integrate(e^(-x^2), x, -3, 3)', '∫ e^(−x²) from −3 to 3'],
  ['e^(i pi) + 1', 'e^(iπ) + 1'],
  ['diff(x^x, x)', 'd/dx xˣ'],
  ['solve(cos(x) = x)', 'cos x = x'],
  ['50!', '50!'],
];
// worked cards shown before anything is typed, oldest first
const OPENING = ['factor(x^4 + 4)', 'integrate(x^2 e^x, x)', 'd/dx sin(x^2) e^x'];
const MAX_CARDS = 10;

const math = (d, cls = '') => {
  const box = el('div', { class: `reason-scroll ${cls}` });
  box.innerHTML = toHTML(d);
  return box;
};

function card(r, root) {
  if (!r.ok) {
    const pointerLine = r.pos != null ? `${r.input}\n${' '.repeat(Math.min(r.pos, r.input.length))}^` : r.input;
    return { node: el('article', { class: 'reason-card reason-card--error' }, el('p', { class: 'reason-kind' }, 'Could not read that'), el('pre', { class: 'reason-typed' }, pointerLine), el('p', { class: 'reason-message' }, `${r.message[0].toUpperCase()}${r.message.slice(1)}.`)), plot: null };
  }
  const node = el('article', { class: 'reason-card' });
  const head = el('header', { class: 'reason-head' }, el('span', { class: 'reason-kind' }, r.title), el('code', { class: 'reason-typed' }, r.input));
  node.append(head);
  if (r.question) node.append(math(r.question, 'reason-question'));
  if (r.answer) {
    node.append(el('div', { class: 'reason-answer' }, r.question ? el('span', { class: 'reason-equals', 'aria-hidden': 'true' }, '=') : null, math(r.answer)));
    if (r.extra) node.append(el('div', { class: 'reason-answer reason-answer--approx' }, el('span', { class: 'reason-equals', 'aria-hidden': 'true' }, '≈'), math(r.extra)));
  } else node.append(el('p', { class: 'reason-message' }, r.message));
  if (r.check) node.append(el('p', { class: 'reason-check', dataset: { state: r.check.state } }, el('span', { class: 'reason-check-mark', 'aria-hidden': 'true' }, r.check.state === 'ok' ? '✓' : r.check.state === 'bad' ? '✗' : '–'), r.check.text));
  for (const note of r.notes) node.append(el('p', { class: 'reason-note' }, note));

  if (r.steps.length) {
    node.append(
      el(
        'details',
        { class: 'reason-steps' },
        el('summary', null, `Show the ${r.steps.length} step${r.steps.length === 1 ? '' : 's'}`),
        el(
          'ol',
          null,
          r.steps.map((s) => {
            const line = el('div', { class: 'reason-scroll reason-step-math' });
            line.innerHTML = `${toHTML(s.lhs)}<span class="reason-m-op">=</span>${toHTML(s.rhs)}`;
            const rule = el('p', { class: 'reason-rule' }, s.rule);
            if (s.sub) {
              const sub = el('span', { class: 'reason-rule-sub' });
              sub.innerHTML = `: let ${toHTML(s.sub)}`;
              rule.append(sub);
            }
            return el('li', null, rule, line);
          }),
        ),
      ),
    );
  }

  let plot = null;
  if (r.plot) {
    const canvas = el('canvas', { class: 'reason-plot', role: 'img', 'aria-label': `Graph of ${r.plot.curves.map((c) => c.label).join(' and ')} against ${r.plot.v}` });
    node.append(canvas);
    plot = { canvas, spec: r.plot };
  }

  if (r.latex) {
    const source = el('pre', { class: 'reason-latex', hidden: true, tabindex: '0' }, r.latex);
    const copy = button({
      label: 'Copy LaTeX',
      kind: 'ghost',
      onClick: async () => {
        try {
          await navigator.clipboard.writeText(r.latex);
          copy.setLabel('Copied');
        } catch {
          // no clipboard here: show the text, selected, so it can be copied by hand
          source.hidden = false;
          const range = document.createRange();
          range.selectNodeContents(source);
          const sel = window.getSelection();
          sel.removeAllRanges();
          sel.addRange(range);
          copy.setLabel('Select and copy');
        }
        setTimeout(() => copy.setLabel('Copy LaTeX'), 2400);
      },
    });
    head.append(copy);
    node.append(source);
  }
  return { node, plot, root };
}

export async function mount(root) {
  await loadCSS(new URL('./style.css', import.meta.url));
  const cards = el('div', { class: 'reason-cards', 'aria-live': 'polite' });
  const live = []; // { node, plot: { destroy } }

  function show(text) {
    const built = card(run(text), root);
    cards.prepend(built.node);
    const entry = { node: built.node, plot: built.plot ? createPlot(built.plot.canvas, built.plot.spec, root) : null };
    live.unshift(entry);
    while (live.length > MAX_CARDS) {
      const old = live.pop();
      if (old.plot) old.plot.destroy();
      old.node.remove();
    }
  }

  const input = el('input', { class: 'reason-input', id: 'reason-input', type: 'text', enterkeyhint: 'go', autocapitalize: 'off', autocomplete: 'off', autocorrect: 'off', 'aria-label': 'Type some mathematics', placeholder: 'Try  diff(x^3 sin(x), x)  or  x^2 = 2' });
  input.setAttribute('spellcheck', 'false');
  const form = el('form', { class: 'reason-ask' }, input, button({ label: 'Work it out', kind: 'primary', id: 'reason-go' }));
  form.lastChild.type = 'submit';
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (!input.value.trim()) return;
    show(input.value);
    input.select();
  });
  const chips = el(
    'div',
    { class: 'reason-chips', role: 'group', 'aria-label': 'Examples' },
    EXAMPLES.map(([text, label]) =>
      el('button', { type: 'button', class: 'reason-chip', onClick: () => { input.value = text; show(text); } }, label),
    ),
  );
  const help = el('p', { class: 'reason-help' }, 'Commands: diff, integrate, factor, expand, simplify, series, solve, N. Write 2x for 2·x and x^2 for x².');
  root.append(el('div', { class: 'reason-top' }, form, chips, help), cards);

  OPENING.forEach(show);

  return {
    start() {},
    stop() {},
    destroy() {
      live.forEach((entry) => entry.plot && entry.plot.destroy());
    },
  };
}
