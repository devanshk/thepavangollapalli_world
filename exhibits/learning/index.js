// LEARNING — a small neural network learns a picture as a function from (x, y) to colour.
// This file is the DOM layer: layout, controls and drawing. The numerics live in net.js and
// trainer.js and run in a Worker (worker.js) or, failing that, in slices on the main thread.
import { el, loadCSS, view, bar, group, spacer, button, toggle, slider, segmented, stat, pointer, cssVar, clamp, lerp } from '../../assets/js/kit.js';
import { createEngine } from './engine.js';
import { createHistory } from './history.js';
import { drawChart } from './chart.js';
import { TARGETS, INKS, paintTarget, clearPaper } from './targets.js';

const N = 128; // training resolution, pixels per side
const LENS_PX = 12; // side of the zoom patch, in target pixels
const FEATURES = 32; // random Fourier features; the encoded input has twice as many values
const BATCH = 1024;
const WARMUP = 30; // steps trained before the first frame is shown
const TILES = 12;
const READY_TIMEOUT_MS = 8000;
const SIZES = { small: [32, 32], medium: [64, 64, 64], large: [96, 96, 96, 96] };
const SIZE_OPTIONS = [
  { value: 'small', label: '2 × 32' },
  { value: 'medium', label: '3 × 64' },
  { value: 'large', label: '4 × 96' },
];
const BRUSHES = [
  { value: 3, label: 'Fine' },
  { value: 8, label: 'Medium' },
  { value: 18, label: 'Broad' },
];

const formatCount = (n) => n.toLocaleString('en-US');
const formatLoss = (x) => (x < 1e-4 ? x.toExponential(1) : x.toFixed(4));
const head = (title, sub) =>
  el('div', { class: 'learning-head' }, el('span', { class: 'learning-title' }, title), typeof sub === 'string' ? el('span', { class: 'learning-sub' }, sub) : sub);

export async function mount(root, env) {
  await loadCSS(new URL('./style.css', import.meta.url));

  const settings = { target: 'scene', encoding: true, scale: 10, size: 'medium', activation: 'relu', lr: 0.01, seed: 7 };
  const state = { visible: false, userPaused: false, halted: null, mode: 'pending', configId: 0, step: 0, sentRun: null, frameSeen: false };
  const history = createHistory(512);
  const serif = cssVar(root, '--font-serif');
  const theme = {
    bg: cssVar(root, '--st-bg'),
    line: cssVar(root, '--st-line'),
    muted: cssVar(root, '--st-muted'),
    accent: cssVar(root, '--st-accent'),
    mono: cssVar(root, '--font-mono') || 'monospace',
  };
  // Any CSS colour → [r, g, b], by letting a canvas resolve it.
  const probe = el('canvas', { width: 1, height: 1 }).getContext('2d', { willReadFrequently: true });
  const rgbOf = (color) => {
    probe.fillStyle = color;
    probe.fillRect(0, 0, 1, 1);
    return Array.from(probe.getImageData(0, 0, 1, 1).data.subarray(0, 3));
  };
  const palette = { zero: rgbOf(theme.bg), positive: rgbOf(theme.accent), negative: rgbOf(cssVar(root, '--st-c4')) };

  /* ── picture panels ── */
  const targetCanvas = el('canvas', { class: 'learning-img', width: N, height: N, role: 'img', 'aria-label': 'Target picture the network is trained on' });
  const outputCanvas = el('canvas', { class: 'learning-img learning-output', width: N, height: N, role: 'img', 'aria-label': 'Picture produced by the neural network' });
  const targetCtx = targetCanvas.getContext('2d', { willReadFrequently: true });
  const outputCtx = outputCanvas.getContext('2d');
  const lensBoxes = [el('div', { class: 'learning-lensbox' }), el('div', { class: 'learning-lensbox' })];
  const drawHint = el('div', { class: 'learning-drawhint', hidden: true }, 'Paint on the picture');
  const targetFrame = el('div', { class: 'learning-frame' }, targetCanvas, lensBoxes[0], drawHint);
  const outputFrame = el('div', { class: 'learning-frame' }, outputCanvas, lensBoxes[1]);

  let ink = INKS[2].color;
  let brush = BRUSHES[1].value;
  const swatches = INKS.map((item) =>
    el('button', {
      type: 'button',
      class: 'learning-swatch',
      'aria-label': `Paint with ${item.name}`,
      'aria-pressed': String(item.color === ink),
      style: { background: item.color },
      onClick: () => {
        ink = item.color;
        swatches.forEach((node, i) => node.setAttribute('aria-pressed', String(INKS[i].color === ink)));
      },
    }),
  );
  const tools = el(
    'div',
    { class: 'learning-tools', hidden: true },
    el('div', { class: 'learning-swatches', role: 'group', 'aria-label': 'Paint colour' }, swatches),
    segmented({ label: 'Brush', options: BRUSHES, value: brush, onChange: (value) => (brush = value) }),
    button({ label: 'Clear', onClick: () => { clearPaper(targetCtx, N); sendTarget(true); } }),
  );

  const outputSub = el('span', { class: 'learning-sub' });
  const targetPanel = el('figure', { class: 'learning-panel learning-panel--target' }, head('Target', `${N} × ${N} pixels`), targetFrame, tools);
  const outputPanel = el('figure', { class: 'learning-panel learning-panel--output' }, head('Network output', outputSub), outputFrame);

  /* ── loss card ── */
  const lossCard = el('div', { class: 'learning-card' }, head('Loss', 'mean squared error, log scale'));
  const chart = view(lossCard, { aspect: 2.5, aspectNarrow: 2.4, label: 'Training loss against step count, on a logarithmic axis' });
  const chartCtx = chart.canvas.getContext('2d');
  const stats = { step: stat({ label: 'Step', value: '0' }), sps: stat({ label: 'Steps/s' }), loss: stat({ label: 'Loss' }), psnr: stat({ label: 'PSNR' }) };
  lossCard.append(el('div', { class: 'learning-stats' }, stats.step, stats.sps, stats.loss, stats.psnr));

  /* ── zoom card ── */
  const lensTarget = el('canvas', { class: 'learning-lens-img learning-lens-pixels', width: 96, height: 96, role: 'img', 'aria-label': 'Magnified patch of the target pixels' });
  const lensNet = el('canvas', { class: 'learning-lens-img', width: 96, height: 96, role: 'img', 'aria-label': 'The same patch evaluated from the network between the pixels' });
  const lensTargetCtx = lensTarget.getContext('2d');
  const lensNetCtx = lensNet.getContext('2d');
  const lensNetCaption = el('figcaption', { class: 'learning-sub' }, 'Network');
  const lensCard = el(
    'div',
    { class: 'learning-card learning-card--lens' },
    head('Continuous zoom', `${LENS_PX} × ${LENS_PX} pixel patch`),
    el(
      'div',
      { class: 'learning-lens' },
      el('figure', { class: 'learning-lens-fig' }, lensTarget, el('figcaption', { class: 'learning-sub' }, 'Target pixels')),
      el('figure', { class: 'learning-lens-fig' }, lensNet, lensNetCaption),
    ),
    el('p', { class: 'learning-note' }, 'Drag on the network output to move the lens. The network is a function, so it can be evaluated between pixels.'),
  );

  /* ── hidden-unit strip ── */
  const tiles = Array.from({ length: TILES }, () => {
    const canvas = el('canvas', { class: 'learning-tile-img', width: N / 2, height: N / 2, 'aria-hidden': 'true' });
    const caption = el('figcaption', { class: 'learning-tile-cap' });
    return { canvas, caption, ctx: canvas.getContext('2d'), image: null, node: el('figure', { class: 'learning-tile' }, canvas, caption) };
  });
  const features = el(
    'div',
    { class: 'learning-features' },
    head('Hidden units', 'how strongly single units fire across the picture (L = layer)'),
    el('div', { class: 'learning-tiles', role: 'img', 'aria-label': 'Activation maps of twelve hidden units' }, tiles.map((tile) => tile.node)),
  );

  root.append(el('div', { class: 'learning-main' }, targetPanel, outputPanel, el('div', { class: 'learning-side' }, lossCard, lensCard), features));

  /* ── controls ── */
  const runButton = button({ label: 'Pause', kind: 'primary', onClick: toggleRun });
  const status = el('span', { class: 'kit-hint learning-status', role: 'status' });
  bar(
    root,
    segmented({ label: 'Target', options: TARGETS, value: settings.target, onChange: setTarget }),
    spacer(),
    status,
    group(runButton, button({ label: 'Reset weights', onClick: () => { settings.seed += 1; restart(); } })),
  );
  const scaleSlider = slider({ label: 'Frequency scale', min: 1, max: 30, step: 1, value: settings.scale });
  // Restart once when the thumb is released, not on every step of the drag.
  scaleSlider.input.addEventListener('change', () => {
    settings.scale = scaleSlider.value;
    if (settings.encoding) restart();
  });
  bar(
    root,
    toggle({
      label: 'Fourier features',
      value: settings.encoding,
      onChange: (on) => {
        settings.encoding = on;
        scaleSlider.input.disabled = !on;
        restart();
      },
    }),
    scaleSlider,
    segmented({ label: 'Network', options: SIZE_OPTIONS, value: settings.size, onChange: (value) => { settings.size = value; restart(); } }),
    segmented({
      label: 'Activation',
      options: [{ value: 'relu', label: 'ReLU' }, { value: 'tanh', label: 'tanh' }],
      value: settings.activation,
      onChange: (value) => { settings.activation = value; restart(); },
    }),
    slider({
      label: 'Learning rate',
      min: -4,
      max: -1.5,
      step: 0.25,
      value: Math.log10(settings.lr),
      format: (x) => String(Number((10 ** x).toPrecision(2))),
      onInput: (x) => {
        settings.lr = 10 ** x;
        engine.send({ type: 'lr', lr: settings.lr });
      },
    }),
  );

  /* ── drawing ── */
  const offscreen = () => {
    const canvas = el('canvas', { width: N, height: N });
    return { canvas, ctx: canvas.getContext('2d') };
  };
  const fade = { from: offscreen(), to: offscreen(), start: 0, duration: 0, last: 0 };
  let raf = 0;
  let chartDirty = true;
  let spsAverage = 0;

  // The output cross-fades from the previous prediction to the newest one between frames.
  function render(now) {
    raf = 0;
    const t = fade.duration > 0 ? clamp((now - fade.start) / fade.duration) : 1;
    outputCtx.globalAlpha = 1;
    outputCtx.drawImage(fade.from.canvas, 0, 0);
    outputCtx.globalAlpha = t;
    outputCtx.drawImage(fade.to.canvas, 0, 0);
    outputCtx.globalAlpha = 1;
    if (chartDirty && chart.size.pw) {
      chartDirty = false;
      drawChart(chartCtx, chart.size, history, theme);
    }
    if (t < 1 && state.visible) raf = requestAnimationFrame(render);
  }
  function refresh() {
    if (state.visible && fade.duration > 0) {
      if (!raf) raf = requestAnimationFrame(render);
    } else {
      fade.duration = 0;
      render(performance.now());
    }
  }

  function drawTiles(frame) {
    const side = frame.tileSize;
    const area = side * side;
    const { zero, positive, negative } = palette;
    tiles.forEach((tile, i) => {
      if (tile.canvas.width !== side) {
        tile.canvas.width = side;
        tile.canvas.height = side;
        tile.image = null;
      }
      if (!tile.image) tile.image = tile.ctx.createImageData(side, side);
      const px = tile.image.data;
      for (let p = 0; p < area; p++) {
        const v = frame.tiles[i * area + p];
        const toward = v >= 0 ? positive : negative;
        const amount = Math.abs(v);
        px[4 * p] = zero[0] + (toward[0] - zero[0]) * amount;
        px[4 * p + 1] = zero[1] + (toward[1] - zero[1]) * amount;
        px[4 * p + 2] = zero[2] + (toward[2] - zero[2]) * amount;
        px[4 * p + 3] = 255;
      }
      tile.ctx.putImageData(tile.image, 0, 0);
      const label = `L${frame.units[i].layer + 1} · ${frame.units[i].unit}`;
      if (tile.caption.textContent !== label) tile.caption.textContent = label;
    });
  }

  /* ── zoom lens ── */
  const lens = { cx: 0.73, cy: 0.5, busy: false, queued: false };
  const lensSpan = LENS_PX / N;
  const lensOrigin = () => ({
    x0: Math.round(clamp(lens.cx - lensSpan / 2, 0, 1 - lensSpan) * N) / N,
    y0: Math.round(clamp(lens.cy - lensSpan / 2, 0, 1 - lensSpan) * N) / N,
  });
  function drawLensTarget() {
    const { x0, y0 } = lensOrigin();
    lensTargetCtx.imageSmoothingEnabled = false;
    lensTargetCtx.drawImage(targetCanvas, x0 * N, y0 * N, LENS_PX, LENS_PX, 0, 0, lensTarget.width, lensTarget.height);
  }
  function requestLens() {
    if (lens.busy) {
      lens.queued = true;
      return;
    }
    lens.busy = true;
    lens.queued = false;
    engine.send({ type: 'lens', ...lensOrigin(), span: lensSpan });
  }
  function placeLens() {
    const { x0, y0 } = lensOrigin();
    for (const box of lensBoxes) {
      box.style.left = `${x0 * 100}%`;
      box.style.top = `${y0 * 100}%`;
      box.style.width = `${lensSpan * 100}%`;
      box.style.height = `${lensSpan * 100}%`;
    }
    drawLensTarget();
    requestLens();
  }
  const moveLens = (p) => {
    lens.cx = clamp(p.nx);
    lens.cy = clamp(p.ny);
    placeLens();
  };
  const offLens = pointer(outputCanvas, { down: moveLens, move: moveLens });

  /* ── painting on the target ── */
  let offPaint = null;
  let lastPoint = null;
  let lastSent = 0;
  const readTarget = () => targetCtx.getImageData(0, 0, N, N).data;
  function sendTarget(force) {
    const t = performance.now();
    if (!force && t - lastSent < 80) return;
    lastSent = t;
    engine.send({ type: 'target', target: readTarget() });
    drawLensTarget();
  }
  function strokeTo(p) {
    const x = p.nx * N;
    const y = p.ny * N;
    targetCtx.lineCap = 'round';
    targetCtx.lineJoin = 'round';
    targetCtx.lineWidth = brush;
    targetCtx.strokeStyle = ink;
    targetCtx.beginPath();
    targetCtx.moveTo(lastPoint ? lastPoint.x : x - 0.01, lastPoint ? lastPoint.y : y);
    targetCtx.lineTo(x, y);
    targetCtx.stroke();
    lastPoint = { x, y };
    sendTarget(false);
  }
  const paintHandlers = {
    down(p) {
      drawHint.hidden = true;
      lastPoint = null;
      strokeTo(p);
    },
    move: strokeTo,
    up() {
      lastPoint = null;
      sendTarget(true);
    },
  };

  /* ── training state ── */
  function parameterCount() {
    const dims = [settings.encoding ? 2 * FEATURES : 2, ...SIZES[settings.size], 3];
    let count = 0;
    for (let l = 0; l + 1 < dims.length; l++) count += (dims[l] + 1) * dims[l + 1];
    return count;
  }

  function updateStatus() {
    let text = `Training ${state.mode === 'main' ? 'on the main thread, no worker available' : 'in a worker thread'}`;
    if (state.halted === 'budget') text = `Paused after ${formatCount(state.step)} steps to save power`;
    else if (state.halted === 'plateau') text = 'Paused: the loss has stopped improving';
    else if (state.userPaused) text = 'Paused';
    else if (!state.visible) text = 'Idle';
    if (status.textContent !== text) status.textContent = text;
    runButton.setLabel(state.halted ? 'Continue' : state.userPaused ? 'Resume' : 'Pause');
  }

  function syncRun(final) {
    const on = state.visible && !state.userPaused;
    if (on !== state.sentRun) {
      state.sentRun = on;
      engine.send({ type: 'run', on, final });
    }
    updateStatus();
  }

  function toggleRun() {
    if (state.halted) {
      state.halted = null;
      state.userPaused = false;
      engine.send({ type: 'continue' });
    } else state.userPaused = !state.userPaused;
    syncRun(true);
  }

  // Every setting that changes the network or the picture starts a fresh, cleanly seeded run.
  function restart() {
    state.configId += 1;
    state.halted = null;
    history.clear();
    spsAverage = 0;
    chartDirty = true;
    engine.send({
      type: 'config',
      id: state.configId,
      warmup: WARMUP,
      config: {
        size: N,
        hidden: SIZES[settings.size],
        activation: settings.activation,
        fourier: settings.encoding ? FEATURES : 0,
        scale: settings.scale,
        seed: settings.seed,
        batch: BATCH,
        lr: settings.lr,
      },
      target: readTarget(),
    });
    outputSub.textContent = `${formatCount(parameterCount())} parameters`;
    updateStatus();
  }

  function setTarget(kind) {
    settings.target = kind;
    const drawing = kind === 'draw';
    tools.hidden = !drawing;
    drawHint.hidden = !drawing;
    targetFrame.classList.toggle('learning-frame--draw', drawing);
    if (drawing) {
      // "Draw" keeps the current picture as the canvas; the network simply carries on learning.
      if (!offPaint) offPaint = pointer(targetCanvas, paintHandlers);
      return;
    }
    if (offPaint) {
      offPaint();
      offPaint = null;
    }
    paintTarget(targetCtx, N, kind, serif);
    drawLensTarget();
    restart();
  }

  function onFrame(frame) {
    state.step = frame.step;
    state.halted = frame.halted;
    state.frameSeen = true;
    for (let i = 0; i < frame.losses.length; i++) history.push(frame.losses[i]);
    if (frame.sps !== null) spsAverage = spsAverage ? lerp(spsAverage, frame.sps, 0.3) : frame.sps;
    stats.step.set(formatCount(frame.step));
    stats.sps.set(frame.training && spsAverage ? String(Math.round(spsAverage)) : '—');
    stats.loss.set(formatLoss(frame.mse));
    stats.psnr.set(frame.mse > 0 ? `${(-10 * Math.log10(frame.mse)).toFixed(1)} dB` : '—');

    const now = performance.now();
    fade.from.ctx.drawImage(outputCanvas, 0, 0);
    fade.to.ctx.putImageData(new ImageData(frame.image, N, N), 0, 0);
    fade.duration = env.reducedMotion || !state.visible ? 0 : clamp((now - fade.last) * 0.9, 60, 350);
    fade.start = now;
    fade.last = now;
    outputCanvas.dataset.step = String(frame.step);
    drawTiles(frame);
    chartDirty = true;
    updateStatus();
    requestLens();
    refresh();
  }

  function onLens(message) {
    lens.busy = false;
    if (message.id !== state.configId) {
      requestLens();
      return;
    }
    if (lensNet.width !== message.res) {
      lensNet.width = message.res;
      lensNet.height = message.res;
    }
    lensNetCtx.putImageData(new ImageData(message.image, message.res, message.res), 0, 0);
    lensNetCaption.textContent = `Network, sampled ${Number((message.res / LENS_PX).toFixed(1))}× finer`;
    if (lens.queued) requestLens();
    if (state.frameSeen) resolveReady();
  }

  let resolveReady;
  const ready = new Promise((resolve) => {
    resolveReady = resolve;
  });
  const readyTimer = setTimeout(resolveReady, READY_TIMEOUT_MS);

  const engine = createEngine((message) => {
    if (message.type === 'mode') {
      state.mode = message.mode;
      updateStatus();
    } else if (message.type === 'lens') onLens(message);
    else if (message.type === 'frame' && message.id === state.configId) onFrame(message);
  });

  const offResize = chart.onResize(() => {
    chartDirty = true;
    refresh();
  });
  paintTarget(targetCtx, N, settings.target, serif);
  restart();
  placeLens();
  await ready;
  clearTimeout(readyTimer);

  return {
    start() {
      if (state.visible) return;
      state.visible = true;
      syncRun(false);
    },
    stop() {
      if (!state.visible) return;
      state.visible = false;
      syncRun(false);
      cancelAnimationFrame(raf);
      raf = 0;
      refresh();
    },
    destroy() {
      state.visible = false;
      cancelAnimationFrame(raf);
      clearTimeout(readyTimer);
      engine.destroy();
      offLens();
      if (offPaint) offPaint();
      offResize();
      chart.destroy();
    },
  };
}
