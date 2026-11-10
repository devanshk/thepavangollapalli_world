// 3D gradient noise on an integer-hashed lattice, value only.
//
// This is the JavaScript twin of the GLSL in glsl-noise.js. Both hash lattice points with
// the same 32-bit integer arithmetic, so the two agree to floating-point rounding and the
// facts on the data card can be measured from exactly the terrain the shader draws.

const KX = 0x8da6b343 | 0;
const KY = 0xd8163841 | 0;
const KZ = 0xcb1ab31f | 0;
const LAYER_STEP = 0x9e3779b9 | 0;
const GRAD_SCALE = 2 / 1023;

/** Lacunarity and per-octave rotation shared with the shader (a rotation hides lattice alignment). */
export const LACUNARITY = 1.98;

/** Integer finaliser (lowbias32). Returns a signed int32 with well-mixed bits. */
export function mix32(h) {
  h ^= h >>> 16;
  h = Math.imul(h, 0x7feb352d);
  h ^= h >>> 15;
  h = Math.imul(h, 0x846ca68b);
  h ^= h >>> 16;
  return h;
}

/** Each noise layer of a planet gets its own lattice: the planet hash plus a layer offset. */
export const layerSeed = (hash, layer) => (hash + Math.imul(layer, LAYER_STEP)) | 0;

// Contribution of one lattice corner: its hashed gradient (three 10-bit fields mapped to
// [-1, 1]) dotted with the offset from that corner.
function corner(h, dx, dy, dz) {
  return (
    ((h & 1023) * GRAD_SCALE - 1) * dx +
    (((h >>> 10) & 1023) * GRAD_SCALE - 1) * dy +
    (((h >>> 20) & 1023) * GRAD_SCALE - 1) * dz
  );
}

/** Gradient noise at (x, y, z). Continuous, zero at lattice points, |value| < 1.5. */
export function noise3(x, y, z, seed) {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const iz = Math.floor(z);
  const fx = x - ix;
  const fy = y - iy;
  const fz = z - iz;
  const x0 = (Math.imul(ix, KX) + seed) | 0;
  const y0 = Math.imul(iy, KY);
  const z0 = Math.imul(iz, KZ);
  const x1 = (x0 + KX) | 0;
  const y1 = (y0 + KY) | 0;
  const z1 = (z0 + KZ) | 0;
  const va = corner(mix32(x0 + y0 + z0), fx, fy, fz);
  const vb = corner(mix32(x1 + y0 + z0), fx - 1, fy, fz);
  const vc = corner(mix32(x0 + y1 + z0), fx, fy - 1, fz);
  const vd = corner(mix32(x1 + y1 + z0), fx - 1, fy - 1, fz);
  const ve = corner(mix32(x0 + y0 + z1), fx, fy, fz - 1);
  const vf = corner(mix32(x1 + y0 + z1), fx - 1, fy, fz - 1);
  const vg = corner(mix32(x0 + y1 + z1), fx, fy - 1, fz - 1);
  const vh = corner(mix32(x1 + y1 + z1), fx - 1, fy - 1, fz - 1);
  const ux = fx * fx * fx * (fx * (fx * 6 - 15) + 10);
  const uy = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
  const uz = fz * fz * fz * (fz * (fz * 6 - 15) + 10);
  return (
    va +
    ux * (vb - va) +
    uy * (vc - va) +
    uz * (ve - va) +
    ux * uy * (va - vb - vc + vd) +
    uy * uz * (va - vc - ve + vg) +
    uz * ux * (va - vb - ve + vf) +
    ux * uy * uz * (-va + vb + vc - vd + ve - vf - vg + vh)
  );
}

/**
 * Fractal sum of noise3. `octaves` may be fractional: the last octave fades in, which is how
 * the shader changes level of detail without popping. First octave has amplitude 1.
 */
export function fbm3(x, y, z, seed, octaves, gain) {
  let sum = 0;
  let amp = 1;
  for (let i = 0; i < octaves; i++) {
    const w = Math.min(octaves - i, 1);
    sum += w * amp * noise3(x, y, z, seed);
    amp *= gain;
    const nx = LACUNARITY * (-0.8 * y - 0.6 * z);
    const ny = LACUNARITY * (0.8 * x + 0.36 * y - 0.48 * z);
    const nz = LACUNARITY * (0.6 * x - 0.48 * y + 0.64 * z);
    x = nx;
    y = ny;
    z = nz;
  }
  return sum;
}

/**
 * Ridged multifractal: each octave is folded into a crest, (1 - k|n|)^2, and scaled by the
 * octave before it so detail gathers on ridges and valleys stay smooth. Range [0, ~2 * amp0).
 */
export function ridged3(x, y, z, seed, octaves, sharp, amp0, gain) {
  let sum = 0;
  let amp = amp0;
  let prev = 1;
  for (let i = 0; i < octaves; i++) {
    const w = Math.min(octaves - i, 1);
    const r = Math.max(1 - sharp * Math.abs(noise3(x, y, z, seed)), 0);
    const r2 = r * r;
    sum += w * amp * prev * r2;
    prev = r2;
    amp *= gain;
    const nx = LACUNARITY * (-0.8 * y - 0.6 * z);
    const ny = LACUNARITY * (0.8 * x + 0.36 * y - 0.48 * z);
    const nz = LACUNARITY * (0.6 * x - 0.48 * y + 0.64 * z);
    x = nx;
    y = ny;
    z = nz;
  }
  return sum;
}
