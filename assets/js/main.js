// main.js — the page shell. It mounts each exhibit when the visitor scrolls near it, runs it only
// while it is on screen, and drives the "run the tests yourself" panel.

import { runSuite } from './check.js';

const NAMES = {
  light: 'Light',
  world: 'World',
  flow: 'Flow',
  motion: 'Motion',
  sound: 'Sound',
  language: 'Language',
  reason: 'Reason',
  learning: 'Learning',
};

const media = (q) => typeof matchMedia === 'function' && matchMedia(q).matches;
const env = {
  reducedMotion: media('(prefers-reduced-motion: reduce)'),
  coarse: media('(pointer: coarse)'),
  small: window.innerWidth <= 640,
};

const h = (tag, attrs = {}, ...kids) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids) if (kid != null) node.append(kid);
  return node;
};

/* ───────────────────────── exhibits ───────────────────────── */

class Slot {
  constructor(section) {
    this.section = section;
    this.id = section.dataset.exhibit;
    this.stage = section.querySelector('[data-stage]');
    this.state = 'idle'; // idle → loading → ready | failed
    this.ctl = null;
    this.near = false;
    this.visible = false;
    this.running = false;
    // With reduced motion, nothing animates until the visitor asks for it.
    this.allowed = !env.reducedMotion;
    this.stage.dataset.state = 'idle';
  }

  async load() {
    if (this.state !== 'idle') return;
    this.state = 'loading';
    this.stage.dataset.state = 'loading';
    try {
      const mod = await import(`../../exhibits/${this.id}/index.js`);
      this.stage.textContent = '';
      this.ctl = await mod.mount(this.stage, env);
      this.state = 'ready';
      this.stage.dataset.state = 'ready';
      if (!this.allowed) this.gate();
      this.sync();
    } catch (err) {
      this.state = 'failed';
      this.stage.dataset.state = 'failed';
      this.stage.textContent = '';
      this.stage.append(
        h(
          'div',
          { class: 'stage-note', role: 'status' },
          h('p', { class: 'stage-note-title', text: `${NAMES[this.id] || this.id} could not start on this device.` }),
          h('p', { class: 'stage-note-text', text: String((err && err.message) || err) }),
        ),
      );
      console.error(`[${this.id}]`, err);
    }
  }

  /** Reduced-motion gate: a still frame is showing; one tap starts the exhibit. */
  gate() {
    const btn = h('button', { type: 'button', class: 'stage-gate-btn', text: 'Start this exhibit' });
    const gate = h('div', { class: 'stage-gate' }, btn);
    btn.addEventListener('click', () => {
      this.allowed = true;
      gate.remove();
      this.sync();
    });
    this.stage.append(gate);
  }

  sync() {
    if (this.state !== 'ready') return;
    const shouldRun = this.visible && this.allowed && !document.hidden;
    if (shouldRun === this.running) return;
    this.running = shouldRun;
    try {
      if (shouldRun) this.ctl.start();
      else this.ctl.stop();
    } catch (err) {
      console.error(`[${this.id}]`, err);
    }
  }
}

const slots = [...document.querySelectorAll('section[data-exhibit]')]
  .filter((s) => s.querySelector('[data-stage]'))
  .map((s) => new Slot(s));
const slotOf = new Map(slots.map((s) => [s.stage, s]));

if ('IntersectionObserver' in window) {
  // Load a little before an exhibit arrives…
  const nearObserver = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        const slot = slotOf.get(e.target);
        if (e.isIntersecting && slot) {
          slot.near = true;
          slot.load();
        }
      }
    },
    { rootMargin: '75% 0px 75% 0px' },
  );
  // …and run it only while a real part of it is on screen.
  const visibleObserver = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        const slot = slotOf.get(e.target);
        if (!slot) continue;
        slot.visible = e.isIntersecting;
        slot.sync();
      }
    },
    { threshold: 0.12 },
  );
  for (const s of slots) {
    nearObserver.observe(s.stage);
    visibleObserver.observe(s.stage);
  }
} else {
  for (const s of slots) {
    s.visible = true;
    s.load();
  }
}

document.addEventListener('visibilitychange', () => slots.forEach((s) => s.sync()));

// Safari has no scroll anchoring: when an exhibit above the viewport finishes loading and its
// height changes, keep the visitor's place by hand.
if (typeof ResizeObserver === 'function' && !(window.CSS && CSS.supports && CSS.supports('overflow-anchor', 'auto'))) {
  const heights = new WeakMap();
  const anchor = new ResizeObserver((entries) => {
    let shift = 0;
    for (const e of entries) {
      const before = heights.get(e.target);
      const now = e.contentRect.height;
      heights.set(e.target, now);
      if (before != null && now !== before && e.target.getBoundingClientRect().bottom < 0) shift += now - before;
    }
    if (shift) window.scrollBy(0, shift);
  });
  for (const s of slots) anchor.observe(s.stage);
}

/* ───────────────────────── navigation ───────────────────────── */

const navLinks = [...document.querySelectorAll('[data-nav] a[href^="#"]')];
if (navLinks.length && 'IntersectionObserver' in window) {
  const byId = new Map();
  for (const a of navLinks) {
    const id = a.getAttribute('href').slice(1);
    if (!byId.has(id)) byId.set(id, []);
    byId.get(id).push(a);
  }
  const seen = new Map();
  const mark = () => {
    let best = null;
    for (const [id, ratio] of seen) if (ratio > 0 && (!best || ratio > best[1])) best = [id, ratio];
    for (const [id, links] of byId)
      for (const a of links) {
        if (best && best[0] === id) a.setAttribute('aria-current', 'true');
        else a.removeAttribute('aria-current');
      }
  };
  const spy = new IntersectionObserver(
    (entries) => {
      for (const e of entries) seen.set(e.target.id, e.isIntersecting ? e.intersectionRatio : 0);
      mark();
    },
    { rootMargin: '-35% 0px -45% 0px', threshold: [0, 0.01, 0.25, 0.5, 1] },
  );
  for (const id of byId.keys()) {
    const target = document.getElementById(id);
    if (target) spy.observe(target);
  }
}

/* ───────────────────────── proof: run every test in this browser ───────────────────────── */

const proofRoot = document.querySelector('[data-proof]');
const proofRun = document.querySelector('[data-proof-run]');
const proofSummary = document.querySelector('[data-proof-summary]');

if (proofRoot && proofRun) {
  const suites = [...proofRoot.querySelectorAll('[data-suite]')].map((node) => ({
    id: node.dataset.suite,
    node,
    marks: node.querySelector('[data-marks]'),
    count: node.querySelector('[data-count]'),
    detail: node.querySelector('[data-detail]'),
  }));

  const setSummary = (text, state) => {
    if (!proofSummary) return;
    proofSummary.textContent = text;
    if (state) proofSummary.dataset.state = state;
  };

  const paintMarks = (suite, tests) => {
    suite.marks.textContent = '';
    return tests.map((t) => {
      const m = h('i', { class: 'proof-mark', 'data-state': 'pending', title: t.name });
      suite.marks.append(m);
      return m;
    });
  };

  async function runAll() {
    proofRun.disabled = true;
    proofRoot.dataset.state = 'running';
    let passed = 0;
    let failed = 0;
    const t0 = performance.now();
    for (const suite of suites) {
      suite.node.dataset.state = 'running';
      if (suite.detail) suite.detail.textContent = '';
      setSummary(`Running ${NAMES[suite.id] || suite.id}…`, 'running');
      try {
        const mod = await import(`../../exhibits/${suite.id}/tests.js`);
        const tests = mod.default;
        const marks = paintMarks(suite, tests);
        // Yield between tests so marks paint as they finish and the page stays responsive.
        const res = await runSuite(tests, {
          browser: true,
          onResult: (r, i) => {
            marks[i].dataset.state = r.ok ? 'pass' : 'fail';
            if (!r.ok) marks[i].title = `${r.name} — ${r.error}`;
          },
          between: () => new Promise((resolve) => setTimeout(resolve, 0)),
        });
        passed += res.passed;
        failed += res.failed;
        suite.node.dataset.state = res.failed ? 'fail' : 'pass';
        if (suite.count) suite.count.textContent = `${res.passed}/${tests.length}`;
        if (res.failed && suite.detail) {
          for (const r of res.results.filter((x) => !x.ok))
            suite.detail.append(h('p', { class: 'proof-failure', text: `${r.name}: ${r.error}` }));
        }
      } catch (err) {
        failed += 1;
        suite.node.dataset.state = 'fail';
        if (suite.detail) suite.detail.append(h('p', { class: 'proof-failure', text: `Could not load this suite: ${err.message || err}` }));
      }
    }
    const secs = ((performance.now() - t0) / 1000).toFixed(1);
    proofRoot.dataset.state = failed ? 'fail' : 'pass';
    setSummary(`${passed} passed · ${failed} failed · ${secs} s on this device`, failed ? 'fail' : 'pass');
    proofRun.disabled = false;
    proofRun.textContent = 'Run them again';
  }

  proofRun.addEventListener('click', runAll);
}

window.__ready = true;
