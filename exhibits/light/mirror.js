// A pure-JavaScript mirror of the shader's ray–scene intersection. It reads the same packed
// texels the GPU reads (see pack.js) and uses the same formulas as shader/scene.js, so the two can
// be compared ray for ray in the tests. The exhibit uses it to find the focus distance under a tap.
import { STRIDE, readHeader } from './pack.js';
import { dot, madd, scale, sub } from './vec.js';

export const T_MIN = 1e-4;
export const KIND_SPHERE = 1;
export const KIND_BOX = 2;
export const KIND_QUAD = 3;

/** Nearest distance t > T_MIN at which the ray ro + t·rd meets the sphere, or Infinity. rd is unit length. */
export function hitSphere(ro, rd, centre, radius) {
  const oc = sub(ro, centre);
  const b = dot(oc, rd);
  // distance² from the centre to the ray, computed without the cancellation of b² − c
  const q = madd(oc, rd, -b);
  const h2 = radius * radius - dot(q, q);
  if (h2 < 0) return Infinity;
  const h = Math.sqrt(h2);
  let t = -b - h;
  if (t < T_MIN) t = -b + h;
  return t < T_MIN ? Infinity : t;
}

const safeInverse = (x) => (x < 0 ? -1 : 1) / Math.max(Math.abs(x), 1e-8);

/**
 * Slab test against a box rotated about the vertical axis. cos/sin describe the rotation.
 * Returns { t, n } with the world-space outward normal, t = Infinity on a miss.
 */
export function hitBox(ro, rd, centre, half, cos, sin) {
  const oc = sub(ro, centre);
  const o = [cos * oc[0] - sin * oc[2], oc[1], sin * oc[0] + cos * oc[2]];
  const d = [cos * rd[0] - sin * rd[2], rd[1], sin * rd[0] + cos * rd[2]];
  const near = [0, 0, 0];
  const far = [0, 0, 0];
  for (let k = 0; k < 3; k++) {
    const inv = safeInverse(d[k]);
    const a = (-half[k] - o[k]) * inv;
    const b = (half[k] - o[k]) * inv;
    near[k] = Math.min(a, b);
    far[k] = Math.max(a, b);
  }
  const tNear = Math.max(near[0], near[1], near[2]);
  const tFar = Math.min(far[0], far[1], far[2]);
  if (tNear > tFar || tFar < T_MIN) return { t: Infinity, n: [0, 1, 0] };
  const entering = tNear >= T_MIN;
  const slab = entering ? near : far;
  const pick = entering
    ? slab[0] >= slab[1] && slab[0] >= slab[2] ? 0 : slab[1] >= slab[2] ? 1 : 2
    : slab[0] <= slab[1] && slab[0] <= slab[2] ? 0 : slab[1] <= slab[2] ? 1 : 2;
  const local = [0, 0, 0];
  local[pick] = (d[pick] > 0 ? 1 : -1) * (entering ? -1 : 1);
  return {
    t: entering ? tNear : tFar,
    n: [cos * local[0] + sin * local[2], local[1], -sin * local[0] + cos * local[2]],
  };
}

/**
 * Rectangle given by its plane (unit normal n, offset d = n·centre), its centre and its two
 * half-edges divided by their squared length. A one-sided quad is invisible from behind.
 */
export function hitQuad(ro, rd, n, d, centre, uInv, vInv, oneSided) {
  const denom = dot(rd, n);
  if (Math.abs(denom) < 1e-7) return Infinity;
  const t = (d - dot(ro, n)) / denom;
  if (t < T_MIN) return Infinity;
  if (oneSided && denom > 0) return Infinity;
  const p = sub(madd(ro, rd, t), centre);
  if (Math.abs(dot(p, uInv)) > 1 || Math.abs(dot(p, vInv)) > 1) return Infinity;
  return t;
}

/**
 * Closest intersection of a ray with a packed scene.
 * → null, or { t, kind, index, point, normal (geometric, outward), material }
 */
export function closestHit(data, ro, rd) {
  const { counts, offsets: at } = readHeader(data);
  const xyz = (t) => [data[t * 4], data[t * 4 + 1], data[t * 4 + 2]];
  const w = (t) => data[t * 4 + 3];
  let best = Infinity;
  let kind = 0;
  let index = 0;
  let boxNormal = null;

  for (let i = 0; i < counts.spheres; i++) {
    const s = at.spheres + i * STRIDE.sphere;
    const t = hitSphere(ro, rd, xyz(s), w(s));
    if (t < best) [best, kind, index] = [t, KIND_SPHERE, i];
  }
  for (let i = 0; i < counts.boxes; i++) {
    const b = at.boxes + i * STRIDE.box;
    const hit = hitBox(ro, rd, xyz(b), xyz(b + 1), w(b), w(b + 1));
    if (hit.t < best) {
      [best, kind, index] = [hit.t, KIND_BOX, i];
      boxNormal = hit.n;
    }
  }
  for (let i = 0; i < counts.quads; i++) {
    const q = at.quads + i * STRIDE.quad;
    const t = hitQuad(ro, rd, xyz(q), w(q), xyz(q + 1), xyz(q + 2), xyz(q + 3), w(q + 2) > 0.5);
    if (t < best) [best, kind, index] = [t, KIND_QUAD, i];
  }
  if (!kind) return null;

  const point = madd(ro, rd, best);
  let normal = boxNormal;
  let material = 0;
  if (kind === KIND_SPHERE) {
    const s = at.spheres + index * STRIDE.sphere;
    normal = scale(sub(point, xyz(s)), 1 / w(s));
    material = data[(s + 1) * 4];
  } else if (kind === KIND_BOX) {
    material = data[(at.boxes + index * STRIDE.box + 2) * 4];
  } else {
    const q = at.quads + index * STRIDE.quad;
    normal = xyz(q);
    material = w(q + 1);
  }
  return { t: best, kind, index, point, normal, material };
}
