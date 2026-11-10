// solver.js — sequential-impulse contact constraints. Pure: no DOM, no allocation.
//
// Each contact point carries three accumulated impulses: normal (clamped ≥ 0), friction (clamped
// to the Coulomb cone) and a pseudo impulse. The pseudo impulse acts on pseudo-velocities that
// move positions for one step and are then discarded, so pushing bodies out of penetration never
// turns into momentum (split impulses). Two-point manifolds solve both normal impulses together
// as a small complementarity problem, which is what keeps tall stacks from leaning.

/** Penetration that is tolerated and never corrected (metres). */
export const SLOP = 0.005;
/** Fraction of the remaining penetration removed per step. */
export const BAUMGARTE = 0.2;
/** Largest positional correction in one step (metres). */
export const MAX_CORRECTION = 0.2;
/** Approach speeds below this do not bounce (metres per second). */
export const RESTITUTION_THRESHOLD = 1;

/** Lever arms, effective masses, pre-solve approach speed and bias terms for every point. */
export function prepareContact(c, invDt) {
  const A = c.a;
  const B = c.b;
  const nx = c.nx;
  const ny = c.ny;
  const tx = ny;
  const ty = -nx;
  const mA = A.invMass;
  const mB = B.invMass;
  const iA = A.invInertia;
  const iB = B.invInertia;
  for (let k = 0; k < c.count; k++) {
    const p = k === 0 ? c.p0 : c.p1;
    const rAx = p.x - A.x;
    const rAy = p.y - A.y;
    const rBx = p.x - B.x;
    const rBy = p.y - B.y;
    p.rAx = rAx;
    p.rAy = rAy;
    p.rBx = rBx;
    p.rBy = rBy;
    const rnA = rAx * ny - rAy * nx;
    const rnB = rBx * ny - rBy * nx;
    const kn = mA + mB + iA * rnA * rnA + iB * rnB * rnB;
    p.massN = kn > 0 ? 1 / kn : 0;
    const rtA = rAx * ty - rAy * tx;
    const rtB = rBx * ty - rBy * tx;
    const kt = mA + mB + iA * rtA * rtA + iB * rtB * rtB;
    p.massT = kt > 0 ? 1 / kt : 0;
    const dvx = B.vx - B.w * rBy - A.vx + A.w * rAy;
    const dvy = B.vy + B.w * rBx - A.vy - A.w * rAx;
    p.vnPre = dvx * nx + dvy * ny;
    const sep = p.sep;
    // a speculative point (sep > 0) only limits the approach speed so the gap closes exactly
    p.bias = sep > 0 ? sep * invDt : 0;
    p.pbias = sep > 0 ? 0 : Math.min(BAUMGARTE * Math.max(-sep - SLOP, 0), MAX_CORRECTION) * invDt;
    p.pjn = 0;
  }

  c.block = false;
  if (c.count === 2) {
    const p0 = c.p0;
    const p1 = c.p1;
    const rn0A = p0.rAx * ny - p0.rAy * nx;
    const rn0B = p0.rBx * ny - p0.rBy * nx;
    const rn1A = p1.rAx * ny - p1.rAy * nx;
    const rn1B = p1.rBx * ny - p1.rBy * nx;
    const k11 = mA + mB + iA * rn0A * rn0A + iB * rn0B * rn0B;
    const k22 = mA + mB + iA * rn1A * rn1A + iB * rn1B * rn1B;
    const k12 = mA + mB + iA * rn0A * rn1A + iB * rn0B * rn1B;
    const det = k11 * k22 - k12 * k12;
    // only when the 2×2 system is well conditioned; otherwise the points are solved in turn
    if (k11 * k11 < 1000 * det) {
      const inv = 1 / det;
      c.block = true;
      c.k11 = k11;
      c.k12 = k12;
      c.k22 = k22;
      c.n11 = k22 * inv;
      c.n12 = -k12 * inv;
      c.n22 = k11 * inv;
    }
  }
}

/** Re-apply last step's accumulated impulses so the iteration starts near its answer. */
export function warmStartContact(c) {
  const A = c.a;
  const B = c.b;
  const nx = c.nx;
  const ny = c.ny;
  const mA = A.invMass;
  const mB = B.invMass;
  const iA = A.invInertia;
  const iB = B.invInertia;
  for (let k = 0; k < c.count; k++) {
    const p = k === 0 ? c.p0 : c.p1;
    const Px = nx * p.jn + ny * p.jt;
    const Py = ny * p.jn - nx * p.jt;
    A.vx -= mA * Px;
    A.vy -= mA * Py;
    A.w -= iA * (p.rAx * Py - p.rAy * Px);
    B.vx += mB * Px;
    B.vy += mB * Py;
    B.w += iB * (p.rBx * Py - p.rBy * Px);
  }
}

/** One Gauss–Seidel pass over a contact: friction, then normal, then pseudo impulses. */
export function solveContact(c) {
  const A = c.a;
  const B = c.b;
  const nx = c.nx;
  const ny = c.ny;
  const tx = ny;
  const ty = -nx;
  const mA = A.invMass;
  const mB = B.invMass;
  const iA = A.invInertia;
  const iB = B.invInertia;
  const mu = c.friction;
  const count = c.count;
  let vAx = A.vx;
  let vAy = A.vy;
  let wA = A.w;
  let vBx = B.vx;
  let vBy = B.vy;
  let wB = B.w;

  for (let k = 0; k < count; k++) {
    const p = k === 0 ? c.p0 : c.p1;
    const dvx = vBx - wB * p.rBy - vAx + wA * p.rAy;
    const dvy = vBy + wB * p.rBx - vAy - wA * p.rAx;
    let lambda = -p.massT * (dvx * tx + dvy * ty);
    const maxF = mu * p.jn;
    let acc = p.jt + lambda;
    if (acc > maxF) acc = maxF;
    else if (acc < -maxF) acc = -maxF;
    lambda = acc - p.jt;
    p.jt = acc;
    const Px = tx * lambda;
    const Py = ty * lambda;
    vAx -= mA * Px;
    vAy -= mA * Py;
    wA -= iA * (p.rAx * Py - p.rAy * Px);
    vBx += mB * Px;
    vBy += mB * Py;
    wB += iB * (p.rBx * Py - p.rBy * Px);
  }

  if (c.block) {
    // Find x ≥ 0 with vn = K·x + b ≥ 0 and x·vn = 0 by trying each of the four active sets.
    const p0 = c.p0;
    const p1 = c.p1;
    const a0 = p0.jn;
    const a1 = p1.jn;
    const vn0 = (vBx - wB * p0.rBy - vAx + wA * p0.rAy) * nx + (vBy + wB * p0.rBx - vAy - wA * p0.rAx) * ny;
    const vn1 = (vBx - wB * p1.rBy - vAx + wA * p1.rAy) * nx + (vBy + wB * p1.rBx - vAy - wA * p1.rAx) * ny;
    const b0 = vn0 + p0.bias - (c.k11 * a0 + c.k12 * a1);
    const b1 = vn1 + p1.bias - (c.k12 * a0 + c.k22 * a1);
    let x0 = -(c.n11 * b0 + c.n12 * b1);
    let x1 = -(c.n12 * b0 + c.n22 * b1);
    if (x0 < 0 || x1 < 0) {
      x0 = -b0 / c.k11;
      x1 = 0;
      if (x0 < 0 || c.k12 * x0 + b1 < 0) {
        x0 = 0;
        x1 = -b1 / c.k22;
        if (x1 < 0 || c.k12 * x1 + b0 < 0) {
          x1 = 0;
          if (b0 < 0 || b1 < 0) {
            x0 = a0;
            x1 = a1;
          }
        }
      }
    }
    const d0 = x0 - a0;
    const d1 = x1 - a1;
    p0.jn = x0;
    p1.jn = x1;
    const Px = nx * (d0 + d1);
    const Py = ny * (d0 + d1);
    vAx -= mA * Px;
    vAy -= mA * Py;
    wA -= iA * ((p0.rAx * ny - p0.rAy * nx) * d0 + (p1.rAx * ny - p1.rAy * nx) * d1);
    vBx += mB * Px;
    vBy += mB * Py;
    wB += iB * ((p0.rBx * ny - p0.rBy * nx) * d0 + (p1.rBx * ny - p1.rBy * nx) * d1);
  } else {
    for (let k = 0; k < count; k++) {
      const p = k === 0 ? c.p0 : c.p1;
      const dvx = vBx - wB * p.rBy - vAx + wA * p.rAy;
      const dvy = vBy + wB * p.rBx - vAy - wA * p.rAx;
      let lambda = -p.massN * (dvx * nx + dvy * ny + p.bias);
      let acc = p.jn + lambda;
      if (acc < 0) acc = 0;
      lambda = acc - p.jn;
      p.jn = acc;
      const Px = nx * lambda;
      const Py = ny * lambda;
      vAx -= mA * Px;
      vAy -= mA * Py;
      wA -= iA * (p.rAx * Py - p.rAy * Px);
      vBx += mB * Px;
      vBy += mB * Py;
      wB += iB * (p.rBx * Py - p.rBy * Px);
    }
  }
  A.vx = vAx;
  A.vy = vAy;
  A.w = wA;
  B.vx = vBx;
  B.vy = vBy;
  B.w = wB;

  let qAx = A.pvx;
  let qAy = A.pvy;
  let qwA = A.pw;
  let qBx = B.pvx;
  let qBy = B.pvy;
  let qwB = B.pw;
  for (let k = 0; k < count; k++) {
    const p = k === 0 ? c.p0 : c.p1;
    const dvx = qBx - qwB * p.rBy - qAx + qwA * p.rAy;
    const dvy = qBy + qwB * p.rBx - qAy - qwA * p.rAx;
    let lambda = -p.massN * (dvx * nx + dvy * ny - p.pbias);
    let acc = p.pjn + lambda;
    if (acc < 0) acc = 0;
    lambda = acc - p.pjn;
    p.pjn = acc;
    const Px = nx * lambda;
    const Py = ny * lambda;
    qAx -= mA * Px;
    qAy -= mA * Py;
    qwA -= iA * (p.rAx * Py - p.rAy * Px);
    qBx += mB * Px;
    qBy += mB * Py;
    qwB += iB * (p.rBx * Py - p.rBy * Px);
  }
  A.pvx = qAx;
  A.pvy = qAy;
  A.pw = qwA;
  B.pvx = qBx;
  B.pvy = qBy;
  B.pw = qwB;
}

/**
 * Bounce: after the velocity iterations, points that were closing faster than the threshold and
 * actually carried load are driven to the reflected speed -e · (approach speed).
 */
export function applyRestitution(c) {
  const e = c.restitution;
  if (e === 0) return;
  const A = c.a;
  const B = c.b;
  const nx = c.nx;
  const ny = c.ny;
  const mA = A.invMass;
  const mB = B.invMass;
  const iA = A.invInertia;
  const iB = B.invInertia;
  for (let k = 0; k < c.count; k++) {
    const p = k === 0 ? c.p0 : c.p1;
    if (p.vnPre > -RESTITUTION_THRESHOLD || p.jn === 0) continue;
    const dvx = B.vx - B.w * p.rBy - A.vx + A.w * p.rAy;
    const dvy = B.vy + B.w * p.rBx - A.vy - A.w * p.rAx;
    let lambda = -p.massN * (dvx * nx + dvy * ny + e * p.vnPre);
    const acc = Math.max(p.jn + lambda, 0);
    lambda = acc - p.jn;
    p.jn = acc;
    const Px = nx * lambda;
    const Py = ny * lambda;
    A.vx -= mA * Px;
    A.vy -= mA * Py;
    A.w -= iA * (p.rAx * Py - p.rAy * Px);
    B.vx += mB * Px;
    B.vy += mB * Py;
    B.w += iB * (p.rBx * Py - p.rBy * Px);
  }
}
