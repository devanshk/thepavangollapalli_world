// GLSL: integer-hashed 3D gradient noise with analytic derivatives, and the fractal sums
// built on it. noise.js is the JavaScript twin of the value-only paths.
import { LACUNARITY } from './noise.js';

export const GLSL_NOISE = /* glsl */ `
const uint KX = 0x8da6b343u;
const uint KY = 0xd8163841u;
const uint KZ = 0xcb1ab31fu;
const float LAC = ${LACUNARITY};
// A fixed rotation between octaves hides the lattice; M3T is its transpose (and inverse).
const mat3 M3 = mat3(0.00, 0.80, 0.60, -0.80, 0.36, -0.48, -0.60, -0.48, 0.64);
const mat3 M3T = mat3(0.00, -0.80, -0.60, 0.80, 0.36, -0.48, 0.60, -0.48, 0.64);

uint mix32(uint h) {
  h ^= h >> 16;
  h *= 0x7feb352du;
  h ^= h >> 15;
  h *= 0x846ca68bu;
  h ^= h >> 16;
  return h;
}

uint layerSeed(uint layer) {
  return uSeed + layer * 0x9e3779b9u;
}

vec3 gradOf(uint h) {
  return vec3(float(h & 1023u), float((h >> 10) & 1023u), float((h >> 20) & 1023u)) * (2.0 / 1023.0) - 1.0;
}

// Gradient noise. x: value, yzw: its exact gradient.
vec4 noised(vec3 x, uint seed) {
  vec3 cell = floor(x);
  vec3 f = x - cell;
  ivec3 i = ivec3(cell);
  uint x0 = uint(i.x) * KX + seed;
  uint y0 = uint(i.y) * KY;
  uint z0 = uint(i.z) * KZ;
  uint x1 = x0 + KX;
  uint y1 = y0 + KY;
  uint z1 = z0 + KZ;
  vec3 ga = gradOf(mix32(x0 + y0 + z0));
  vec3 gb = gradOf(mix32(x1 + y0 + z0));
  vec3 gc = gradOf(mix32(x0 + y1 + z0));
  vec3 gd = gradOf(mix32(x1 + y1 + z0));
  vec3 ge = gradOf(mix32(x0 + y0 + z1));
  vec3 gf = gradOf(mix32(x1 + y0 + z1));
  vec3 gg = gradOf(mix32(x0 + y1 + z1));
  vec3 gh = gradOf(mix32(x1 + y1 + z1));
  float va = dot(ga, f);
  float vb = dot(gb, f - vec3(1.0, 0.0, 0.0));
  float vc = dot(gc, f - vec3(0.0, 1.0, 0.0));
  float vd = dot(gd, f - vec3(1.0, 1.0, 0.0));
  float ve = dot(ge, f - vec3(0.0, 0.0, 1.0));
  float vf = dot(gf, f - vec3(1.0, 0.0, 1.0));
  float vg = dot(gg, f - vec3(0.0, 1.0, 1.0));
  float vh = dot(gh, f - vec3(1.0, 1.0, 1.0));
  vec3 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  vec3 du = 30.0 * f * f * (f * (f - 2.0) + 1.0);
  float k1 = vb - va;
  float k2 = vc - va;
  float k3 = ve - va;
  float k4 = va - vb - vc + vd;
  float k5 = va - vc - ve + vg;
  float k6 = va - vb - ve + vf;
  float k7 = -va + vb + vc - vd + ve - vf - vg + vh;
  float value = va + u.x * k1 + u.y * k2 + u.z * k3 + u.x * u.y * k4 + u.y * u.z * k5 + u.z * u.x * k6 + u.x * u.y * u.z * k7;
  vec3 grad = ga + u.x * (gb - ga) + u.y * (gc - ga) + u.z * (ge - ga)
    + u.x * u.y * (ga - gb - gc + gd) + u.y * u.z * (ga - gc - ge + gg) + u.z * u.x * (ga - gb - ge + gf)
    + u.x * u.y * u.z * (-ga + gb + gc - gd + ge - gf - gg + gh)
    + du * vec3(k1 + u.y * k4 + u.z * k6 + u.y * u.z * k7,
                k2 + u.x * k4 + u.z * k5 + u.x * u.z * k7,
                k3 + u.y * k5 + u.x * k6 + u.x * u.y * k7);
  return vec4(value, grad);
}

// The same noise, value only (about 40% cheaper).
float noise(vec3 x, uint seed) {
  vec3 cell = floor(x);
  vec3 f = x - cell;
  ivec3 i = ivec3(cell);
  uint x0 = uint(i.x) * KX + seed;
  uint y0 = uint(i.y) * KY;
  uint z0 = uint(i.z) * KZ;
  uint x1 = x0 + KX;
  uint y1 = y0 + KY;
  uint z1 = z0 + KZ;
  float va = dot(gradOf(mix32(x0 + y0 + z0)), f);
  float vb = dot(gradOf(mix32(x1 + y0 + z0)), f - vec3(1.0, 0.0, 0.0));
  float vc = dot(gradOf(mix32(x0 + y1 + z0)), f - vec3(0.0, 1.0, 0.0));
  float vd = dot(gradOf(mix32(x1 + y1 + z0)), f - vec3(1.0, 1.0, 0.0));
  float ve = dot(gradOf(mix32(x0 + y0 + z1)), f - vec3(0.0, 0.0, 1.0));
  float vf = dot(gradOf(mix32(x1 + y0 + z1)), f - vec3(1.0, 0.0, 1.0));
  float vg = dot(gradOf(mix32(x0 + y1 + z1)), f - vec3(0.0, 1.0, 1.0));
  float vh = dot(gradOf(mix32(x1 + y1 + z1)), f - vec3(1.0, 1.0, 1.0));
  vec3 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  return va + u.x * (vb - va) + u.y * (vc - va) + u.z * (ve - va)
    + u.x * u.y * (va - vb - vc + vd) + u.y * u.z * (va - vc - ve + vg) + u.z * u.x * (va - vb - ve + vf)
    + u.x * u.y * u.z * (-va + vb + vc - vd + ve - vf - vg + vh);
}

// Fractal sum with gradient. octs may be fractional: the last octave fades in, so the
// level of detail can follow pixel size without popping.
vec4 fbmd(vec3 x, uint seed, float octs, float gain) {
  float sum = 0.0;
  float amp = 1.0;
  vec3 grad = vec3(0.0);
  mat3 m = mat3(1.0);
  for (int i = 0; i < 9; i++) {
    float w = min(octs - float(i), 1.0);
    if (w <= 0.0) break;
    vec4 n = noised(x, seed);
    sum += w * amp * n.x;
    grad += w * amp * (m * n.yzw);
    amp *= gain;
    x = LAC * (M3 * x);
    m = LAC * (M3T * m);
  }
  return vec4(sum, grad);
}

float fbm(vec3 x, uint seed, float octs, float gain) {
  float sum = 0.0;
  float amp = 1.0;
  for (int i = 0; i < 6; i++) {
    float w = min(octs - float(i), 1.0);
    if (w <= 0.0) break;
    sum += w * amp * noise(x, seed);
    amp *= gain;
    x = LAC * (M3 * x);
  }
  return sum;
}

// Ridged multifractal with gradient: each octave is folded into a crest, (1 - k|n|)^2, and
// scaled by the octave before it, so detail gathers on ridges and valleys stay smooth.
vec4 ridged(vec3 x, uint seed, float octs, float sharp, float amp0, float gain) {
  float sum = 0.0;
  float amp = amp0;
  float prev = 1.0;
  vec3 grad = vec3(0.0);
  vec3 dprev = vec3(0.0);
  mat3 m = mat3(1.0);
  for (int i = 0; i < 6; i++) {
    float w = min(octs - float(i), 1.0);
    if (w <= 0.0) break;
    vec4 n = noised(x, seed);
    float r = max(1.0 - sharp * abs(n.x), 0.0);
    float r2 = r * r;
    vec3 dr2 = (-2.0 * r * sharp * sign(n.x)) * (m * n.yzw);
    sum += w * amp * prev * r2;
    grad += w * amp * (dprev * r2 + prev * dr2);
    prev = r2;
    dprev = dr2;
    amp *= gain;
    x = LAC * (M3 * x);
    m = LAC * (M3T * m);
  }
  return vec4(sum, grad);
}
`;
