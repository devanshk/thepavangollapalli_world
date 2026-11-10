// Camera geometry and trackball rotation. Pure math, no DOM.
// Quaternions are [x, y, z, w]; functions write into `out` so the frame loop allocates nothing.

export const quatIdentity = () => [0, 0, 0, 1];

/** out = a ∘ b (apply b first, then a). `out` may alias a or b. */
export function quatMul(out, a, b) {
  const ax = a[0], ay = a[1], az = a[2], aw = a[3];
  const bx = b[0], by = b[1], bz = b[2], bw = b[3];
  out[0] = aw * bx + ax * bw + ay * bz - az * by;
  out[1] = aw * by - ax * bz + ay * bw + az * bx;
  out[2] = aw * bz + ax * by - ay * bx + az * bw;
  out[3] = aw * bw - ax * bx - ay * by - az * bz;
  return out;
}

export function quatNormalize(out, q) {
  const n = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
  out[0] = q[0] / n;
  out[1] = q[1] / n;
  out[2] = q[2] / n;
  out[3] = q[3] / n;
  return out;
}

/** Rotation by `angle` radians about the unit axis (x, y, z). */
export function quatFromAxisAngle(out, x, y, z, angle) {
  const s = Math.sin(angle / 2);
  out[0] = x * s;
  out[1] = y * s;
  out[2] = z * s;
  out[3] = Math.cos(angle / 2);
  return out;
}

/** The shortest rotation taking unit vector a to unit vector b. */
export function quatBetween(out, a, b) {
  const d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  if (d < -0.999999) {
    // opposite vectors: any perpendicular axis will do
    const useX = Math.abs(a[0]) < 0.9;
    const px = useX ? 0 : -a[2];
    const py = useX ? a[2] : 0;
    const pz = useX ? -a[1] : a[0];
    const n = Math.hypot(px, py, pz) || 1;
    out[0] = px / n;
    out[1] = py / n;
    out[2] = pz / n;
    out[3] = 0;
    return out;
  }
  out[0] = a[1] * b[2] - a[2] * b[1];
  out[1] = a[2] * b[0] - a[0] * b[2];
  out[2] = a[0] * b[1] - a[1] * b[0];
  out[3] = 1 + d;
  return quatNormalize(out, out);
}

/** Rotate vector v by unit quaternion q. `out` may alias v. */
export function quatRotate(out, q, v) {
  const x = q[0], y = q[1], z = q[2], w = q[3];
  const tx = 2 * (y * v[2] - z * v[1]);
  const ty = 2 * (z * v[0] - x * v[2]);
  const tz = 2 * (x * v[1] - y * v[0]);
  const rx = v[0] + w * tx + (y * tz - z * ty);
  const ry = v[1] + w * ty + (z * tx - x * tz);
  const rz = v[2] + w * tz + (x * ty - y * tx);
  out[0] = rx;
  out[1] = ry;
  out[2] = rz;
  return out;
}

/** Column-major 3×3 rotation matrix of a unit quaternion, ready for uniformMatrix3fv. */
export function quatToMat3(out, q) {
  const x = q[0], y = q[1], z = q[2], w = q[3];
  out[0] = 1 - 2 * (y * y + z * z);
  out[1] = 2 * (x * y + z * w);
  out[2] = 2 * (x * z - y * w);
  out[3] = 2 * (x * y - z * w);
  out[4] = 1 - 2 * (x * x + z * z);
  out[5] = 2 * (y * z + x * w);
  out[6] = 2 * (x * z + y * w);
  out[7] = 2 * (y * z - x * w);
  out[8] = 1 - 2 * (x * x + y * y);
  return out;
}

/**
 * Nearest intersection of a ray with a sphere centred on the origin.
 * (ox, oy, oz) origin, (dx, dy, dz) unit direction → distance t ≥ 0, or -1 for a miss.
 */
export function raySphere(ox, oy, oz, dx, dy, dz, radius) {
  const b = ox * dx + oy * dy + oz * dz;
  const c = ox * ox + oy * oy + oz * oz - radius * radius;
  const disc = b * b - c;
  if (disc < 0) return -1;
  const s = Math.sqrt(disc);
  const near = -b - s;
  if (near >= 0) return near;
  const far = -b + s;
  return far >= 0 ? far : -1;
}

/**
 * The camera sits at (0, 0, dist) looking down -z. Screen coordinates (u, v) are in units
 * of half the smaller canvas side, v up. Writes the unit view ray to out.
 */
export function viewRay(out, u, v, tanFov) {
  const x = u * tanFov;
  const y = v * tanFov;
  const n = Math.hypot(x, y, 1);
  out[0] = x / n;
  out[1] = y / n;
  out[2] = -1 / n;
  return out;
}

/**
 * Trackball pick: the point of the unit sphere under screen position (u, v), in view space.
 * Off the disc, the ray's closest point to the centre is projected onto the sphere, which
 * continues smoothly past the limb and turns far-out drags into a roll about the view axis.
 */
export function pickSphere(out, u, v, dist, tanFov) {
  viewRay(out, u, v, tanFov);
  const dx = out[0], dy = out[1], dz = out[2];
  let t = raySphere(0, 0, dist, dx, dy, dz, 1);
  if (t < 0) t = -dist * dz;
  const px = dx * t;
  const py = dy * t;
  const pz = dist + dz * t;
  const n = Math.hypot(px, py, pz) || 1;
  out[0] = px / n;
  out[1] = py / n;
  out[2] = pz / n;
  return out;
}

/** Radius of the planet's disc on screen, in the same units as (u, v). */
export const discRadius = (dist, tanFov) => 1 / (Math.sqrt(Math.max(dist * dist - 1, 1e-6)) * tanFov);

/** Camera distance at which the disc has the given on-screen radius. */
export const distanceForRadius = (radius, tanFov) => Math.hypot(1, 1 / (radius * tanFov));
