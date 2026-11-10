// joints.js — revolute, distance / rope and mouse joints. Pure: no DOM.
// Every joint exposes { kind, a, b, collide, prepare(invDt), solve() }. Like contacts, joints
// remove positional error through pseudo-velocities, so correcting drift never adds energy.
import { BAUMGARTE, MAX_CORRECTION } from './solver.js';

function toLocal(body, wx, wy) {
  const dx = wx - body.x;
  const dy = wy - body.y;
  return [body.cos * dx + body.sin * dy, -body.sin * dx + body.cos * dy];
}

const clampCorrection = (c, invDt) =>
  Math.max(-MAX_CORRECTION, Math.min(MAX_CORRECTION, BAUMGARTE * c)) * invDt;

/** Pins a point of body a to a point of body b. opts: { lower, upper } relative-angle limits in radians. */
export class RevoluteJoint {
  constructor(a, b, wx, wy, opts = {}) {
    this.kind = 'revolute';
    this.a = a;
    this.b = b;
    this.collide = false;
    [this.lax, this.lay] = toLocal(a, wx, wy);
    [this.lbx, this.lby] = toLocal(b, wx, wy);
    this.ref = b.a - a.a;
    this.limited = opts.lower !== undefined && opts.upper !== undefined;
    this.lower = this.limited ? opts.lower : 0;
    this.upper = this.limited ? opts.upper : 0;
    this.jx = 0;
    this.jy = 0;
    this.jLower = 0;
    this.jUpper = 0;
    this.rAx = 0;
    this.rAy = 0;
    this.rBx = 0;
    this.rBy = 0;
    this.m11 = 0;
    this.m12 = 0;
    this.m22 = 0;
    this.pbx = 0;
    this.pby = 0;
    this.massAng = 0;
    this.cLower = 0;
    this.cUpper = 0;
    this.invDt = 0;
  }

  prepare(invDt) {
    const A = this.a;
    const B = this.b;
    const rAx = A.cos * this.lax - A.sin * this.lay;
    const rAy = A.sin * this.lax + A.cos * this.lay;
    const rBx = B.cos * this.lbx - B.sin * this.lby;
    const rBy = B.sin * this.lbx + B.cos * this.lby;
    this.rAx = rAx;
    this.rAy = rAy;
    this.rBx = rBx;
    this.rBy = rBy;
    const mA = A.invMass;
    const mB = B.invMass;
    const iA = A.invInertia;
    const iB = B.invInertia;
    const k11 = mA + mB + iA * rAy * rAy + iB * rBy * rBy;
    const k12 = -iA * rAx * rAy - iB * rBx * rBy;
    const k22 = mA + mB + iA * rAx * rAx + iB * rBx * rBx;
    const det = k11 * k22 - k12 * k12;
    const inv = det !== 0 ? 1 / det : 0;
    this.m11 = k22 * inv;
    this.m12 = -k12 * inv;
    this.m22 = k11 * inv;
    this.pbx = -clampCorrection(B.x + rBx - A.x - rAx, invDt);
    this.pby = -clampCorrection(B.y + rBy - A.y - rAy, invDt);
    this.invDt = invDt;
    if (this.limited) {
      const angle = B.a - A.a - this.ref;
      this.cLower = angle - this.lower;
      this.cUpper = this.upper - angle;
      const k = iA + iB;
      this.massAng = k > 0 ? 1 / k : 0;
    }
    const Px = this.jx;
    const Py = this.jy;
    const L = this.jLower - this.jUpper;
    A.vx -= mA * Px;
    A.vy -= mA * Py;
    A.w -= iA * (rAx * Py - rAy * Px + L);
    B.vx += mB * Px;
    B.vy += mB * Py;
    B.w += iB * (rBx * Py - rBy * Px + L);
  }

  solve() {
    const A = this.a;
    const B = this.b;
    const mA = A.invMass;
    const mB = B.invMass;
    const iA = A.invInertia;
    const iB = B.invInertia;
    if (this.limited) this.solveLimits(A, B, iA, iB);
    const rAx = this.rAx;
    const rAy = this.rAy;
    const rBx = this.rBx;
    const rBy = this.rBy;
    const cx = B.vx - B.w * rBy - A.vx + A.w * rAy;
    const cy = B.vy + B.w * rBx - A.vy - A.w * rAx;
    const Px = -(this.m11 * cx + this.m12 * cy);
    const Py = -(this.m12 * cx + this.m22 * cy);
    this.jx += Px;
    this.jy += Py;
    A.vx -= mA * Px;
    A.vy -= mA * Py;
    A.w -= iA * (rAx * Py - rAy * Px);
    B.vx += mB * Px;
    B.vy += mB * Py;
    B.w += iB * (rBx * Py - rBy * Px);

    const qx = B.pvx - B.pw * rBy - A.pvx + A.pw * rAy - this.pbx;
    const qy = B.pvy + B.pw * rBx - A.pvy - A.pw * rAx - this.pby;
    const Qx = -(this.m11 * qx + this.m12 * qy);
    const Qy = -(this.m12 * qx + this.m22 * qy);
    A.pvx -= mA * Qx;
    A.pvy -= mA * Qy;
    A.pw -= iA * (rAx * Qy - rAy * Qx);
    B.pvx += mB * Qx;
    B.pvy += mB * Qy;
    B.pw += iB * (rBx * Qy - rBy * Qx);
  }

  /** Each limit is a one-sided angular constraint with its own accumulated impulse. */
  solveLimits(A, B, iA, iB) {
    const m = this.massAng;
    const invDt = this.invDt;
    let bias = this.cLower > 0 ? this.cLower * invDt : 0;
    let lambda = -m * (B.w - A.w + bias);
    let acc = Math.max(this.jLower + lambda, 0);
    lambda = acc - this.jLower;
    this.jLower = acc;
    A.w -= iA * lambda;
    B.w += iB * lambda;

    bias = this.cUpper > 0 ? this.cUpper * invDt : 0;
    lambda = -m * (A.w - B.w + bias);
    acc = Math.max(this.jUpper + lambda, 0);
    lambda = acc - this.jUpper;
    this.jUpper = acc;
    A.w += iA * lambda;
    B.w -= iB * lambda;

    if (this.cLower < 0) {
      const push = -m * (B.pw - A.pw + clampCorrection(this.cLower, invDt));
      if (push > 0) {
        A.pw -= iA * push;
        B.pw += iB * push;
      }
    }
    if (this.cUpper < 0) {
      const push = -m * (A.pw - B.pw + clampCorrection(this.cUpper, invDt));
      if (push > 0) {
        A.pw += iA * push;
        B.pw -= iB * push;
      }
    }
  }
}

/**
 * Keeps two anchor points a fixed distance apart. With opts.rope the constraint only acts when
 * the points try to move further apart than the length, like a rope going taut.
 */
export class DistanceJoint {
  constructor(a, b, ax, ay, bx, by, opts = {}) {
    this.kind = 'distance';
    this.a = a;
    this.b = b;
    this.collide = false;
    [this.lax, this.lay] = toLocal(a, ax, ay);
    [this.lbx, this.lby] = toLocal(b, bx, by);
    this.length = opts.length === undefined ? Math.hypot(bx - ax, by - ay) : opts.length;
    this.rope = !!opts.rope;
    /** A hidden joint is drawn only in the internals view. */
    this.hidden = !!opts.hidden;
    this.j = 0;
    this.rAx = 0;
    this.rAy = 0;
    this.rBx = 0;
    this.rBy = 0;
    this.ux = 0;
    this.uy = 1;
    this.mass = 0;
    this.bias = 0;
    this.pb = 0;
    this.correct = false;
  }

  prepare(invDt) {
    const A = this.a;
    const B = this.b;
    const rAx = A.cos * this.lax - A.sin * this.lay;
    const rAy = A.sin * this.lax + A.cos * this.lay;
    const rBx = B.cos * this.lbx - B.sin * this.lby;
    const rBy = B.sin * this.lbx + B.cos * this.lby;
    const dx = B.x + rBx - A.x - rAx;
    const dy = B.y + rBy - A.y - rAy;
    const len = Math.hypot(dx, dy);
    const ux = len > 1e-9 ? dx / len : 0;
    const uy = len > 1e-9 ? dy / len : 1;
    const crA = rAx * uy - rAy * ux;
    const crB = rBx * uy - rBy * ux;
    const k = A.invMass + B.invMass + A.invInertia * crA * crA + B.invInertia * crB * crB;
    this.mass = k > 0 ? 1 / k : 0;
    const C = len - this.length;
    // a slack rope may lengthen just fast enough to go taut by the end of the step
    this.bias = this.rope && C < 0 ? C * invDt : 0;
    this.correct = !this.rope || C > 0;
    this.pb = -clampCorrection(C, invDt);
    this.rAx = rAx;
    this.rAy = rAy;
    this.rBx = rBx;
    this.rBy = rBy;
    this.ux = ux;
    this.uy = uy;
    this.apply(A, B, this.j);
  }

  apply(A, B, impulse) {
    const Px = this.ux * impulse;
    const Py = this.uy * impulse;
    A.vx -= A.invMass * Px;
    A.vy -= A.invMass * Py;
    A.w -= A.invInertia * (this.rAx * Py - this.rAy * Px);
    B.vx += B.invMass * Px;
    B.vy += B.invMass * Py;
    B.w += B.invInertia * (this.rBx * Py - this.rBy * Px);
  }

  solve() {
    const A = this.a;
    const B = this.b;
    const ux = this.ux;
    const uy = this.uy;
    const rAx = this.rAx;
    const rAy = this.rAy;
    const rBx = this.rBx;
    const rBy = this.rBy;
    const cdot = ux * (B.vx - B.w * rBy - A.vx + A.w * rAy) + uy * (B.vy + B.w * rBx - A.vy - A.w * rAx);
    let lambda = -this.mass * (cdot + this.bias);
    if (this.rope) {
      const acc = Math.min(this.j + lambda, 0);
      lambda = acc - this.j;
      this.j = acc;
    } else this.j += lambda;
    this.apply(A, B, lambda);

    if (!this.correct) return;
    const qdot = ux * (B.pvx - B.pw * rBy - A.pvx + A.pw * rAy) + uy * (B.pvy + B.pw * rBx - A.pvy - A.pw * rAx);
    let push = -this.mass * (qdot - this.pb);
    if (this.rope && push > 0) push = 0;
    const Qx = ux * push;
    const Qy = uy * push;
    A.pvx -= A.invMass * Qx;
    A.pvy -= A.invMass * Qy;
    A.pw -= A.invInertia * (rAx * Qy - rAy * Qx);
    B.pvx += B.invMass * Qx;
    B.pvy += B.invMass * Qy;
    B.pw += B.invInertia * (rBx * Qy - rBy * Qx);
  }
}

/**
 * A damped spring between a point on a body and a moving target, used for dragging. Soft by
 * construction (frequency and damping ratio), with a force cap so a drag cannot crush a pile.
 */
export class MouseJoint {
  constructor(ground, body, wx, wy, opts = {}) {
    this.kind = 'mouse';
    this.a = ground;
    this.b = body;
    this.collide = true;
    [this.lbx, this.lby] = toLocal(body, wx, wy);
    this.tx = wx;
    this.ty = wy;
    this.frequency = opts.frequency || 5;
    this.damping = opts.damping || 0.7;
    this.maxForce = opts.maxForce || 600 * body.mass;
    this.jx = 0;
    this.jy = 0;
    this.rx = 0;
    this.ry = 0;
    this.m11 = 0;
    this.m12 = 0;
    this.m22 = 0;
    this.cx = 0;
    this.cy = 0;
    this.gamma = 0;
    this.maxImpulse = 0;
  }

  setTarget(x, y) {
    this.tx = x;
    this.ty = y;
  }

  prepare(invDt) {
    const B = this.b;
    const h = 1 / invDt;
    const omega = 2 * Math.PI * this.frequency;
    const d = 2 * B.mass * this.damping * omega;
    const k = B.mass * omega * omega;
    const gamma = 1 / (h * (d + h * k));
    const beta = h * k * gamma;
    const rx = B.cos * this.lbx - B.sin * this.lby;
    const ry = B.sin * this.lbx + B.cos * this.lby;
    const mB = B.invMass;
    const iB = B.invInertia;
    const k11 = mB + iB * ry * ry + gamma;
    const k12 = -iB * rx * ry;
    const k22 = mB + iB * rx * rx + gamma;
    const inv = 1 / (k11 * k22 - k12 * k12);
    this.m11 = k22 * inv;
    this.m12 = -k12 * inv;
    this.m22 = k11 * inv;
    this.cx = beta * (B.x + rx - this.tx);
    this.cy = beta * (B.y + ry - this.ty);
    this.gamma = gamma;
    this.maxImpulse = this.maxForce * h;
    this.rx = rx;
    this.ry = ry;
    B.w *= 0.98;
    B.vx += mB * this.jx;
    B.vy += mB * this.jy;
    B.w += iB * (rx * this.jy - ry * this.jx);
  }

  solve() {
    const B = this.b;
    const rx = this.rx;
    const ry = this.ry;
    const cdx = B.vx - B.w * ry + this.cx + this.gamma * this.jx;
    const cdy = B.vy + B.w * rx + this.cy + this.gamma * this.jy;
    const oldX = this.jx;
    const oldY = this.jy;
    this.jx -= this.m11 * cdx + this.m12 * cdy;
    this.jy -= this.m12 * cdx + this.m22 * cdy;
    const mag = Math.hypot(this.jx, this.jy);
    if (mag > this.maxImpulse) {
      this.jx *= this.maxImpulse / mag;
      this.jy *= this.maxImpulse / mag;
    }
    const Px = this.jx - oldX;
    const Py = this.jy - oldY;
    B.vx += B.invMass * Px;
    B.vy += B.invMass * Py;
    B.w += B.invInertia * (rx * Py - ry * Px);
  }
}
