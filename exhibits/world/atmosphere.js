// The Chapman function: how much air a ray crosses on its way out of an exponential
// atmosphere wrapped around a sphere. The shader calls it once per scattering sample
// instead of marching a second ray toward the sun. Written once here in both languages,
// with a brute-force integrator the tests compare against.
//
// For a planet much larger than its scale height, the column along a ray that leaves a
// point at radius x (in scale heights) with zenith cosine c ≥ 0 is
//   sqrt(πx/2) · erfcx(sqrt(x/2) · c)        erfcx(t) = exp(t²) · erfc(t)
// times the vertical column. erfcx is replaced by the rational fit of Ren & MacKenzie
// (2007), A / ((A − 1)·sqrt(π)·t + sqrt(π·t² + A²)). Against direct integration the result
// stays within 2% for the radii used here.

const A = 2.911;
const SQRT_PI = Math.sqrt(Math.PI);

function chapmanUp(x, c) {
  const t = Math.sqrt(0.5 * x) * c;
  return (Math.sqrt(0.5 * Math.PI * x) * A) / ((A - 1) * SQRT_PI * t + Math.sqrt(Math.PI * t * t + A * A));
}

/**
 * Optical depth, in units of the vertical scale height, from a point at height h (scale
 * heights above the surface) to space, along a ray whose zenith cosine is c. X is the
 * planet's radius in scale heights. A ray heading below the horizon is mirrored about
 * its lowest point (C. Schüler, GPU Pro 3, 2012); one that would pass through the planet
 * picks up so much depth that it carries no light, which is what draws the terminator.
 */
export function chapman(X, h, c) {
  const x = X + h;
  if (c >= 0) return chapmanUp(x, c) * Math.exp(-h);
  const x0 = Math.sqrt(Math.max(1 - c * c, 0)) * x;
  return 2 * Math.sqrt(0.5 * Math.PI * x0) * Math.exp(Math.min(X - x0, 30)) - chapmanUp(x, -c) * Math.exp(-h);
}

export const chapmanGLSL = /* glsl */ `
float chapmanUp(float x, float c) {
  float t = sqrt(0.5 * x) * c;
  return sqrt(0.5 * PI * x) * ${A} / (${(A - 1) * SQRT_PI} * t + sqrt(PI * t * t + ${A * A}));
}

float chapman(float X, float h, float c) {
  float x = X + h;
  if (c >= 0.0) return chapmanUp(x, c) * exp(-h);
  float x0 = sqrt(max(1.0 - c * c, 0.0)) * x;
  return 2.0 * sqrt(0.5 * PI * x0) * exp(min(X - x0, 30.0)) - chapmanUp(x, -c) * exp(-h);
}`;

/**
 * Reference: the same optical depth by direct numerical integration along the ray
 * (midpoint rule, out to 40 scale heights of altitude). Returns Infinity if the ray hits the ground.
 */
export function opticalDepthNumeric(X, h, c, steps = 20000) {
  const r0 = X + h;
  const s = Math.sqrt(Math.max(1 - c * c, 0));
  if (c < 0 && r0 * s < X) return Infinity;
  const top = X + 40;
  const length = -r0 * c + Math.sqrt(Math.max(top * top - r0 * r0 * s * s, 0));
  const dt = length / steps;
  let sum = 0;
  for (let i = 0; i < steps; i++) {
    const t = (i + 0.5) * dt;
    const r = Math.sqrt(r0 * r0 + t * t + 2 * r0 * t * c);
    sum += Math.exp(-(r - X));
  }
  return sum * dt;
}
