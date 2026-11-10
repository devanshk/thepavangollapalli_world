// LANGUAGE — the editor, the output screen, and the views of the compiled binary.
import { el, button, select, toggle, stat, spacer, loop, loadCSS } from '../../assets/js/kit.js';
import { compile } from './compiler.js';
import { disassemble } from './disasm.js';
import { EXAMPLES } from './examples.js';
import { highlight } from './highlight.js';
import { createRunner } from './runner.js';
import { FB_WIDTH, FB_HEIGHT } from './types.js';

const ms = (x) => (x < 1 ? `${Math.round(x * 1000)} µs` : x < 10 ? `${x.toFixed(1)} ms` : `${Math.round(x)} ms`);
const TABS = [
  { id: 'output', label: 'Output' },
  { id: 'wat', label: 'WebAssembly' },
  { id: 'bytes', label: 'Bytes' },
];
const BYTE_LIMIT = 4096;

export async function mount(root, env) {
  await loadCSS(new URL('./style.css', import.meta.url));
  // iOS draws textarea text a few pixels off from any overlay, so there the coloured layer is
  // shown while reading and the plain text while typing.
  if (window.CSS && CSS.supports && CSS.supports('-webkit-touch-callout', 'none')) root.classList.add('language-ios');

  let source = EXAMPLES[0].source;
  let optimise = true;
  let good = null; // the last compile that succeeded
  let decoded = null; // its disassembly, made when a tab needs it
  let errorLine = 0;
  let tab = 'output';
  let lines = [];
  let frameAvg = 0;
  let timer = 0;
  let firstFrame = null;

  /* ── top bar ── */
  const compileStat = stat({ label: 'Compile' });
  const sizeStat = stat({ label: 'Binary' });
  const runStat = stat({ label: 'Run' });
  const backStat = stat({ label: 'Back end' });
  const picker = select({
    label: 'Example',
    id: 'language-example',
    options: EXAMPLES.map((e, i) => ({ value: i, label: e.name })),
    value: 0,
    onChange: (i) => setSource(EXAMPLES[+i].source),
  });
  const optToggle = toggle({ label: 'Optimise', value: true, id: 'language-optimise', onChange: (on) => { optimise = on; rebuild(); } });
  root.append(el('div', { class: 'kit-bar language-top' }, picker, optToggle, spacer(), compileStat, sizeStat, runStat, backStat));

  /* ── editor ── */
  const gutter = el('div', { class: 'language-gutter', 'aria-hidden': 'true' });
  const colour = el('pre', { class: 'language-hl', 'aria-hidden': 'true' });
  const input = el('textarea', { class: 'language-input', id: 'language-source', wrap: 'off', 'aria-label': 'Sable source code', autocapitalize: 'off', autocomplete: 'off', autocorrect: 'off' });
  input.setAttribute('spellcheck', 'false');
  const diag = el('div', { class: 'language-diag', role: 'status', hidden: true });
  const left = el('div', { class: 'language-left' }, el('div', { class: 'language-editor' }, gutter, el('div', { class: 'language-code' }, colour, input)), diag);

  /* ── output ── */
  const screen = el('canvas', { class: 'language-screen', width: FB_WIDTH, height: FB_HEIGHT, role: 'img', 'aria-label': 'Picture drawn by the running program' });
  const ctx = screen.getContext('2d');
  const image = ctx.createImageData(FB_WIDTH, FB_HEIGHT);
  const log = el('pre', { class: 'language-log', tabindex: '0', 'aria-label': 'Printed output' });
  const raceBtn = button({ label: 'Race both back ends', id: 'language-race', onClick: race });
  const panes = {
    output: el('div', { class: 'language-pane language-out' }, screen, el('div', { class: 'language-logrow' }, log, raceBtn)),
    wat: el('pre', { class: 'language-pane language-wat', tabindex: '0', hidden: true }),
    bytes: el('div', { class: 'language-pane language-bytes', tabindex: '0', hidden: true }),
  };
  const tabButtons = TABS.map((t) =>
    el('button', { type: 'button', class: 'language-tab', role: 'tab', id: `language-tab-${t.id}`, 'aria-selected': String(t.id === tab), onClick: () => showTab(t.id) }, t.label),
  );
  const right = el('div', { class: 'language-right' }, el('div', { class: 'language-tabs', role: 'tablist' }, tabButtons), panes.output, panes.wat, panes.bytes);
  root.append(el('div', { class: 'language-main' }, left, right));

  /* ── running ── */
  const say = (text) => {
    lines.push(text);
    if (lines.length > 200) lines = lines.slice(-200);
    log.textContent = lines.join('\n');
    log.scrollTop = log.scrollHeight;
  };
  const runner = createRunner({
    onReset() {
      lines = [];
      log.textContent = '';
      frameAvg = 0;
    },
    onLoaded(r) {
      backStat.set(r.backend === 'wasm' ? 'WebAssembly' : 'Interpreter');
      if (r.note) say(r.note);
      if (r.mainMs != null && !r.hasFrame) runStat.set(`main ${ms(r.mainMs)}`);
      if (!r.hasMain && !r.hasFrame) say('Nothing ran: define fn main() or fn frame(t: float).');
    },
    onPixels(pixels) {
      image.data.set(pixels);
      ctx.putImageData(image, 0, 0);
      if (firstFrame) firstFrame();
    },
    onPrints(printed) {
      printed.forEach(say);
    },
    onFrameTime(t) {
      frameAvg = frameAvg ? frameAvg * 0.9 + t * 0.1 : t;
      runStat.set(`${ms(frameAvg)} a frame`);
    },
    onError(message) {
      say(`Stopped: ${message}.`);
      runStat.set('stopped');
      if (firstFrame) firstFrame();
    },
  });

  async function race() {
    raceBtn.disabled = true;
    say('Racing…');
    const r = await runner.bench(good ? source : EXAMPLES[0].source, { optimise });
    lines.pop();
    if (!r.ok) say(`The race was stopped: ${r.error}.`);
    else if (r.wasmMs == null) say(`${r.name}(): interpreter ${ms(r.interpMs)}. WebAssembly is blocked here, so there is nothing to race.`);
    else say(`${r.name}(): WebAssembly ${ms(r.wasmMs)} · interpreter ${ms(r.interpMs)} · ${Math.max(1, Math.round(r.interpMs / Math.max(r.wasmMs, 0.01)))}× faster`);
    raceBtn.disabled = false;
  }

  /* ── compiling ── */
  function showError(error) {
    errorLine = error.line;
    diag.hidden = false;
    diag.textContent = '';
    diag.append(
      el('p', { class: 'language-diag-msg' }, `Line ${error.line}, column ${error.col}: ${error.message}.`),
      error.hint ? el('p', { class: 'language-diag-hint' }, `${error.hint[0].toUpperCase()}${error.hint.slice(1)}.`) : null,
      el('pre', { class: 'language-diag-src' }, error.excerpt),
      good ? el('p', { class: 'language-diag-note' }, 'The last version that compiled is still running.') : null,
    );
  }

  function rebuild() {
    const result = compile(source, { optimise });
    if (result.ok) {
      good = result;
      decoded = null;
      errorLine = 0;
      diag.hidden = true;
      compileStat.set(ms(result.ms));
      sizeStat.set(`${result.bytes.length.toLocaleString('en-US')} bytes`);
      paintTab();
      runner.load(source, { optimise }, anim.time);
    } else showError(result.error);
    paintGutter();
  }

  /* ── editor painting ── */
  function paintGutter() {
    const count = source.split('\n').length;
    while (gutter.childElementCount < count) gutter.append(el('span', null, String(gutter.childElementCount + 1)));
    while (gutter.childElementCount > count) gutter.lastChild.remove();
    for (let i = 0; i < count; i++) gutter.children[i].className = i + 1 === errorLine ? 'language-bad' : '';
  }
  function paintSource() {
    colour.innerHTML = `${highlight(source)}\n`;
    paintGutter();
  }
  function syncScroll() {
    colour.style.transform = `translate(${-input.scrollLeft}px, ${-input.scrollTop}px)`;
    gutter.style.transform = `translateY(${-input.scrollTop}px)`;
  }
  function edited() {
    source = input.value;
    paintSource();
    clearTimeout(timer);
    timer = setTimeout(rebuild, 220);
  }
  function setSource(text) {
    source = text;
    input.value = text;
    input.scrollTop = 0;
    input.scrollLeft = 0;
    syncScroll();
    paintSource();
    clearTimeout(timer);
    rebuild();
  }
  let tabLeaves = false; // Escape, then Tab, moves focus on instead of indenting
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Tab' && !e.shiftKey && !tabLeaves) {
      e.preventDefault();
      input.setRangeText('  ', input.selectionStart, input.selectionEnd, 'end');
      edited();
    }
    tabLeaves = e.key === 'Escape';
  });
  input.addEventListener('input', edited);
  input.addEventListener('scroll', syncScroll);

  /* ── views of the binary ── */
  function paintTab() {
    if (tab === 'output' || !good) return;
    if (!decoded) decoded = disassemble(good.bytes, good.funcNames);
    if (tab === 'wat') panes.wat.textContent = `;; ${decoded.instructions.toLocaleString('en-US')} instructions, decoded from the ${good.bytes.length.toLocaleString('en-US')} bytes the compiler just emitted\n${decoded.text}`;
    else {
      const bytes = good.bytes;
      const shown = Math.min(bytes.length, BYTE_LIMIT);
      let html = '';
      decoded.sections.forEach((s, i) => {
        for (let p = s.offset; p < Math.min(s.offset + s.size, shown); p++) html += `<i class="language-s${i % 6}">${bytes[p].toString(16).padStart(2, '0')}</i>`;
      });
      const hex = el('div', { class: 'language-hex' });
      hex.innerHTML = html;
      panes.bytes.textContent = '';
      panes.bytes.append(
        el('ul', { class: 'language-legend', role: 'list' }, decoded.sections.map((s, i) => el('li', null, el('i', { class: `language-s${i % 6}` }), `${s.name} ${s.size.toLocaleString('en-US')}`))),
        hex,
        bytes.length > shown ? el('p', { class: 'language-more' }, `and ${(bytes.length - shown).toLocaleString('en-US')} more bytes`) : null,
      );
    }
  }
  function showTab(id) {
    tab = id;
    TABS.forEach((t, i) => {
      tabButtons[i].setAttribute('aria-selected', String(t.id === id));
      panes[t.id].hidden = t.id !== id;
    });
    paintTab();
  }

  /* ── lifecycle ── */
  const anim = loop((dt, t) => {
    if (runner.hasFrame && !runner.busy) runner.frame(t);
  });

  input.value = source;
  paintSource();
  // complete at rest: wait (briefly) for the first picture before mount resolves
  const painted = new Promise((resolve) => {
    firstFrame = () => {
      firstFrame = null;
      resolve();
    };
  });
  rebuild();
  await Promise.race([painted, new Promise((resolve) => setTimeout(resolve, 2500))]);

  return {
    start: () => anim.start(),
    stop: () => anim.stop(),
    destroy() {
      anim.stop();
      clearTimeout(timer);
      runner.dispose();
    },
  };
}
