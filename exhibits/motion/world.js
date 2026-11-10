// world.js — the simulation loop: broadphase, contact bookkeeping, islands and sleeping,
// integration. Pure: no DOM. Deterministic: the same calls always give the same bits.
import { Body, STATIC, KINEMATIC, DYNAMIC, CIRCLE, POLYGON, circleShape, polygonShape, boxShape } from './body.js';
import { Contact, updateManifold } from './collide.js';
import { prepareContact, warmStartContact, solveContact, applyRestitution } from './solver.js';

/** The fixed timestep every scene and test uses (seconds). */
export const DT = 1 / 120;

const PAIR = 1048576; // body ids stay below 2^20, so (lo, hi) packs exactly into one double
const SLEEP_LINEAR = 0.02;
const SLEEP_ANGULAR = 0.035;
const SLEEP_TIME = 0.5;
const MAX_TRANSLATION = 2;
const MAX_ROTATION = 0.5 * Math.PI;

const now = typeof performance !== 'undefined' && performance.now ? () => performance.now() : () => Date.now();
const pairKey = (a, b) => (a.id < b.id ? a.id * PAIR + b.id : b.id * PAIR + a.id);

function find(parent, i) {
  while (parent[i] !== i) {
    parent[i] = parent[parent[i]];
    i = parent[i];
  }
  return i;
}

function distanceToShape(b, x, y) {
  if (b.shape.kind === CIRCLE) return Math.hypot(x - b.x, y - b.y) - b.shape.radius;
  let d = -Infinity;
  for (let i = 0, end = 2 * b.shape.n; i < end; i += 2) {
    d = Math.max(d, b.wn[i] * (x - b.wv[i]) + b.wn[i + 1] * (y - b.wv[i + 1]));
  }
  return d;
}

export class World {
  /** opts: { gravity = 9.8 (downward, m/s²), iterations = 8, angularDamping = 0, allowSleep = true } */
  constructor(opts = {}) {
    this.gravityX = 0;
    this.gravityY = -(opts.gravity === undefined ? 9.8 : opts.gravity);
    this.iterations = opts.iterations || 8;
    this.angularDamping = opts.angularDamping || 0;
    this.allowSleep = opts.allowSleep !== false;
    this.bodies = [];
    this.sorted = [];
    this.joints = [];
    this.contacts = [];
    this.contactMap = new Map();
    this.pool = [];
    this.noCollide = new Set();
    this.active = [];
    this.activeJoints = [];
    this.parent = new Int32Array(64);
    this.islandActive = new Uint8Array(64);
    this.nextId = 1;
    this.stepCount = 0;
    /** A shapeless static body for joints that attach to the world itself. */
    this.fixed = new Body(0, null, STATIC, 0, 0, 0, {});
    this.awakeCount = 0;
    this.moving = true;
    this.manifoldCount = 0;
    this.pointCount = 0;
    // accumulated wall-clock time per phase; the UI averages and resets these
    this.collideMs = 0;
    this.solveMs = 0;
    this.timedSteps = 0;
  }

  addBody(shape, x, y, opts = {}) {
    const type = opts.type === undefined ? DYNAMIC : opts.type;
    const b = new Body(this.nextId++, shape, type, x, y, opts.angle || 0, opts);
    b.index = this.bodies.length;
    this.bodies.push(b);
    this.sorted.push(b);
    return b;
  }

  addCircle(x, y, radius, opts) {
    return this.addBody(circleShape(radius), x, y, opts);
  }

  addBox(x, y, w, h, opts) {
    return this.addBody(boxShape(w, h), x, y, opts);
  }

  /** points are relative to (x, y); the body is placed at the polygon's centroid. */
  addPolygon(x, y, points, opts) {
    const shape = polygonShape(points);
    return this.addBody(shape, x + shape.cx, y + shape.cy, opts);
  }

  removeBody(b) {
    const i = this.bodies.indexOf(b);
    if (i < 0) return;
    this.bodies.splice(i, 1);
    for (let k = i; k < this.bodies.length; k++) this.bodies[k].index = k;
    this.sorted.splice(this.sorted.indexOf(b), 1);
    for (let k = this.joints.length - 1; k >= 0; k--) {
      const j = this.joints[k];
      if (j.a === b || j.b === b) this.removeJoint(j);
    }
    for (let k = this.contacts.length - 1; k >= 0; k--) {
      const c = this.contacts[k];
      if (c.a === b || c.b === b) this._release(k);
    }
    this.wakeAll();
  }

  addJoint(j) {
    this.joints.push(j);
    if (!j.collide) {
      const key = pairKey(j.a, j.b);
      this.noCollide.add(key);
      const c = this.contactMap.get(key);
      if (c !== undefined) this._release(this.contacts.indexOf(c));
    }
    if (j.kind === 'mouse') j.b.held = true;
    this.wake(j.a);
    this.wake(j.b);
    return j;
  }

  removeJoint(j) {
    const i = this.joints.indexOf(j);
    if (i < 0) return;
    this.joints.splice(i, 1);
    if (!j.collide) this.noCollide.delete(pairKey(j.a, j.b));
    if (j.kind === 'mouse') j.b.held = false;
    this.wake(j.a);
    this.wake(j.b);
  }

  wake(b) {
    if (b.type !== DYNAMIC) return;
    b.awake = true;
    b.sleepTime = 0;
    this.moving = true;
  }

  wakeAll() {
    for (let i = 0; i < this.bodies.length; i++) this.wake(this.bodies[i]);
  }

  setGravity(g) {
    this.gravityY = -g;
    this.wakeAll();
  }

  /** The dynamic body under (x, y), or the nearest one within `slack` metres of it. */
  pick(x, y, slack = 0) {
    let best = null;
    let bestD = slack;
    for (let i = 0; i < this.bodies.length; i++) {
      const b = this.bodies[i];
      if (b.type !== DYNAMIC) continue;
      if (x < b.minX - slack || x > b.maxX + slack || y < b.minY - slack || y > b.maxY + slack) continue;
      const d = distanceToShape(b, x, y);
      if (d <= bestD) {
        bestD = d;
        best = b;
      }
    }
    return best;
  }

  /** A radial velocity kick that falls off with distance from (x, y). */
  explode(x, y, speed, radius) {
    for (let i = 0; i < this.bodies.length; i++) {
      const b = this.bodies[i];
      if (b.type !== DYNAMIC) continue;
      const dx = b.x - x;
      const dy = b.y - y;
      const d = Math.hypot(dx, dy);
      const kick = speed / (1 + (d * d) / (radius * radius));
      const inv = d > 1e-6 ? 1 / d : 0;
      b.vx += dx * inv * kick;
      b.vy += (d > 1e-6 ? dy * inv : 1) * kick;
      this.wake(b);
    }
  }

  /** Kinetic plus gravitational potential energy of all dynamic bodies (joules, y = 0 is the floor). */
  energy() {
    let e = 0;
    for (let i = 0; i < this.bodies.length; i++) {
      const b = this.bodies[i];
      if (b.type !== DYNAMIC) continue;
      e += 0.5 * b.mass * (b.vx * b.vx + b.vy * b.vy) + 0.5 * b.inertia * b.w * b.w;
      e -= b.mass * (this.gravityX * b.x + this.gravityY * b.y);
    }
    return e;
  }

  step(dt = DT) {
    const t0 = now();
    this._collide();
    this._islands();
    const t1 = now();
    this._solve(dt);
    this.stepCount++;
    this.collideMs += t1 - t0;
    this.solveMs += now() - t1;
    this.timedSteps++;
  }

  _release(k) {
    const contacts = this.contacts;
    const c = contacts[k];
    const last = contacts.pop();
    if (k < contacts.length) contacts[k] = last;
    this.contactMap.delete(c.key);
    c.a = null;
    c.b = null;
    c.count = 0;
    this.pool.push(c);
  }

  /** Sort-and-sweep along x. The list stays nearly sorted between steps, so insertion sort is cheap. */
  _collide() {
    const s = this.sorted;
    const n = s.length;
    for (let i = 1; i < n; i++) {
      const b = s[i];
      const key = b.minX;
      let j = i - 1;
      while (j >= 0 && s[j].minX > key) {
        s[j + 1] = s[j];
        j--;
      }
      s[j + 1] = b;
    }
    const stamp = this.stepCount;
    for (let i = 0; i < n; i++) {
      const a = s[i];
      const maxX = a.maxX;
      for (let j = i + 1; j < n; j++) {
        const b = s[j];
        if (b.minX > maxX) break;
        if (a.maxY < b.minY || b.maxY < a.minY) continue;
        if (a.type !== DYNAMIC && b.type !== DYNAMIC) continue;
        this._pair(a, b, stamp);
      }
    }
    for (let k = this.contacts.length - 1; k >= 0; k--) {
      if (this.contacts[k].stamp !== stamp) this._release(k);
    }
  }

  _pair(a, b, stamp) {
    const lo = a.id < b.id ? a : b;
    const hi = a.id < b.id ? b : a;
    const key = lo.id * PAIR + hi.id;
    let c = this.contactMap.get(key);
    if (c === undefined) {
      if (this.noCollide.has(key)) return;
      c = this.pool.length > 0 ? this.pool.pop() : new Contact();
      // the narrowphase expects the polygon first when the shapes are mixed
      const swap = lo.shape.kind === CIRCLE && hi.shape.kind === POLYGON;
      c.a = swap ? hi : lo;
      c.b = swap ? lo : hi;
      c.key = key;
      c.count = 0;
      c.friction = Math.sqrt(lo.friction * hi.friction);
      c.restitution = Math.max(lo.restitution, hi.restitution);
      this.contactMap.set(key, c);
      this.contacts.push(c);
    }
    c.stamp = stamp;
    // two bodies at rest have not moved: their manifold and its impulses are still valid
    if (a.awake || b.awake) updateManifold(c);
  }

  /**
   * Union-find over touching dynamic bodies and joints. An island with any active member is
   * woken as a whole; an island whose members have all been still for SLEEP_TIME goes to sleep.
   */
  _islands() {
    const bodies = this.bodies;
    const n = bodies.length;
    if (this.parent.length < n) {
      this.parent = new Int32Array(2 * n);
      this.islandActive = new Uint8Array(2 * n);
    }
    const parent = this.parent;
    const flag = this.islandActive;
    for (let i = 0; i < n; i++) {
      parent[i] = i;
      flag[i] = 0;
    }
    const contacts = this.contacts;
    for (let i = 0; i < contacts.length; i++) {
      const c = contacts[i];
      if (c.count === 0) continue;
      const a = c.a;
      const b = c.b;
      if (a.type === DYNAMIC && b.type === DYNAMIC) {
        const ra = find(parent, a.index);
        const rb = find(parent, b.index);
        if (ra !== rb) parent[rb] = ra;
      } else if (a.type === KINEMATIC || b.type === KINEMATIC) {
        const k = a.type === KINEMATIC ? a : b;
        if (k.vx !== 0 || k.vy !== 0 || k.w !== 0) this.wake(a.type === KINEMATIC ? b : a);
      }
    }
    const joints = this.joints;
    for (let i = 0; i < joints.length; i++) {
      const j = joints[i];
      if (j.a.type !== DYNAMIC || j.b.type !== DYNAMIC) continue;
      const ra = find(parent, j.a.index);
      const rb = find(parent, j.b.index);
      if (ra !== rb) parent[rb] = ra;
    }
    const sleepOK = this.allowSleep;
    for (let i = 0; i < n; i++) {
      const b = bodies[i];
      if (b.type !== DYNAMIC || !b.awake) continue;
      if (!sleepOK || b.held || b.sleepTime < SLEEP_TIME) flag[find(parent, i)] = 1;
    }
    for (let i = 0; i < n; i++) {
      const b = bodies[i];
      if (b.type !== DYNAMIC) continue;
      if (flag[find(parent, i)] === 1) {
        if (!b.awake) {
          b.awake = true;
          b.sleepTime = 0;
        }
      } else if (b.awake) {
        b.awake = false;
        b.vx = 0;
        b.vy = 0;
        b.w = 0;
        b.px = b.x;
        b.py = b.y;
        b.pa = b.a;
      }
    }
  }

  _solve(dt) {
    const invDt = 1 / dt;
    const bodies = this.bodies;
    const n = bodies.length;
    const gx = this.gravityX * dt;
    const gy = this.gravityY * dt;
    const spin = 1 / (1 + dt * this.angularDamping);
    for (let i = 0; i < n; i++) {
      const b = bodies[i];
      if (!b.awake) continue;
      b.px = b.x;
      b.py = b.y;
      b.pa = b.a;
      if (b.type !== DYNAMIC) continue;
      b.vx += gx;
      b.vy += gy;
      b.w *= spin;
      b.pvx = 0;
      b.pvy = 0;
      b.pw = 0;
    }

    const active = this.active;
    const contacts = this.contacts;
    active.length = 0;
    let manifolds = 0;
    let points = 0;
    for (let i = 0; i < contacts.length; i++) {
      const c = contacts[i];
      if (c.count === 0) continue;
      manifolds++;
      points += c.count;
      if (c.a.awake || c.b.awake) active.push(c);
    }
    this.manifoldCount = manifolds;
    this.pointCount = points;
    const joints = this.activeJoints;
    joints.length = 0;
    for (let i = 0; i < this.joints.length; i++) {
      const j = this.joints[i];
      if (j.a.awake || j.b.awake) joints.push(j);
    }

    const nc = active.length;
    const nj = joints.length;
    for (let i = 0; i < nc; i++) prepareContact(active[i], invDt);
    for (let i = 0; i < nj; i++) joints[i].prepare(invDt);
    for (let i = 0; i < nc; i++) warmStartContact(active[i]);
    for (let it = 0; it < this.iterations; it++) {
      for (let i = 0; i < nj; i++) joints[i].solve();
      for (let i = 0; i < nc; i++) solveContact(active[i]);
    }
    for (let i = 0; i < nc; i++) applyRestitution(active[i]);

    let awake = 0;
    let moving = false;
    for (let i = 0; i < n; i++) {
      const b = bodies[i];
      if (!b.awake) continue;
      if (b.type === DYNAMIC) {
        const tx = (b.vx + b.pvx) * dt;
        const ty = (b.vy + b.pvy) * dt;
        const d2 = tx * tx + ty * ty;
        if (d2 > MAX_TRANSLATION * MAX_TRANSLATION) {
          const s = MAX_TRANSLATION / Math.sqrt(d2);
          b.vx *= s;
          b.vy *= s;
          b.pvx *= s;
          b.pvy *= s;
        }
        const rot = Math.abs(b.w + b.pw) * dt;
        if (rot > MAX_ROTATION) {
          b.w *= MAX_ROTATION / rot;
          b.pw *= MAX_ROTATION / rot;
        }
        b.x += (b.vx + b.pvx) * dt;
        b.y += (b.vy + b.pvy) * dt;
        b.a += (b.w + b.pw) * dt;
        if (b.vx * b.vx + b.vy * b.vy > SLEEP_LINEAR * SLEEP_LINEAR || b.w * b.w > SLEEP_ANGULAR * SLEEP_ANGULAR) {
          b.sleepTime = 0;
        } else b.sleepTime += dt;
        awake++;
      } else {
        if (b.vx === 0 && b.vy === 0 && b.w === 0) continue;
        b.x += b.vx * dt;
        b.y += b.vy * dt;
        b.a += b.w * dt;
        moving = true;
      }
      b.sync();
    }
    this.awakeCount = awake;
    this.moving = moving || awake > 0;
  }
}

export { STATIC, KINEMATIC, DYNAMIC, CIRCLE, POLYGON };
