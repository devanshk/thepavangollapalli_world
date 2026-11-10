import { assert, equal, near } from '../../assets/js/check.js';
import { rng } from '../../assets/js/kit.js';
import { createGL } from '../../assets/js/glkit.js';
import * as R from './ref.js';
import { createDrawing, preset, stampLine, buildMask, CYLINDER_DIAMETER, MASK_SOLID, MASK_OPEN, MASK_FLUID } from './shapes.js';
import { gridFor, createGovernor } from './quality.js';
import { PALETTE, DYE_LIGHTNESS, inGamut, emitter, JET_COUNT } from './palette.js';
import { createSolver, createSplats } from './gpu.js';

/* ── helpers for the reference solver ── */

function box(n, m, block) {
  const g = R.createGrid(n, m);
  R.closeBox(g);
  if (block) for (let j = block.y0; j < block.y1; j++) for (let i = block.x0; i < block.x1; i++) R.setSolid(g, i, j);
  return g;
}

function randomVelocity(g, seed, scale = 1) {
  const r = rng(seed);
  for (let k = 0; k < g.u.length; k++) {
    g.u[k] = r.range(-scale, scale);
    g.v[k] = r.range(-scale, scale);
  }
  R.applyWalls(g);
}

// A velocity field taken from a stream function on the cell corners is divergence-free exactly.
function setStream(g, psi) {
  for (let j = 0; j < g.m; j++)
    for (let i = 0; i < g.n; i++) {
      g.u[i + j * g.n] = psi(i, j + 1) - psi(i, j);
      g.v[i + j * g.n] = -(psi(i + 1, j) - psi(i, j));
    }
  R.applyWalls(g);
}

// Swirl that vanishes on the tank walls; `lobes` vortices stacked vertically.
const swirl = (g, amp, lobes = 1) => (x, y) =>
  x < 1 || y < 1 || x > g.n - 1 || y > g.m - 1
    ? 0
    : amp * Math.sin((Math.PI * (x - 1)) / (g.n - 2)) * Math.sin((lobes * Math.PI * (y - 1)) / (g.m - 2));

function blob(g, cx, cy, sigma) {
  for (let j = 0; j < g.m; j++)
    for (let i = 0; i < g.n; i++)
      g.dye[i + j * g.n] = g.type[i + j * g.n] === R.FLUID ? Math.exp(-((i + 0.5 - cx) ** 2 + (j + 0.5 - cy) ** 2) / (2 * sigma * sigma)) : 0;
  R.extendDye(g);
}

const peak = (f) => f.reduce((a, b) => Math.max(a, b), -Infinity);

/* ── helpers for the GPU solver ── */

let shared = null;
// One small solver on its own canvas for all GPU tests; null where WebGL2 float targets are missing.
function gpu() {
  if (shared) return shared.solver;
  const canvas = document.createElement('canvas');
  const glc = createGL(canvas);
  if (!glc || !glc.caps.best) return null;
  const solver = createSolver(glc.gl, glc.caps);
  const n = 96;
  const m = 64;
  solver.resize(n, m);
  solver.setMask(buildMask(createDrawing(n / m), n, m, false));
  shared = { solver, gl: glc.gl, n, m };
  return solver;
}

function stir(splats) {
  splats.velCount = 2;
  splats.velSeg.set([30, 20, 44, 30, 70, 44, 58, 36]);
  splats.velVal.set([2.5, 1.5, 6, 1, -2, -1.5, 6, 1]);
  splats.dyeCount = 1;
  splats.dyeSeg.set([30, 20, 44, 30]);
  splats.dyeCol.set([1, 0.4, 0.1, 5]);
  return splats;
}

const maxAbs = (pixels, channels) => {
  let worst = 0;
  for (let k = 0; k < pixels.length; k += 4) for (let c = 0; c < channels; c++) worst = Math.max(worst, Math.abs(pixels[k + c]));
  return worst;
};

export default [
  {
    name: 'projection leaves a random flow divergence-free',
    fn() {
      const g = box(32, 24, { x0: 12, x1: 17, y0: 8, y1: 14 });
      randomVelocity(g, 11);
      const before = R.maxDivergence(g);
      R.project(g, 300, 1.8);
      const after = R.maxDivergence(g);
      assert(before > 0.5, `the random field should start far from divergence-free, got ${before}`);
      assert(after < 1e-9, `largest divergence after projection is ${after}`);
    },
  },
  {
    name: 'no flow crosses the faces of an obstacle after projection',
    fn() {
      const g = box(32, 24, { x0: 12, x1: 17, y0: 8, y1: 14 });
      randomVelocity(g, 5);
      R.project(g, 60, 1.8);
      for (let j = 0; j < g.m; j++)
        for (let i = 0; i < g.n; i++) {
          const k = i + j * g.n;
          if (g.type[k] !== R.SOLID) continue;
          equal(g.u[k], 0, `left face of solid cell ${i},${j}`);
          equal(g.v[k], 0, `bottom face of solid cell ${i},${j}`);
          if (i + 1 < g.n) equal(g.u[k + 1], 0, `right face of solid cell ${i},${j}`);
          if (j + 1 < g.m) equal(g.v[k + g.n], 0, `top face of solid cell ${i},${j}`);
        }
    },
  },
  {
    name: 'advecting a uniform dye field leaves it uniform',
    fn() {
      const g = box(32, 24, { x0: 12, x1: 17, y0: 8, y1: 14 });
      randomVelocity(g, 3, 0.8);
      R.project(g, 300, 1.8);
      g.dye.fill(1);
      R.extendDye(g);
      for (let s = 0; s < 10; s++) R.advectDye(g, 1);
      for (let k = 0; k < g.dye.length; k++) if (g.type[k] === R.FLUID) near(g.dye[k], 1, 1e-9, `cell ${k}`);
    },
  },
  {
    name: 'the limiter never creates a new maximum or minimum',
    fn() {
      const g = box(40, 28, { x0: 20, x1: 24, y0: 6, y1: 16 });
      randomVelocity(g, 21, 1.5);
      R.project(g, 300, 1.8);
      const r = rng(8);
      for (let k = 0; k < g.dye.length; k++) g.dye[k] = g.type[k] === R.FLUID ? r() : 0;
      R.extendDye(g);
      for (let s = 0; s < 20; s++) R.advectDye(g, 1);
      for (let k = 0; k < g.dye.length; k++) assert(g.dye[k] >= -1e-12 && g.dye[k] <= 1 + 1e-12, `dye ${g.dye[k]} left the range 0..1`);
    },
  },
  {
    name: 'advection keeps the total dye in a closed tank to within 2 %',
    fn() {
      const g = box(48, 32);
      setStream(g, swirl(g, 8));
      blob(g, 16, 12, 4);
      const before = R.totalDye(g);
      for (let s = 0; s < 40; s++) R.advectDye(g, 1);
      const drift = Math.abs(R.totalDye(g) - before) / before;
      assert(drift < 0.02, `total dye drifted by ${(drift * 100).toFixed(3)} %`);
    },
  },
  {
    name: 'the correction keeps a blob sharper than plain semi-Lagrangian advection',
    fn() {
      const run = (correct) => {
        const g = box(48, 32);
        setStream(g, swirl(g, 8));
        blob(g, 16, 12, 2.5);
        for (let s = 0; s < 30; s++) R.advectDye(g, 1, correct);
        return peak(g.dye);
      };
      const corrected = run(true);
      const plain = run(false);
      assert(corrected > plain + 0.1, `peak ${corrected.toFixed(3)} with the correction, ${plain.toFixed(3)} without`);
    },
  },
  {
    // An odd number of rows, so that the red-black colouring is itself mirror-symmetric.
    name: 'a mirror-symmetric flow stays mirror-symmetric',
    fn() {
      const g = box(40, 31);
      setStream(g, swirl(g, 6, 2));
      for (let j = 0; j < g.m; j++)
        for (let i = 0; i < g.n; i++) g.dye[i + j * g.n] = Math.exp(-((i - 14) ** 2 + (j - 15) ** 2) / 30);
      R.extendDye(g);
      for (let s = 0; s < 12; s++) R.step(g, { confine: 0.2, viscosity: 0.02, sweeps: 30 });
      let worst = 0;
      for (let j = 0; j < g.m; j++)
        for (let i = 0; i < g.n; i++) {
          const k = i + j * g.n;
          const mirror = i + (g.m - 1 - j) * g.n;
          worst = Math.max(worst, Math.abs(g.u[k] - g.u[mirror]), Math.abs(g.dye[k] - g.dye[mirror]));
          if (j > 0) worst = Math.max(worst, Math.abs(g.v[k] + g.v[i + (g.m - j) * g.n]));
        }
      assert(R.kineticEnergy(g) > 1, 'the flow should still be moving');
      assert(worst < 1e-9, `largest asymmetry is ${worst}`);
    },
  },
  {
    name: 'an empty wind tunnel keeps a uniform stream',
    fn() {
      const g = R.createGrid(40, 20);
      R.openTunnel(g, 0.8);
      g.u.fill(0.8);
      R.applyWalls(g);
      for (let s = 0; s < 10; s++) R.step(g, { confine: 0.2, sweeps: 60 });
      for (let j = 1; j < g.m - 1; j++)
        for (let i = 1; i < g.n; i++) {
          near(g.u[i + j * g.n], 0.8, 1e-6, `u at ${i},${j}`);
          near(g.v[i + j * g.n], 0, 1e-6, `v at ${i},${j}`);
        }
    },
  },
  {
    name: 'what flows into the tunnel flows out again past an obstacle',
    fn() {
      const g = R.createGrid(48, 24);
      R.openTunnel(g, 1);
      for (let j = 8; j < 16; j++) for (let i = 14; i < 19; i++) R.setSolid(g, i, j);
      g.u.fill(1);
      R.project(g, 600, 1.8);
      let out = 0;
      for (let j = 1; j < g.m - 1; j++) out += g.u[g.n - 1 + j * g.n];
      near(out, g.m - 2, 1e-6, 'flux through the open end');
      assert(R.maxDivergence(g) < 1e-8, 'flow around the block should be divergence-free');
    },
  },
  {
    name: 'a rigid rotation has vorticity of twice its angular rate',
    fn() {
      const g = R.createGrid(16, 12);
      const rate = 0.05;
      for (let j = 0; j < g.m; j++)
        for (let i = 0; i < g.n; i++) {
          g.u[i + j * g.n] = -rate * (j + 0.5 - 6);
          g.v[i + j * g.n] = rate * (i + 0.5 - 8);
        }
      R.computeCurl(g);
      for (let j = 1; j < g.m; j++) for (let i = 1; i < g.n; i++) near(g.curl[i + j * g.n], 2 * rate, 1e-12);
    },
  },
  {
    name: 'viscosity only ever removes energy',
    fn() {
      const g = box(24, 18);
      randomVelocity(g, 9);
      let energy = R.kineticEnergy(g);
      for (let s = 0; s < 10; s++) {
        R.applyForces(g, { viscosity: 0.2 });
        const next = R.kineticEnergy(g);
        assert(next < energy, `energy rose from ${energy} to ${next}`);
        energy = next;
      }
    },
  },
  {
    name: 'the cylinder preset is a disc of the stated diameter',
    fn() {
      const d = createDrawing(16 / 9);
      preset(d, 'cylinder');
      const area = d.data.reduce((a, b) => a + b, 0);
      const radius = 0.5 * CYLINDER_DIAMETER * d.h;
      near(area / (Math.PI * radius * radius), 1, 0.04, 'area relative to a true disc');
    },
  },
  {
    name: 'a wall drawn right across the tunnel still leaves a gap at each side',
    fn() {
      const d = createDrawing(16 / 9);
      stampLine(d, 0.5, 0, 0.5, 1, 0.02, 1);
      const n = 128;
      const m = 72;
      const mask = buildMask(d, n, m, true);
      const column = Math.floor(0.5 * n);
      let open = 0;
      let solid = 0;
      for (let j = 1; j < m - 1; j++) {
        if (mask[column + j * n] === MASK_FLUID) open++;
        else solid++;
      }
      assert(solid > m / 2, 'the drawn wall should block most of the column');
      assert(open >= 4, `only ${open} cells stayed open`);
      equal(mask[n - 1 + 10 * n], MASK_OPEN, 'the right edge is the open outflow');
      const ink = buildMask(d, n, m, false);
      for (let i = 0; i < n; i++) equal(ink[i], MASK_SOLID, 'the ink tank is closed along its floor');
      equal(ink[column + 30 * n], MASK_FLUID, 'the ink tank ignores tunnel obstacles');
    },
  },
  {
    name: 'slow frames coarsen the grid and fast frames refine it again',
    fn() {
      equal(gridFor(2, 16 / 9), { n: 256, m: 144 });
      equal(gridFor(5, 16 / 9), { n: 512, m: 288 });
      const gov = createGovernor(3);
      for (let f = 0; f < 80; f++) gov.sample(1 / 24);
      assert(gov.level < 3, `level stayed at ${gov.level} after three seconds of 24 fps`);
      const low = gov.level;
      for (let f = 0; f < 60 * 400; f++) gov.sample(1 / 60);
      assert(gov.level > low, 'level should rise again once frames are fast');
    },
  },
  {
    name: 'dye colours share one lightness and stay inside sRGB',
    fn() {
      for (const [r, g, b] of PALETTE) {
        assert(inGamut([r, g, b]), `colour ${r}, ${g}, ${b} is outside sRGB`);
        const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
        const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
        const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
        near(0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, DYE_LIGHTNESS, 2e-3, 'OKLab lightness');
      }
    },
  },
  {
    name: 'the idle emitters stay inside the tank',
    fn() {
      for (let k = 0; k < JET_COUNT; k++)
        for (let t = 0; t < 400; t += 0.37) {
          const e = emitter(k, t);
          assert(e.x > 0.05 && e.x < 0.95 && e.y > 0.05 && e.y < 0.95, `emitter ${k} at ${e.x}, ${e.y}`);
          near(Math.hypot(e.dx, e.dy), 1, 1e-12);
          assert(inGamut(e.color), 'emitter colour inside sRGB');
        }
    },
  },
  {
    name: 'every shader compiles and links on this GPU',
    browser: true,
    fn() {
      const solver = gpu();
      if (!solver) return; // no WebGL2 float targets: the exhibit shows a message instead
      assert(typeof solver.formats.velocity === 'string', 'a velocity format was chosen');
    },
  },
  {
    name: 'thirty GPU steps of stirred ink stay finite',
    browser: true,
    fn() {
      const solver = gpu();
      if (!solver) return;
      solver.setInflow(0);
      solver.reset(0);
      const splats = stir(createSplats());
      const params = { dt: 1, confine: 0.15, viscosity: 0.01, velFade: 1, dyeFade: 1, sweeps: 12, omega: 1.8, splats, streaks: 0 };
      for (let s = 0; s < 30; s++) {
        if (s === 6) splats.velCount = 0;
        solver.step(params);
      }
      const pixels = solver.readVelocity();
      if (!pixels) return; // float read-back is not supported here: nothing to check
      let moving = 0;
      for (let k = 0; k < pixels.length; k += 4) {
        assert(Number.isFinite(pixels[k]) && Number.isFinite(pixels[k + 1]), 'velocity must be finite');
        if (Math.abs(pixels[k]) > 0.01) moving++;
      }
      assert(moving > 200, `only ${moving} cells are moving`);
    },
  },
  {
    name: 'GPU projection removes almost all divergence',
    browser: true,
    fn() {
      const solver = gpu();
      if (!solver) return;
      try {
        solver.setInflow(0);
        solver.reset(0);
        solver.splatVelocity(stir(createSplats()));
        const raw = solver.readDivergence();
        if (!raw) return; // float read-back is not supported here: nothing to check
        const before = maxAbs(raw, 1);
        solver.project(120, 1.8);
        const after = maxAbs(solver.readDivergence(), 1);
        assert(before > 0.05, `the stirred field should diverge, got ${before}`);
        // Velocity is stored in half floats, which sets the floor on how small this can get.
        assert(after < 0.05 * before, `divergence went from ${before.toFixed(4)} to ${after.toFixed(4)}`);
      } finally {
        solver.dispose();
        const lose = shared.gl.getExtension('WEBGL_lose_context');
        if (lose) lose.loseContext();
        shared = null;
      }
    },
  },
];
