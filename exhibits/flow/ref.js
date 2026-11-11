// ref.js — the reference solver: the algorithm the GPU runs, in plain JavaScript on a small
// grid. The Node tests check this module, pass for pass against the shaders in shaders.js.
//
// Layout (a staggered "MAC" grid): cell (i, j) keeps pressure and dye at its centre, u on its
// left face and v on its bottom face. Lengths are in cells and velocities in cells per step,
// so the pressure projection needs no physical constants and is exact on the grid.

export const FLUID = 0;
export const SOLID = 1;
export const OPEN = 2;

// What the GPU mask texture holds for each cell type (see shapes.js).
const MASK_VALUE = [0, 1, 0.2];
// Offset from a sample position (in cells) to texel space, per kind: 0 = u, 1 = v, 2 = centre.
const OFF_X = [0.5, 0, 0];
const OFF_Y = [0, 0.5, 0];

const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);
const smoothstep01 = (x) => {
  const t = clamp(x, 0, 1);
  return t * t * (3 - 2 * t);
};

export function createGrid(n, m) {
  const f = () => new Float64Array(n * m);
  return {
    n, m,
    u: f(), v: f(), p: f(), div: f(), dye: f(), curl: f(), mask: f(),
    type: new Uint8Array(n * m),
    inflow: 0,
    slip: false,
    s0: f(), s1: f(), s2: f(), s3: f(),
  };
}

const typeAt = (g, i, j) => (i < 0 || j < 0 || i >= g.n || j >= g.m ? SOLID : g.type[i + j * g.n]);
const solidAt = (g, i, j) => typeAt(g, i, j) === SOLID;

function sealMask(g) {
  for (let k = 0; k < g.type.length; k++) g.mask[k] = MASK_VALUE[g.type[k]];
}

/** A closed tank: every edge cell is a wall. */
export function closeBox(g) {
  const { n, m } = g;
  for (let j = 0; j < m; j++)
    for (let i = 0; i < n; i++) g.type[i + j * n] = i === 0 || j === 0 || i === n - 1 || j === m - 1 ? SOLID : FLUID;
  g.inflow = 0;
  g.slip = false;
  sealMask(g);
}

/** A wind tunnel: the left column blows at `inflow`, the right column is open, walls slip. */
export function openTunnel(g, inflow) {
  const { n, m } = g;
  for (let j = 0; j < m; j++)
    for (let i = 0; i < n; i++)
      g.type[i + j * n] = j === 0 || j === m - 1 || i === 0 ? SOLID : i === n - 1 ? OPEN : FLUID;
  g.inflow = inflow;
  g.slip = true;
  sealMask(g);
}

export function setSolid(g, i, j) {
  g.type[i + j * g.n] = SOLID;
  g.mask[i + j * g.n] = MASK_VALUE[SOLID];
}

/** Faces that touch a solid cell take the solid's velocity: zero, or the inflow at the inlet. */
export function applyWalls(g) {
  const { n, m, u, v } = g;
  for (let j = 0; j < m; j++)
    for (let i = 0; i < n; i++) {
      const k = i + j * n;
      const t = g.type[k];
      if (t === SOLID || solidAt(g, i - 1, j)) u[k] = g.inflow > 0 && i <= 1 ? g.inflow : 0;
      if (t !== FLUID || solidAt(g, i, j - 1)) v[k] = 0;
    }
}

// Bilinear lookup in texel space (texel centres at half-integers), clamped at the edges:
// exactly what a LINEAR, CLAMP_TO_EDGE texture fetch does.
function bilinear(f, n, m, qx, qy) {
  const fx = qx - 0.5;
  const fy = qy - 0.5;
  let i0 = Math.floor(fx);
  let j0 = Math.floor(fy);
  const tx = fx - i0;
  const ty = fy - j0;
  const i1 = clamp(i0 + 1, 0, n - 1);
  const j1 = clamp(j0 + 1, 0, m - 1);
  i0 = clamp(i0, 0, n - 1);
  j0 = clamp(j0, 0, m - 1);
  return (f[i0 + j0 * n] * (1 - tx) + f[i1 + j0 * n] * tx) * (1 - ty) + (f[i0 + j1 * n] * (1 - tx) + f[i1 + j1 * n] * tx) * ty;
}

let lo = 0;
let hi = 0;
// Smallest and largest of the four texels a bilinear lookup at (qx, qy) blends.
function bounds(f, n, m, qx, qy) {
  const fx = qx - 0.5;
  const fy = qy - 0.5;
  let i0 = Math.floor(fx);
  let j0 = Math.floor(fy);
  // A texel with zero weight was not blended, so it does not count. Without this the limiter
  // treats a flow and its mirror image differently wherever a trace lands on a texel centre.
  const i1 = clamp(fx > i0 ? i0 + 1 : i0, 0, n - 1);
  const j1 = clamp(fy > j0 ? j0 + 1 : j0, 0, m - 1);
  i0 = clamp(i0, 0, n - 1);
  j0 = clamp(j0, 0, m - 1);
  const a = f[i0 + j0 * n];
  const b = f[i1 + j0 * n];
  const c = f[i0 + j1 * n];
  const d = f[i1 + j1 * n];
  lo = Math.min(a, b, c, d);
  hi = Math.max(a, b, c, d);
}

// In the tunnel, u is never read from inside the top and bottom walls: that is the free slip.
const texelY = (g, kind, y) => (kind === 0 && g.slip ? clamp(y, 1.5, g.m - 1.5) : y + OFF_Y[kind]);

function sample(g, f, kind, x, y) {
  return bilinear(f, g.n, g.m, x + OFF_X[kind], texelY(g, kind, y));
}

/**
 * Semi-Lagrangian advection with a MacCormack correction: trace back, trace forward again,
 * and add half of the round-trip error. The result is clamped to the values the back-trace
 * interpolated between, so it can never overshoot. Next to solids it stays first order.
 * (Both the clamped and the first-order value lie inside those bounds, and so does any blend.)
 */
function advect(g, src, dst, hat, kind, dt, correct) {
  const { n, m } = g;
  for (let j = 0; j < m; j++)
    for (let i = 0; i < n; i++) {
      const px = i + 0.5 - OFF_X[kind];
      const py = j + 0.5 - OFF_Y[kind];
      const ux = sample(g, g.u, 0, px, py);
      const vy = sample(g, g.v, 1, px, py);
      hat[i + j * n] = sample(g, src, kind, px - dt * ux, py - dt * vy);
    }
  if (!correct) {
    dst.set(hat);
    return;
  }
  for (let j = 0; j < m; j++)
    for (let i = 0; i < n; i++) {
      const k = i + j * n;
      const px = i + 0.5 - OFF_X[kind];
      const py = j + 0.5 - OFF_Y[kind];
      const ux = sample(g, g.u, 0, px, py);
      const vy = sample(g, g.v, 1, px, py);
      const bx = px - dt * ux;
      const by = py - dt * vy;
      let value = hat[k];
      const wall = bilinear(g.mask, n, m, px, py) + bilinear(g.mask, n, m, bx, by);
      // Velocity stays first order wherever a solid is in reach; dye fades the correction out
      // towards solids instead, because a hard switch would show as a seam in the picture.
      if (kind === 2 ? wall < 0.5 : wall <= 0) {
        const corrected = value + 0.5 * (src[k] - sample(g, hat, kind, px + dt * ux, py + dt * vy));
        bounds(src, n, m, bx + OFF_X[kind], texelY(g, kind, by));
        const limited = clamp(corrected, lo, hi);
        // Dye only: where the correction overshoots badly, the edge is sharper than the grid can
        // carry and clamping it leaves a staircase, so ease back to the first-order value there.
        const over = kind === 2 ? Math.abs(corrected - limited) / (0.5 * (hi - lo) + 1e-4) : 0;
        const fixed = limited + (value - limited) * smoothstep01(over);
        value = fixed + (value - fixed) * smoothstep01(wall / 0.5);
      }
      dst[k] = value;
    }
}

export function advectVelocity(g, dt = 1) {
  advect(g, g.u, g.s0, g.s2, 0, dt, true);
  advect(g, g.v, g.s1, g.s3, 1, dt, true);
  g.u.set(g.s0);
  g.v.set(g.s1);
  applyWalls(g);
}

/** Solid cells copy the mean of their fluid neighbours so that walls neither add nor eat dye. */
export function extendDye(g) {
  const { n, m, dye } = g;
  for (let j = 0; j < m; j++)
    for (let i = 0; i < n; i++) {
      if (g.type[i + j * n] !== SOLID) continue;
      let sum = 0;
      let count = 0;
      if (!solidAt(g, i - 1, j)) { sum += dye[i - 1 + j * n]; count++; }
      if (!solidAt(g, i + 1, j)) { sum += dye[i + 1 + j * n]; count++; }
      if (!solidAt(g, i, j - 1)) { sum += dye[i + (j - 1) * n]; count++; }
      if (!solidAt(g, i, j + 1)) { sum += dye[i + (j + 1) * n]; count++; }
      dye[i + j * n] = count ? sum / count : 0;
    }
}

export function advectDye(g, dt = 1, correct = true) {
  advect(g, g.dye, g.s0, g.s2, 2, dt, correct);
  g.dye.set(g.s0);
  extendDye(g);
}

/** Vorticity at cell corners: curl[i, j] sits on the lower-left corner of cell (i, j). */
export function computeCurl(g) {
  const { n, m, u, v, curl } = g;
  for (let j = 0; j < m; j++)
    for (let i = 0; i < n; i++) {
      const k = i + j * n;
      const walled = solidAt(g, i, j) || solidAt(g, i - 1, j) || solidAt(g, i, j - 1) || solidAt(g, i - 1, j - 1);
      curl[k] = walled ? 0 : v[k] - v[k - 1] - (u[k] - u[k - n]);
    }
}

// Confinement only acts on vorticity that is clearly there (above about 0.02 per step), so it
// sharpens real eddies without feeding rounding noise.
const gate = (w) => smoothstep01((Math.abs(w) - 0.02) / 0.08);

/** Explicit viscosity, vorticity confinement, the tunnel's outflow sponge and a global fade. */
export function applyForces(g, { confine = 0, viscosity = 0, fade = 1, dt = 1 } = {}) {
  const { n, m, u, v, curl } = g;
  const nu = g.s0;
  const nv = g.s1;
  const at = (f, i, j) => f[clamp(i, 0, n - 1) + clamp(j, 0, m - 1) * n];
  const w = (i, j) => (i < 0 || j < 0 || i >= n || j >= m ? 0 : Math.abs(curl[i + j * n]));
  for (let j = 0; j < m; j++)
    for (let i = 0; i < n; i++) {
      const k = i + j * n;
      let below = at(u, i, j - 1);
      let above = at(u, i, j + 1);
      if (g.slip) {
        if (j <= 1) below = u[k];
        if (j >= m - 2) above = u[k];
      }
      let nextU = u[k] + viscosity * dt * (at(u, i - 1, j) + at(u, i + 1, j) + below + above - 4 * u[k]);
      let nextV = v[k] + viscosity * dt * (at(v, i - 1, j) + at(v, i + 1, j) + at(v, i, j - 1) + at(v, i, j + 1) - 4 * v[k]);
      // Confinement pushes along N × ω, where N points up the gradient of |ω|.
      let gx = 0.25 * (w(i + 1, j) + w(i + 1, j + 1) - w(i - 1, j) - w(i - 1, j + 1));
      let gy = w(i, j + 1) - w(i, j);
      const wu = 0.5 * (curl[k] + (j + 1 < m ? curl[k + n] : 0));
      nextU += confine * dt * (gy / (Math.hypot(gx, gy) + 1e-4)) * wu * gate(wu);
      gx = w(i + 1, j) - w(i, j);
      gy = 0.25 * (w(i, j + 1) + w(i + 1, j + 1) - w(i, j - 1) - w(i + 1, j - 1));
      const wv = 0.5 * (curl[k] + (i + 1 < n ? curl[k + 1] : 0));
      nextV -= confine * dt * (gx / (Math.hypot(gx, gy) + 1e-4)) * wv * gate(wv);
      if (g.inflow > 0) {
        const t = clamp(((i + 0.5) / n - 0.88) / 0.12, 0, 1);
        const s = 0.08 * t * t * (3 - 2 * t);
        nextU += (g.inflow - nextU) * s;
        nextV -= nextV * s;
      }
      nu[k] = nextU * fade;
      nv[k] = nextV * fade;
    }
  u.set(nu);
  v.set(nv);
  applyWalls(g);
}

export function computeDivergence(g) {
  const { n, m, u, v, div } = g;
  for (let j = 0; j < m; j++)
    for (let i = 0; i < n; i++) {
      const k = i + j * n;
      div[k] = g.type[k] === FLUID ? u[k + 1] - u[k] + v[k + n] - v[k] : 0;
    }
}

export function maxDivergence(g) {
  computeDivergence(g);
  let worst = 0;
  for (let k = 0; k < g.div.length; k++) worst = Math.max(worst, Math.abs(g.div[k]));
  return worst;
}

/**
 * Red-black successive over-relaxation of ∇²p = div, starting from the pressure already in g.p.
 * The last two sweeps are plain Gauss-Seidel: over-relaxation converges fast but leaves a
 * cell-to-cell ripple behind, and an unrelaxed sweep is what smooths that away.
 */
export function relax(g, sweeps, omega) {
  const { n, m, p, div } = g;
  for (let k = 0; k < p.length; k++) if (g.type[k] !== FLUID) p[k] = 0;
  for (let s = 0; s < sweeps * 2; s++)
    for (let j = 1; j < m - 1; j++)
      for (let i = 1; i < n - 1; i++) {
        const k = i + j * n;
        if (g.type[k] !== FLUID || ((i + j) & 1) !== (s & 1)) continue;
        let sum = 0;
        let count = 0;
        if (g.type[k - 1] !== SOLID) { sum += p[k - 1]; count++; }
        if (g.type[k + 1] !== SOLID) { sum += p[k + 1]; count++; }
        if (g.type[k - n] !== SOLID) { sum += p[k - n]; count++; }
        if (g.type[k + n] !== SOLID) { sum += p[k + n]; count++; }
        const target = count ? (sum - div[k]) / count : 0;
        p[k] += (s >= sweeps * 2 - 4 ? 1 : omega) * (target - p[k]);
      }
}

export function subtractGradient(g) {
  const { n, m, u, v, p } = g;
  for (let j = 0; j < m; j++)
    for (let i = 0; i < n; i++) {
      const k = i + j * n;
      u[k] -= p[k] - (i > 0 ? p[k - 1] : 0);
      v[k] -= p[k] - (j > 0 ? p[k - n] : 0);
    }
  applyWalls(g);
}

/** Remove the divergent part of the velocity field. */
export function project(g, sweeps = 40, omega = 1.8) {
  applyWalls(g);
  computeDivergence(g);
  relax(g, sweeps, omega);
  subtractGradient(g);
}

/** One full step, in the same order as the GPU solver. */
export function step(g, { dt = 1, confine = 0, viscosity = 0, fade = 1, sweeps = 40, omega = 1.8 } = {}) {
  advectVelocity(g, dt);
  computeCurl(g);
  applyForces(g, { confine, viscosity, fade, dt });
  project(g, sweeps, omega);
  advectDye(g, dt);
}

export function totalDye(g) {
  let sum = 0;
  for (let k = 0; k < g.dye.length; k++) if (g.type[k] !== SOLID) sum += g.dye[k];
  return sum;
}

export function kineticEnergy(g) {
  let sum = 0;
  for (let k = 0; k < g.u.length; k++) sum += g.u[k] * g.u[k] + g.v[k] * g.v[k];
  return 0.5 * sum;
}
