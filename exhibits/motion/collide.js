// collide.js — narrowphase. Builds contact manifolds of up to two points with stable feature
// ids, so the solver can carry accumulated impulses from one step to the next. Pure: no DOM.
import { POLYGON, MARGIN } from './body.js';

export class ContactPoint {
  constructor() {
    this.x = 0;
    this.y = 0;
    this.sep = 0; // signed distance along the normal: negative means penetration
    this.id = 0;
    this.jn = 0; // accumulated normal impulse
    this.jt = 0; // accumulated friction impulse
    this.pjn = 0; // accumulated pseudo (position-only) impulse
    this.rAx = 0;
    this.rAy = 0;
    this.rBx = 0;
    this.rBy = 0;
    this.massN = 0;
    this.massT = 0;
    this.vnPre = 0;
    this.bias = 0;
    this.pbias = 0;
  }
}

/** A pair of bodies whose AABBs overlap. The normal points from body a to body b. */
export class Contact {
  constructor() {
    this.a = null;
    this.b = null;
    this.key = 0;
    this.count = 0;
    this.nx = 0;
    this.ny = 1;
    this.p0 = new ContactPoint();
    this.p1 = new ContactPoint();
    this.friction = 0;
    this.restitution = 0;
    this.stamp = 0;
    // 2×2 normal system of a two-point manifold and its inverse (see solver.js)
    this.block = false;
    this.k11 = 0;
    this.k12 = 0;
    this.k22 = 0;
    this.n11 = 0;
    this.n12 = 0;
    this.n22 = 0;
  }
}

// A reference face on body a is kept unless b's is clearly better, so the feature ids of a
// resting contact do not flip between frames.
const FACE_BIAS = 0.001;

let outSep = 0;
let outEdge = 0;

/** Largest separation of polygon B from any face of polygon A (writes outSep / outEdge). */
function maxSeparation(A, B) {
  const nA = A.shape.n;
  const nB = B.shape.n;
  const va = A.wv;
  const na = A.wn;
  const vb = B.wv;
  let best = -Infinity;
  let edge = 0;
  for (let i = 0; i < nA; i++) {
    const nx = na[2 * i];
    const ny = na[2 * i + 1];
    const vx = va[2 * i];
    const vy = va[2 * i + 1];
    let min = Infinity;
    for (let j = 0; j < nB; j++) {
      const d = nx * (vb[2 * j] - vx) + ny * (vb[2 * j + 1] - vy);
      if (d < min) min = d;
    }
    if (min > best) {
      best = min;
      edge = i;
    }
  }
  outSep = best;
  outEdge = edge;
}

function circleCircle(c, A, B) {
  const rA = A.shape.radius;
  const rB = B.shape.radius;
  const dx = B.x - A.x;
  const dy = B.y - A.y;
  const d2 = dx * dx + dy * dy;
  const reach = rA + rB + MARGIN;
  if (d2 > reach * reach) {
    c.count = 0;
    return;
  }
  const d = Math.sqrt(d2);
  let nx = 0;
  let ny = 1;
  if (d > 1e-9) {
    nx = dx / d;
    ny = dy / d;
  }
  const sep = d - rA - rB;
  const p = c.p0;
  c.nx = nx;
  c.ny = ny;
  c.count = 1;
  p.x = A.x + nx * (rA + 0.5 * sep);
  p.y = A.y + ny * (rA + 0.5 * sep);
  p.sep = sep;
  p.id = 0;
}

/** A is the polygon, B the circle. Handles the face region, both vertex regions and a buried centre. */
function polygonCircle(c, A, B) {
  const cx = B.x;
  const cy = B.y;
  const r = B.shape.radius;
  const n = A.shape.n;
  const v = A.wv;
  const nm = A.wn;
  let best = -Infinity;
  let bi = 0;
  for (let i = 0; i < n; i++) {
    const s = nm[2 * i] * (cx - v[2 * i]) + nm[2 * i + 1] * (cy - v[2 * i + 1]);
    if (s > r + MARGIN) {
      c.count = 0;
      return;
    }
    if (s > best) {
      best = s;
      bi = i;
    }
  }
  const i2 = (bi + 1) % n;
  const x1 = v[2 * bi];
  const y1 = v[2 * bi + 1];
  const x2 = v[2 * i2];
  const y2 = v[2 * i2 + 1];
  let nx = nm[2 * bi];
  let ny = nm[2 * bi + 1];
  let sep = best - r;
  if (best > 1e-9) {
    const u1 = (cx - x1) * (x2 - x1) + (cy - y1) * (y2 - y1);
    const u2 = (cx - x2) * (x1 - x2) + (cy - y2) * (y1 - y2);
    if (u1 <= 0 || u2 <= 0) {
      const qx = u1 <= 0 ? x1 : x2;
      const qy = u1 <= 0 ? y1 : y2;
      const dx = cx - qx;
      const dy = cy - qy;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d > r + MARGIN) {
        c.count = 0;
        return;
      }
      if (d > 1e-9) {
        nx = dx / d;
        ny = dy / d;
      }
      sep = d - r;
    }
  }
  const p = c.p0;
  c.nx = nx;
  c.ny = ny;
  c.count = 1;
  p.x = cx - nx * (r + 0.5 * sep);
  p.y = cy - ny * (r + 0.5 * sep);
  p.sep = sep;
  p.id = 0;
}

/**
 * Separating-axis test, then the incident edge is clipped against the side planes of the
 * reference face. Ids encode (which body owns the reference face, its edge, the incident
 * vertex or the clip that produced the point).
 */
function polygonPolygon(c, A, B) {
  maxSeparation(A, B);
  const sA = outSep;
  const eA = outEdge;
  if (sA > MARGIN) {
    c.count = 0;
    return;
  }
  maxSeparation(B, A);
  const sB = outSep;
  const eB = outEdge;
  if (sB > MARGIN) {
    c.count = 0;
    return;
  }
  const flip = sB > sA + FACE_BIAS;
  const R = flip ? B : A;
  const I = flip ? A : B;
  const e = flip ? eB : eA;
  const rv = R.wv;
  const e2 = (e + 1) % R.shape.n;
  const nx = R.wn[2 * e];
  const ny = R.wn[2 * e + 1];
  const v1x = rv[2 * e];
  const v1y = rv[2 * e + 1];

  // incident edge: the face of I most opposed to the reference normal
  const nI = I.shape.n;
  const inm = I.wn;
  let ie = 0;
  let minDot = Infinity;
  for (let j = 0; j < nI; j++) {
    const d = nx * inm[2 * j] + ny * inm[2 * j + 1];
    if (d < minDot) {
      minDot = d;
      ie = j;
    }
  }
  const j2 = (ie + 1) % nI;
  const iv = I.wv;
  let ax = iv[2 * ie];
  let ay = iv[2 * ie + 1];
  let aid = ie;
  let bx = iv[2 * j2];
  let by = iv[2 * j2 + 1];
  let bid = j2;

  // clip to the reference face's extent along its tangent
  const tx = -ny;
  const ty = nx;
  const lo = tx * v1x + ty * v1y;
  const hi = tx * rv[2 * e2] + ty * rv[2 * e2 + 1];
  let da = tx * ax + ty * ay;
  let db = tx * bx + ty * by;
  if (da < lo && db < lo) {
    c.count = 0;
    return;
  }
  if (da < lo) {
    const t = (lo - da) / (db - da);
    ax += t * (bx - ax);
    ay += t * (by - ay);
    da = lo;
    aid = 8 + 2 * ie;
  } else if (db < lo) {
    const t = (lo - db) / (da - db);
    bx += t * (ax - bx);
    by += t * (ay - by);
    db = lo;
    bid = 8 + 2 * ie;
  }
  if (da > hi && db > hi) {
    c.count = 0;
    return;
  }
  if (da > hi) {
    const t = (hi - da) / (db - da);
    ax += t * (bx - ax);
    ay += t * (by - ay);
    aid = 9 + 2 * ie;
  } else if (db > hi) {
    const t = (hi - db) / (da - db);
    bx += t * (ax - bx);
    by += t * (ay - by);
    bid = 9 + 2 * ie;
  }

  const base = (flip ? 4096 : 0) + 64 * e;
  const sa = nx * (ax - v1x) + ny * (ay - v1y);
  const sb = nx * (bx - v1x) + ny * (by - v1y);
  let count = 0;
  if (sa <= MARGIN) {
    const p = c.p0;
    p.x = ax - 0.5 * sa * nx;
    p.y = ay - 0.5 * sa * ny;
    p.sep = sa;
    p.id = base + aid;
    count = 1;
  }
  if (sb <= MARGIN) {
    const p = count === 0 ? c.p0 : c.p1;
    p.x = bx - 0.5 * sb * nx;
    p.y = by - 0.5 * sb * ny;
    p.sep = sb;
    p.id = base + bid;
    count++;
  }
  c.count = count;
  c.nx = flip ? -nx : nx;
  c.ny = flip ? -ny : ny;
}

/**
 * Recompute the manifold of a contact from the bodies' current poses, then move the old
 * accumulated impulses onto the new points that share a feature id (warm starting).
 * When the shapes are mixed, body a must be the polygon.
 */
export function updateManifold(c) {
  const p0 = c.p0;
  const p1 = c.p1;
  const oldCount = c.count;
  const id0 = p0.id;
  const jn0 = p0.jn;
  const jt0 = p0.jt;
  const id1 = p1.id;
  const jn1 = p1.jn;
  const jt1 = p1.jt;
  const A = c.a;
  const B = c.b;
  if (A.shape.kind === POLYGON) {
    if (B.shape.kind === POLYGON) polygonPolygon(c, A, B);
    else polygonCircle(c, A, B);
  } else circleCircle(c, A, B);
  for (let k = 0; k < c.count; k++) {
    const p = k === 0 ? p0 : p1;
    if (oldCount > 0 && p.id === id0) {
      p.jn = jn0;
      p.jt = jt0;
    } else if (oldCount > 1 && p.id === id1) {
      p.jn = jn1;
      p.jt = jt1;
    } else {
      p.jn = 0;
      p.jt = 0;
    }
  }
}
