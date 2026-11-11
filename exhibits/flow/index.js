// Flow — an incompressible fluid solved on the GPU. This file is the thin layer around the
// solver: controls, pointer strokes, the idle emitters, adaptive resolution and the frame loop.
import { view, bar, group, slider, segmented, button, stat, spacer, hint, loop, overlay, loadCSS, cssVar, el, clamp } from '../../assets/js/kit.js';
import { createGL, onContextLoss } from '../../assets/js/glkit.js';
import { createSolver, createSplats, VIEWS } from './gpu.js';
import { createDrawing, preset, stampLine, buildMask } from './shapes.js';
import { LEVELS, gridFor, levelForStepTime, createGovernor } from './quality.js';
import { touchColor, emitter, JET_COUNT, openingStroke, OPENING_STROKES } from './palette.js';
import { trackPointers } from './input.js';

const LABELS = {
  ink: 'Simulated fluid: coloured ink curling through a tank of water',
  tunnel: 'Simulated wind tunnel: flow from the left passing an obstacle and leaving a wake',
};
const LEGENDS = {
  dye: '',
  speed: 'Speed: dark is still, bright is fast',
  vorticity: 'Spin: blue is clockwise, orange is anticlockwise',
  pressure: 'Pressure: blue is low, orange is high',
};
const OMEGA = 1.8;

// A design token as linear RGB, whatever CSS colour syntax it is written in.
function tokenLinear(root, name) {
  const canvas = document.createElement('canvas');
  canvas.width = 1;
  canvas.height = 1;
  const ctx = canvas.getContext('2d');
  if (!ctx) return [0, 0, 0];
  ctx.fillStyle = cssVar(root, name) || 'black';
  ctx.fillRect(0, 0, 1, 1);
  const px = ctx.getImageData(0, 0, 1, 1).data;
  return [px[0], px[1], px[2]].map((byte) => {
    const s = byte / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
}

export async function mount(root, env) {
  await loadCSS(new URL('./style.css', import.meta.url));
  const v = view(root, { aspect: 16 / 9, aspectNarrow: 1, label: LABELS.ink });
  // The canvas swallows touch drags, so on touch screens leave room to scroll the page past it.
  if (env.coarse) {
    v.wrap.style.maxHeight = '65vh';
    v.measure();
  }

  let glc = createGL(v.canvas);
  let solver = null;
  try {
    if (glc && glc.caps.best) solver = createSolver(glc.gl, glc.caps);
  } catch {
    solver = null;
  }
  if (!solver) {
    overlay(v.wrap, {
      title: 'The fluid cannot run here',
      text: 'The solver keeps its velocity and pressure in floating-point textures (WebGL2 half-float render targets), and this browser does not provide them. The plain JavaScript reference solver still runs in the test panel.',
    });
    return { start() {}, stop() {}, destroy: () => v.destroy() };
  }
  const gl = glc.gl;
  const colors = { bg: tokenLinear(root, '--st-bg'), body: tokenLinear(root, '--st-raise'), rim: tokenLinear(root, '--st-muted') };
  const touchFirst = env.coarse || env.small;

  const state = { mode: 'ink', view: 'dye', tool: 'draw', viscosity: 0, shape: 'cylinder' };
  // Vorticity confinement per mode: the tunnel gets very little, so its wake stays honest.
  const swirl = { ink: 0.05, tunnel: 0.02 };
  const splats = createSplats();
  const params = { dt: 1, confine: 0, viscosity: 0, velFade: 1, dyeFade: 1, sweeps: 14, omega: OMEGA, splats, streaks: 0 };
  const jet = emitter(0, 0);
  let level = 2;
  let governor = createGovernor(level);
  let grid = { n: 0, m: 0 };
  let aspect = 0;
  let drawing = null;
  let maskBytes = new Uint8Array(0);
  let maskDirty = false;
  let emitTime = 3;
  let idle = 99;
  let lastFrame = 0;
  let frameAverage = 1 / 60;
  let frames = 0;
  let wanted = false;
  let lost = false;
  let destroyed = false;

  /* ── controls ── */
  const legend = el('div', { class: 'flow-legend' });
  v.wrap.append(legend);
  const gridStat = stat({ label: 'Grid' });
  const fpsStat = stat({ label: 'fps' });
  const hintNode = hint('');
  const swirlCtl = slider({ label: 'Swirl', min: 0, max: 0.15, step: 0.01, value: swirl.ink, format: (x) => x.toFixed(2), onInput: (x) => (swirl[state.mode] = x) });
  const resetBtn = button({ label: 'Clear', onClick: () => { resetFlow(); draw(); } });
  const shapeBtn = (label, name) => button({ label, onClick: () => { state.shape = name; if (!drawing) return; preset(drawing, name); maskDirty = true; uploadMask(); resetFlow(); draw(); } });
  const tunnelBar = bar(
    root,
    segmented({
      label: touchFirst ? 'Finger' : 'Pointer',
      options: [{ value: 'draw', label: 'Draw wall' }, { value: 'erase', label: 'Erase' }, { value: 'stir', label: 'Stir' }],
      value: state.tool,
      onChange: (tool) => (state.tool = tool),
    }),
    group(shapeBtn('Cylinder', 'cylinder'), shapeBtn('Plate', 'plate'), shapeBtn('Aerofoil', 'aerofoil'), shapeBtn('No obstacle', 'none')),
  );
  bar(
    root,
    segmented({ label: 'Mode', options: [{ value: 'ink', label: 'Ink' }, { value: 'tunnel', label: 'Wind tunnel' }], value: state.mode, onChange: setMode }),
    segmented({
      label: 'View',
      options: [{ value: 'dye', label: 'Dye' }, { value: 'speed', label: 'Speed' }, { value: 'vorticity', label: 'Vorticity' }, { value: 'pressure', label: 'Pressure' }],
      value: state.view,
      onChange: (name) => { state.view = name; describe(); draw(); },
    }),
    resetBtn,
  );
  const tuningBar = bar(
    root,
    slider({ label: 'Viscosity', min: 0, max: 0.2, step: 0.01, value: state.viscosity, format: (x) => x.toFixed(2), onInput: (x) => (state.viscosity = x) }),
    swirlCtl,
    spacer(),
    group(gridStat, fpsStat),
  );
  bar(root, hintNode);
  root.insertBefore(tunnelBar, tuningBar);

  function describe() {
    const tunnel = state.mode === 'tunnel';
    tunnelBar.classList.toggle('flow-off', !tunnel);
    resetBtn.setLabel(tunnel ? 'Restart flow' : 'Clear');
    legend.textContent = LEGENDS[state.view];
    swirlCtl.value = swirl[state.mode];
    v.canvas.setAttribute('aria-label', LABELS[state.mode]);
    if (tunnel) hintNode.textContent = 'Flow enters from the left. Draw walls, or pick a shape and watch its wake roll up.';
    else hintNode.textContent = touchFirst ? 'Drag to stir. Every finger gets its own colour.' : 'Drag to stir. Every stroke gets its own colour.';
  }

  /* ── simulation set-up ── */
  const inflowSpeed = () => (state.mode === 'tunnel' ? grid.n / 240 : 0);

  function uploadMask() {
    if (!grid.n || !maskDirty) return;
    buildMask(drawing, grid.n, grid.m, state.mode === 'tunnel', maskBytes);
    solver.setMask(maskBytes);
    maskDirty = false;
  }

  // Match the grid to the view's shape and the current quality level; keeps the flow going.
  function configure() {
    const { w, h } = v.size;
    if (!w || !h || lost) return;
    const shape = w / h;
    if (!drawing || Math.abs(shape - aspect) > 0.02 * aspect) {
      aspect = shape;
      drawing = createDrawing(aspect);
      preset(drawing, state.shape);
      maskDirty = true;
    }
    const next = gridFor(level, aspect);
    if (next.n !== grid.n || next.m !== grid.m) {
      const first = !grid.n;
      grid = next;
      solver.resize(grid.n, grid.m);
      maskBytes = new Uint8Array(grid.n * grid.m);
      maskDirty = true;
      gridStat.set(`${grid.n} × ${grid.m}`);
      solver.setInflow(inflowSpeed());
      uploadMask();
      if (first) resetFlow();
    }
    uploadMask();
  }

  function resetFlow() {
    if (!grid.n || lost) return;
    const u = inflowSpeed();
    solver.setInflow(u);
    solver.reset(u);
    idle = 99;
    if (state.mode !== 'tunnel') return;
    solver.fillStreaks();
    // A sideways nudge behind the body, so the wake does not wait for rounding error to tip it.
    const x = 0.36 * grid.n;
    const y = 0.5 * grid.m;
    splats.velCount = 0;
    pushVelocity(x, y, x, y, u, 0.6 * u, 0.07 * grid.m, state.shape === 'none' ? 0 : 0.9);
    solver.splatVelocity(splats);
    splats.velCount = 0;
    // One thorough projection, over-relaxed close to the optimum for a grid this long, so the
    // stream starts already parted around the body.
    solver.project(120, 1.95);
  }

  function setMode(mode) {
    state.mode = mode;
    describe();
    maskDirty = true;
    uploadMask();
    resetFlow();
    draw();
  }

  /* ── strokes ── */
  function pushVelocity(ax, ay, bx, by, vx, vy, radius, weight) {
    const k = splats.velCount * 4;
    if (k >= 32) return;
    splats.velSeg[k] = ax;
    splats.velSeg[k + 1] = ay;
    splats.velSeg[k + 2] = bx;
    splats.velSeg[k + 3] = by;
    splats.velVal[k] = vx;
    splats.velVal[k + 1] = vy;
    splats.velVal[k + 2] = radius;
    splats.velVal[k + 3] = weight;
    splats.velCount++;
  }
  function pushDye(ax, ay, bx, by, color, gain, radius) {
    const k = splats.dyeCount * 4;
    if (k >= 32) return;
    splats.dyeSeg[k] = ax;
    splats.dyeSeg[k + 1] = ay;
    splats.dyeSeg[k + 2] = bx;
    splats.dyeSeg[k + 3] = by;
    splats.dyeCol[k] = color[0] * gain;
    splats.dyeCol[k + 1] = color[1] * gain;
    splats.dyeCol[k + 2] = color[2] * gain;
    splats.dyeCol[k + 3] = radius;
    splats.dyeCount++;
  }

  const pointers = trackPointers(v.canvas, (p) => {
    p.color = touchColor(p.index);
  });

  function gatherStrokes(dt, jets, boost) {
    const { n, m } = grid;
    const tunnel = state.mode === 'tunnel';
    splats.velCount = 0;
    splats.dyeCount = 0;
    for (const p of pointers.active.values()) {
      idle = 0;
      if (tunnel && state.tool !== 'stir') {
        const drawingWall = state.tool === 'draw';
        stampLine(drawing, p.px, p.py, p.x, p.y, drawingWall ? 0.02 : 0.035, drawingWall ? 1 : 0);
        maskDirty = true;
      } else {
        const ax = p.px * n;
        const ay = p.py * m;
        const bx = p.x * n;
        const by = p.y * m;
        let vx = (bx - ax) / dt;
        let vy = (by - ay) / dt;
        const speed = Math.hypot(vx, vy);
        const limit = 0.1 * n;
        if (speed > limit) {
          vx *= limit / speed;
          vy *= limit / speed;
        }
        if (speed > 0.02) pushVelocity(ax, ay, bx, by, vx, vy, 0.024 * n, 0.8);
        if (!tunnel) pushDye(ax, ay, bx, by, p.color, 1.25, 0.02 * n);
      }
      p.px = p.x;
      p.py = p.y;
    }
    pointers.flush();
    if (!jets) return;
    for (let k = 0; k < JET_COUNT; k++) {
      emitter(k, emitTime, jet);
      const x = jet.x * n;
      const y = jet.y * m;
      const speed = 0.011 * n * jet.pulse * boost;
      // Each puff reaches as far as the fluid travels in a step, so a fast jet leaves no gaps.
      const reach = Math.max(0.012 * n, speed * dt);
      pushVelocity(x, y, x + jet.dx * reach, y + jet.dy * reach, jet.dx * speed, jet.dy * speed, 0.018 * n, 0.5);
      pushDye(x, y, x + jet.dx * reach, y + jet.dy * reach, jet.color, 1.2, 0.012 * n);
    }
  }

  function advance(dt, jets, boost) {
    const tunnel = state.mode === 'tunnel';
    gatherStrokes(dt, jets, boost);
    uploadMask();
    params.dt = dt;
    params.confine = swirl[state.mode];
    // Explicit diffusion is only stable below a quarter of a cell squared per step.
    params.viscosity = Math.min(state.viscosity, 0.22 / dt);
    params.velFade = tunnel ? 1 : 0.999;
    params.dyeFade = tunnel ? 1 : 0.9945 ** dt;
    params.sweeps = LEVELS[level].sweeps;
    params.streaks = tunnel ? 1 : 0;
    solver.step(params);
  }

  function draw() {
    if (lost || destroyed || !grid.n) return;
    const tunnel = state.mode === 'tunnel';
    const u = inflowSpeed();
    let scale = 8;
    if (state.view === 'speed') scale = tunnel ? 1 / (1.8 * u) : 1 / (0.02 * grid.n);
    else if (state.view === 'pressure') scale = tunnel ? 2 / (u * u) : 2 / (0.012 * grid.n) ** 2;
    solver.render(VIEWS[state.view], scale, colors.bg, colors.body, colors.rim);
  }

  /* ── frame loop ── */
  const anim = loop(() => {
    const now = performance.now();
    const real = (now - lastFrame) / 1000;
    lastFrame = now;
    if (!grid.n || lost) return;
    if (real > 0 && real < 1) frameAverage += (real - frameAverage) * 0.08;
    const next = governor.sample(real);
    if (next !== level) {
      level = next;
      configure();
    }
    idle += real;
    emitTime += Math.min(real, 0.05);
    const touching = pointers.active.size > 0;
    if (env.reducedMotion && state.mode === 'ink' && !touching && idle > 6) {
      // Reduced motion: nothing stirs the ink by itself, so once it has settled, stop drawing.
      fpsStat.set('idle');
      return;
    }
    advance(clamp(real * 60, 0.5, 2), state.mode === 'ink' && !env.reducedMotion && !touching && idle > 2.5, 1);
    draw();
    if (++frames % 20 === 0) fpsStat.set(Math.round(1 / frameAverage));
  });

  // Resolves once the GPU has finished everything submitted so far. A fence is polled because
  // gl.finish() does not wait in every browser and a pixel read-back would stall the pipeline.
  function gpuIdle() {
    const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    gl.flush();
    const began = performance.now();
    return new Promise((resolve) => {
      const poll = () => {
        const waiting = !destroyed && !lost && performance.now() - began < 4000 && gl.clientWaitSync(sync, 0, 0) === gl.TIMEOUT_EXPIRED;
        if (waiting) {
          setTimeout(poll, 1);
          return;
        }
        gl.deleteSync(sync);
        resolve();
      };
      setTimeout(poll, 0);
    });
  }

  // Measure what a step costs here, pick the grid from that, then run the ink for a moment
  // so the first thing on screen is already a picture.
  async function warmUp() {
    configure();
    if (!grid.n) return;
    advance(1, true, 1.5);
    await gpuIdle();
    const t0 = performance.now();
    for (let k = 0; k < 6; k++) advance(1, true, 1.5);
    await gpuIdle();
    if (destroyed || lost) return;
    const measured = levelForStepTime((performance.now() - t0) / 6, touchFirst);
    governor = createGovernor(measured, touchFirst ? 3 : LEVELS.length - 1);
    if (measured !== level) {
      level = measured;
      configure();
    }
    // Three opening strokes, made exactly the way a finger makes them, then time for them to curl.
    const ghosts = [];
    for (let k = 0; k < OPENING_STROKES; k++) {
      const p = openingStroke(k, 0, { x: 0, y: 0, px: 0, py: 0, index: -1, released: false, color: touchColor([1, 5, 2][k]) });
      p.px = p.x;
      p.py = p.y;
      ghosts.push(p);
      pointers.active.set(-1 - k, p);
    }
    const strokeSteps = 30;
    const began = performance.now();
    let steps = 0;
    while (steps < 110 && (steps < 60 || performance.now() - began < 900)) {
      for (let k = 0; k < 4; k++, steps++) {
        for (let g = 0; g < ghosts.length; g++) {
          if (steps <= strokeSteps) openingStroke(g, steps / strokeSteps, ghosts[g]);
          if (steps === strokeSteps) ghosts[g].released = true;
        }
        emitTime += 1 / 60;
        advance(1, true, 1.5);
      }
      await gpuIdle();
      if (destroyed || lost) break;
    }
    for (const p of ghosts) p.released = true;
    pointers.flush();
    idle = 99;
  }

  const offLoss = onContextLoss(v.canvas, {
    lost() {
      lost = true;
      anim.stop();
    },
    restored() {
      glc = createGL(v.canvas);
      try {
        solver = createSolver(glc.gl, glc.caps);
      } catch {
        overlay(v.wrap, { title: 'The graphics context was lost', text: 'The browser took the GPU away and the solver could not be rebuilt. Reload the page to start it again.' });
        return;
      }
      lost = false;
      grid = { n: 0, m: 0 };
      configure();
      for (let k = 0; k < 12 && grid.n; k++) advance(1, state.mode === 'ink', 1.5);
      draw();
      if (wanted) {
        lastFrame = performance.now();
        anim.start();
      }
    },
  });

  describe();
  await warmUp();
  const offResize = v.onResize(() => {
    configure();
    draw();
  });

  return {
    start() {
      wanted = true;
      if (anim.running || lost || destroyed) return;
      lastFrame = performance.now();
      anim.start();
    },
    stop() {
      wanted = false;
      anim.stop();
    },
    destroy() {
      destroyed = true;
      anim.stop();
      pointers.destroy();
      offLoss();
      offResize();
      v.destroy();
      if (!lost) solver.dispose();
      const lose = gl.getExtension('WEBGL_lose_context');
      if (lose) lose.loseContext();
    },
  };
}
