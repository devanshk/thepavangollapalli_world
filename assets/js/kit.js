// kit.js — the small shared toolkit every exhibit builds on.
// No dependencies. Nothing here touches the DOM at import time, so the pure
// helpers (rng, clamp, …) are safe to import from Node tests as well.

/* ───────────────────────────── math ───────────────────────────── */

export const TAU = Math.PI * 2;
export const clamp = (x, lo = 0, hi = 1) => (x < lo ? lo : x > hi ? hi : x);
export const lerp = (a, b, t) => a + (b - a) * t;
export const smoothstep = (a, b, x) => {
  const t = clamp((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};

/** Deterministic PRNG (mulberry32). `const r = rng(42); r(); r.int(6); r.range(a, b); r.pick(arr)` */
export function rng(seed = 1) {
  let s = seed >>> 0;
  const next = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  next.int = (n) => Math.floor(next() * n);
  next.range = (a, b) => a + (b - a) * next();
  next.pick = (arr) => arr[Math.floor(next() * arr.length)];
  next.gauss = () => {
    // Box–Muller, one value per call
    const u = Math.max(next(), 1e-12);
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(TAU * next());
  };
  return next;
}

/** FNV-1a hash of a string → uint32. Handy for turning a text seed into a number. */
export function hashString(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/* ───────────────────────────── DOM ───────────────────────────── */

let uidCounter = 0;
export const uid = (prefix = 'k') => `${prefix}-${(++uidCounter).toString(36)}`;

/**
 * Tiny hyperscript. el('button', { class: 'x', onClick: fn, 'aria-label': 'Go' }, 'Go')
 * Props: class, style (object or string), dataset (object), on<Event> functions,
 * anything else is set as a property when the element has one, otherwise as an attribute.
 */
export function el(tag, props, ...kids) {
  const node = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'class') node.className = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
      else if (k === 'dataset') Object.assign(node.dataset, v);
      else if (k.length > 2 && k.startsWith('on') && typeof v === 'function')
        node.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k.includes('-') || k === 'for' || k === 'role' || k === 'list' || !(k in node))
        node.setAttribute(k, v === true ? '' : String(v));
      else node[k] = v;
    }
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    node.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return node;
}

const cssLoads = new Map();
/** Inject a stylesheet once. Pass `new URL('./style.css', import.meta.url)`. Resolves when applied. */
export function loadCSS(url) {
  const href = String(url);
  if (cssLoads.has(href)) return cssLoads.get(href);
  const p = new Promise((resolve) => {
    const link = el('link', { rel: 'stylesheet', href });
    link.addEventListener('load', () => resolve(true));
    link.addEventListener('error', () => resolve(false));
    document.head.append(link);
  });
  cssLoads.set(href, p);
  return p;
}

/** Read a design token as a string, e.g. cssVar(root, '--st-accent') → '#ffc66b'. */
export function cssVar(node, name) {
  return getComputedStyle(node).getPropertyValue(name).trim();
}

export const prefersReducedMotion = () =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
export const isCoarse = () => typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;

/* ───────────────────────────── view (canvas) ───────────────────────────── */

/**
 * A responsive canvas that keeps its backing store matched to its CSS box × devicePixelRatio.
 *
 *   const v = view(root, { aspect: 16 / 9, aspectNarrow: 1, label: 'Path-traced scene' });
 *   v.onResize(({ w, h, pw, ph, dpr }) => { … });   // w,h = CSS px · pw,ph = backing-store px
 *   const ctx = v.canvas.getContext('2d');
 *
 * Options: aspect (wide screens), aspectNarrow (viewports ≤ 640px), maxDpr (default 2),
 * scale (multiplier on backing resolution, for heavy shaders), pixelated, label (aria-label).
 * v.setScale(s) changes the resolution multiplier later (adaptive quality).
 * v.wrap is the positioned container: append overlays/HUD elements to it.
 */
export function view(root, opts = {}) {
  const { aspect = 16 / 9, aspectNarrow = aspect, maxDpr = 2, scale = 1, pixelated = false, label = '' } = opts;
  const canvas = el('canvas', { class: 'kit-canvas' + (pixelated ? ' kit-canvas--pixelated' : '') });
  if (label) {
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', label);
  }
  const wrap = el('div', { class: 'kit-view' }, canvas);
  wrap.style.setProperty('--kit-aspect', String(aspect));
  wrap.style.setProperty('--kit-aspect-narrow', String(aspectNarrow));

  const listeners = new Set();
  let cur = { w: 0, h: 0, pw: 0, ph: 0, dpr: 1 };
  let curScale = scale;

  function measure() {
    const w = wrap.clientWidth;
    const h = wrap.clientHeight;
    if (!w || !h) return;
    const dpr = Math.min(window.devicePixelRatio || 1, maxDpr);
    const pw = Math.max(1, Math.round(w * dpr * curScale));
    const ph = Math.max(1, Math.round(h * dpr * curScale));
    if (pw === cur.pw && ph === cur.ph && w === cur.w && h === cur.h) return;
    if (canvas.width !== pw) canvas.width = pw;
    if (canvas.height !== ph) canvas.height = ph;
    cur = { w, h, pw, ph, dpr: (dpr * curScale) };
    for (const fn of listeners) fn(cur);
  }

  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null;
  root.append(wrap);
  if (ro) ro.observe(wrap);
  measure();

  return {
    wrap,
    canvas,
    get size() {
      return cur;
    },
    /** Subscribe to size changes; called immediately if a size is already known. Returns unsubscribe. */
    onResize(fn) {
      listeners.add(fn);
      if (cur.w) fn(cur);
      return () => listeners.delete(fn);
    },
    setScale(s) {
      curScale = s;
      measure();
    },
    measure,
    destroy() {
      if (ro) ro.disconnect();
      listeners.clear();
    },
  };
}

/* ───────────────────────────── animation loop ───────────────────────────── */

/**
 * requestAnimationFrame loop with start/stop. fn(dt, t): dt is seconds since the previous
 * frame clamped to 50 ms, t is seconds of accumulated running time (pauses don't count).
 */
export function loop(fn) {
  let raf = 0;
  let last = 0;
  let t = 0;
  let running = false;
  const tick = (now) => {
    if (!running) return;
    const dt = Math.min(Math.max((now - last) / 1000, 0), 0.05);
    last = now;
    t += dt;
    try {
      fn(dt, t);
    } catch (err) {
      running = false;
      throw err;
    }
    if (running) raf = requestAnimationFrame(tick);
  };
  return {
    start() {
      if (running) return;
      running = true;
      last = performance.now();
      raf = requestAnimationFrame(tick);
    },
    stop() {
      running = false;
      cancelAnimationFrame(raf);
    },
    get running() {
      return running;
    },
    get time() {
      return t;
    },
  };
}

/* ───────────────────────────── pointer input ───────────────────────────── */

/**
 * Unified mouse / touch / pen input for a canvas or any element.
 *
 *   const off = pointer(v.canvas, {
 *     down(p) {}, move(p) {}, up(p) {},      // p: { x, y, nx, ny, dx, dy, w, h, id, type, buttons, shift, alt, ctrl, event }
 *     hover(p) {},                            // mouse moving with no button held
 *     leave() {},
 *     pinch({ factor, x, y }) {},             // two-finger pinch, or ctrl/⌘ + wheel (trackpad pinch)
 *   });
 *
 * x,y are CSS pixels relative to the element; nx,ny are 0..1; dx,dy are CSS-pixel deltas since the
 * previous event of the same pointer. Plain wheel is never captured — the page keeps scrolling.
 * The element gets `touch-action: none` so drags reach the exhibit instead of scrolling the page
 * (override with opts.touchAction, e.g. 'pan-y').
 */
export function pointer(target, handlers = {}, opts = {}) {
  const h = handlers;
  const active = new Map();
  const prevTouch = target.style.touchAction;
  target.style.touchAction = opts.touchAction || 'none';

  const pos = (e, prev) => {
    const r = target.getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    return {
      x,
      y,
      nx: r.width ? x / r.width : 0,
      ny: r.height ? y / r.height : 0,
      dx: prev ? x - prev.x : 0,
      dy: prev ? y - prev.y : 0,
      w: r.width,
      h: r.height,
      id: e.pointerId,
      type: e.pointerType || 'mouse',
      buttons: e.buttons,
      button: e.button,
      shift: e.shiftKey,
      alt: e.altKey,
      ctrl: e.ctrlKey || e.metaKey,
      event: e,
    };
  };
  const pinchDist = () => {
    const [a, b] = [...active.values()];
    return Math.hypot(a.x - b.x, a.y - b.y);
  };

  const onDown = (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0 && !opts.allButtons) return;
    try {
      target.setPointerCapture(e.pointerId);
    } catch {}
    const p = pos(e);
    active.set(e.pointerId, p);
    if (active.size === 1 && h.down) h.down(p);
    if (active.size === 2 && h.up && h.pinch) {
      // second finger: end the drag, begin a pinch
      h.up(p);
    }
  };
  const onMove = (e) => {
    const prev = active.get(e.pointerId);
    if (!prev) {
      if (h.hover && e.pointerType !== 'touch') h.hover(pos(e));
      return;
    }
    if (active.size === 2 && h.pinch) {
      const before = pinchDist();
      const p = pos(e, prev);
      active.set(e.pointerId, p);
      const after = pinchDist();
      const [a, b] = [...active.values()];
      if (before > 0 && after > 0) h.pinch({ factor: after / before, x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
      return;
    }
    const p = pos(e, prev);
    active.set(e.pointerId, p);
    if (active.size === 1 && h.move) h.move(p);
  };
  const onUp = (e) => {
    const prev = active.get(e.pointerId);
    if (!prev) return;
    const wasSingle = active.size === 1;
    active.delete(e.pointerId);
    if (wasSingle && h.up) h.up(pos(e, prev));
  };
  const onLeave = () => {
    if (!active.size && h.leave) h.leave();
  };
  const onWheel = (e) => {
    if (!h.pinch || !(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    const r = target.getBoundingClientRect();
    h.pinch({ factor: Math.exp(-e.deltaY * 0.01), x: e.clientX - r.left, y: e.clientY - r.top });
  };

  target.addEventListener('pointerdown', onDown);
  target.addEventListener('pointermove', onMove);
  target.addEventListener('pointerup', onUp);
  target.addEventListener('pointercancel', onUp);
  target.addEventListener('pointerleave', onLeave);
  target.addEventListener('wheel', onWheel, { passive: false });

  return () => {
    target.style.touchAction = prevTouch;
    target.removeEventListener('pointerdown', onDown);
    target.removeEventListener('pointermove', onMove);
    target.removeEventListener('pointerup', onUp);
    target.removeEventListener('pointercancel', onUp);
    target.removeEventListener('pointerleave', onLeave);
    target.removeEventListener('wheel', onWheel);
  };
}

/* ───────────────────────────── controls ───────────────────────────── */

/** A wrapping row of controls. bar(root) appends and returns it; add children with .append(). */
export function bar(root, ...kids) {
  const node = el('div', { class: 'kit-bar' }, kids);
  if (root) root.append(node);
  return node;
}

/** Visually groups a few controls so they wrap together. */
export const group = (...kids) => el('div', { class: 'kit-group' }, kids);

/** Flexible gap that pushes following controls to the right edge of a bar. */
export const spacer = () => el('div', { class: 'kit-spacer', 'aria-hidden': 'true' });

/** Small muted helper text, e.g. hint('Drag to orbit · pinch to zoom'). */
export const hint = (text) => el('span', { class: 'kit-hint' }, text);

/** button({ label, onClick, kind: 'primary' | 'ghost' | undefined, title }) → <button> with .setLabel(text) */
export function button({ label, onClick, kind, title, id } = {}) {
  const node = el(
    'button',
    { type: 'button', class: 'kit-btn' + (kind ? ` kit-btn--${kind}` : ''), id: id || uid('btn'), title },
    label,
  );
  if (onClick) node.addEventListener('click', onClick);
  node.setLabel = (text) => {
    node.textContent = text;
  };
  return node;
}

/** toggle({ label, value, onChange }) → switch element with a .value property */
export function toggle({ label, value = false, onChange, id } = {}) {
  let on = !!value;
  const node = el(
    'button',
    { type: 'button', class: 'kit-toggle', role: 'switch', 'aria-checked': String(on), id: id || uid('tg') },
    el('span', { class: 'kit-toggle-track', 'aria-hidden': 'true' }, el('span', { class: 'kit-toggle-thumb' })),
    el('span', { class: 'kit-toggle-label' }, label),
  );
  node.addEventListener('click', () => {
    on = !on;
    node.setAttribute('aria-checked', String(on));
    if (onChange) onChange(on);
  });
  Object.defineProperty(node, 'value', {
    get: () => on,
    set: (v) => {
      on = !!v;
      node.setAttribute('aria-checked', String(on));
    },
  });
  return node;
}

/** slider({ label, min, max, step, value, format, onInput }) → labelled range with a .value property */
export function slider({ label, min = 0, max = 1, step = 0.01, value = min, format = String, onInput, id } = {}) {
  const input = el('input', { type: 'range', class: 'kit-range', id: id || uid('sl') });
  input.min = min;
  input.max = max;
  input.step = step;
  input.value = value;
  const out = el('output', { class: 'kit-out', for: input.id });
  const node = el('label', { class: 'kit-slider' }, el('span', { class: 'kit-label' }, label), input, out);
  const paint = () => {
    const p = (100 * (+input.value - +input.min)) / (+input.max - +input.min || 1);
    input.style.setProperty('--p', `${p}%`);
    out.textContent = format(+input.value);
  };
  input.addEventListener('input', () => {
    paint();
    if (onInput) onInput(+input.value);
  });
  paint();
  Object.defineProperty(node, 'value', {
    get: () => +input.value,
    set: (v) => {
      input.value = v;
      paint();
    },
  });
  node.input = input;
  return node;
}

/** segmented({ label, options: [{ value, label }] | ['a','b'], value, onChange }) → radio pills with .value */
export function segmented({ label, options = [], value, onChange } = {}) {
  const opts = options.map((o) => (typeof o === 'object' ? o : { value: o, label: String(o) }));
  let current = value ?? (opts[0] && opts[0].value);
  const buttons = opts.map((o) =>
    el(
      'button',
      {
        type: 'button',
        class: 'kit-seg-btn',
        role: 'radio',
        id: uid('seg'),
        'aria-checked': String(o.value === current),
        onClick: () => {
          if (current === o.value) return;
          set(o.value);
          if (onChange) onChange(current);
        },
      },
      o.label,
    ),
  );
  const set = (v) => {
    current = v;
    buttons.forEach((b, i) => b.setAttribute('aria-checked', String(opts[i].value === v)));
  };
  const node = el(
    'div',
    { class: 'kit-seg', role: 'radiogroup', 'aria-label': label || undefined },
    label ? el('span', { class: 'kit-label' }, label) : null,
    el('div', { class: 'kit-seg-track' }, buttons),
  );
  Object.defineProperty(node, 'value', { get: () => current, set });
  return node;
}

/** select({ label, options: [{ value, label }] | ['a','b'], value, onChange }) → native select with .value */
export function select({ label, options = [], value, onChange, id } = {}) {
  const opts = options.map((o) => (typeof o === 'object' ? o : { value: o, label: String(o) }));
  const sel = el(
    'select',
    { class: 'kit-select-input', id: id || uid('sel') },
    opts.map((o) => el('option', { value: String(o.value) }, o.label)),
  );
  if (value != null) sel.value = String(value);
  sel.addEventListener('change', () => onChange && onChange(sel.value));
  const node = el('label', { class: 'kit-select' }, label ? el('span', { class: 'kit-label' }, label) : null, sel);
  Object.defineProperty(node, 'value', {
    get: () => sel.value,
    set: (v) => {
      sel.value = String(v);
    },
  });
  node.input = sel;
  return node;
}

/** stat({ label, value }) → compact read-out with .set(text). Use for fps, sample counts, energy, … */
export function stat({ label, value = '—' } = {}) {
  const val = el('span', { class: 'kit-stat-value' }, value);
  const node = el('div', { class: 'kit-stat' }, el('span', { class: 'kit-label' }, label), val);
  node.set = (text) => {
    const s = String(text);
    if (val.textContent !== s) val.textContent = s;
  };
  return node;
}

/**
 * Centered message over a view — for "Tap to start sound", "WebGL2 is not available", etc.
 * overlay(v.wrap, { title, text, action: { label, onClick } }) → { node, remove() }
 */
export function overlay(wrap, { title, text, action } = {}) {
  const node = el(
    'div',
    { class: 'kit-overlay' },
    el(
      'div',
      { class: 'kit-overlay-card' },
      title ? el('p', { class: 'kit-overlay-title' }, title) : null,
      text ? el('p', { class: 'kit-overlay-text' }, text) : null,
      action ? button({ label: action.label, kind: 'primary', onClick: action.onClick }) : null,
    ),
  );
  wrap.append(node);
  return { node, remove: () => node.remove() };
}

/** Smoothed frames-per-second meter: const fps = fpsMeter(); fps.tick(dt) → number */
export function fpsMeter() {
  let avg = 1 / 60;
  return {
    tick(dt) {
      if (dt > 0) avg = lerp(avg, dt, 0.05);
      return 1 / avg;
    },
  };
}
