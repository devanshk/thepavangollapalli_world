// body.js — shapes, mass properties and rigid-body state. Pure: no DOM.

export const STATIC = 0;
export const KINEMATIC = 1;
export const DYNAMIC = 2;

export const CIRCLE = 0;
export const POLYGON = 1;

/** AABBs are fattened by this much, and contacts are created this far ahead of touching (metres). */
export const MARGIN = 0.02;

/**
 * Signed area, centroid and second moment of area about the centroid of a simple polygon given
 * as a flat [x0, y0, x1, y1, …] array. Area is positive for counter-clockwise winding.
 */
export function polygonProperties(pts) {
  const n = pts.length >> 1;
  let area = 0;
  let cx = 0;
  let cy = 0;
  let second = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const x0 = pts[2 * i];
    const y0 = pts[2 * i + 1];
    const x1 = pts[2 * j];
    const y1 = pts[2 * j + 1];
    const cross = x0 * y1 - x1 * y0;
    area += cross;
    cx += (x0 + x1) * cross;
    cy += (y0 + y1) * cross;
    second += cross * (x0 * x0 + x0 * x1 + x1 * x1 + y0 * y0 + y0 * y1 + y1 * y1);
  }
  area *= 0.5;
  cx /= 6 * area;
  cy /= 6 * area;
  return { area, cx, cy, inertia: second / 12 - area * (cx * cx + cy * cy) };
}

export function circleShape(radius) {
  return {
    kind: CIRCLE,
    n: 0,
    verts: null,
    norms: null,
    radius,
    mark: radius,
    area: Math.PI * radius * radius,
    inertia: 0.5 * Math.PI * radius * radius * radius * radius,
    cx: 0,
    cy: 0,
  };
}

/**
 * A convex polygon of 3 to 8 vertices in either winding. Vertices are stored counter-clockwise
 * relative to the centroid; (cx, cy) is where that centroid was in the caller's coordinates.
 */
export function polygonShape(points) {
  const n = points.length >> 1;
  if (n < 3 || n > 8) throw new Error('a polygon needs 3 to 8 vertices');
  const pts = Float64Array.from(points);
  let props = polygonProperties(pts);
  if (props.area < 0) {
    for (let i = 0, j = n - 1; i < j; i++, j--) {
      const x = pts[2 * i];
      const y = pts[2 * i + 1];
      pts[2 * i] = pts[2 * j];
      pts[2 * i + 1] = pts[2 * j + 1];
      pts[2 * j] = x;
      pts[2 * j + 1] = y;
    }
    props = polygonProperties(pts);
  }
  if (!(props.area > 1e-9)) throw new Error('degenerate polygon');
  const verts = new Float64Array(2 * n);
  const norms = new Float64Array(2 * n);
  let radius = 0;
  for (let i = 0; i < n; i++) {
    verts[2 * i] = pts[2 * i] - props.cx;
    verts[2 * i + 1] = pts[2 * i + 1] - props.cy;
    radius = Math.max(radius, Math.hypot(verts[2 * i], verts[2 * i + 1]));
  }
  let inradius = Infinity;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const ex = verts[2 * j] - verts[2 * i];
    const ey = verts[2 * j + 1] - verts[2 * i + 1];
    const len = Math.hypot(ex, ey);
    norms[2 * i] = ey / len;
    norms[2 * i + 1] = -ex / len;
    inradius = Math.min(inradius, norms[2 * i] * verts[2 * i] + norms[2 * i + 1] * verts[2 * i + 1]);
  }
  return {
    kind: POLYGON,
    n,
    verts,
    norms,
    radius,
    mark: 0.7 * inradius,
    area: props.area,
    inertia: props.inertia,
    cx: props.cx,
    cy: props.cy,
  };
}

export function boxShape(w, h) {
  return polygonShape([-w / 2, -h / 2, w / 2, -h / 2, w / 2, h / 2, -w / 2, h / 2]);
}

export class Body {
  /** opts: { vx, vy, w, density = 1, friction = 0.5, restitution = 0, color, hidden } */
  constructor(id, shape, type, x, y, angle, opts) {
    this.id = id;
    this.index = -1;
    this.shape = shape;
    this.type = type;
    this.x = x;
    this.y = y;
    this.a = angle;
    // pose at the start of the last step, for render interpolation
    this.px = x;
    this.py = y;
    this.pa = angle;
    this.vx = opts.vx || 0;
    this.vy = opts.vy || 0;
    this.w = opts.w || 0;
    // pseudo-velocity: moves the body out of penetration without becoming momentum
    this.pvx = 0;
    this.pvy = 0;
    this.pw = 0;
    this.cos = 1;
    this.sin = 0;
    const density = opts.density === undefined ? 1 : opts.density;
    const dynamic = type === DYNAMIC && shape !== null;
    this.mass = dynamic ? density * shape.area : 0;
    this.inertia = dynamic ? density * shape.inertia : 0;
    this.invMass = dynamic ? 1 / this.mass : 0;
    this.invInertia = dynamic ? 1 / this.inertia : 0;
    this.friction = opts.friction === undefined ? 0.5 : opts.friction;
    this.restitution = opts.restitution || 0;
    this.color = opts.color === undefined ? -1 : opts.color;
    this.hidden = !!opts.hidden;
    this.awake = type !== STATIC;
    this.sleepTime = 0;
    this.held = false;
    this.minX = x;
    this.minY = y;
    this.maxX = x;
    this.maxY = y;
    const n = shape !== null && shape.kind === POLYGON ? shape.n : 0;
    this.wv = new Float64Array(2 * n);
    this.wn = new Float64Array(2 * n);
    this.sync();
  }

  /** Recompute rotation, world-space vertices and normals, and the fattened AABB from the pose. */
  sync() {
    const c = Math.cos(this.a);
    const s = Math.sin(this.a);
    this.cos = c;
    this.sin = s;
    const shape = this.shape;
    if (shape === null) return;
    const x = this.x;
    const y = this.y;
    if (shape.kind === CIRCLE) {
      const r = shape.radius + MARGIN;
      this.minX = x - r;
      this.minY = y - r;
      this.maxX = x + r;
      this.maxY = y + r;
      return;
    }
    const v = shape.verts;
    const nm = shape.norms;
    const wv = this.wv;
    const wn = this.wn;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (let i = 0, end = 2 * shape.n; i < end; i += 2) {
      const wx = x + c * v[i] - s * v[i + 1];
      const wy = y + s * v[i] + c * v[i + 1];
      wv[i] = wx;
      wv[i + 1] = wy;
      wn[i] = c * nm[i] - s * nm[i + 1];
      wn[i + 1] = s * nm[i] + c * nm[i + 1];
      if (wx < minX) minX = wx;
      if (wx > maxX) maxX = wx;
      if (wy < minY) minY = wy;
      if (wy > maxY) maxY = wy;
    }
    this.minX = minX - MARGIN;
    this.minY = minY - MARGIN;
    this.maxX = maxX + MARGIN;
    this.maxY = maxY + MARGIN;
  }
}
