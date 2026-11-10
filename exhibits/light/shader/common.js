// GLSL shared by every part of the path tracer: uniforms, constants, random numbers and the
// sampling warps. Limits and texel strides are injected from pack.js so the two cannot drift.
import { HEADER_TEXELS, LIMITS, STRIDE } from '../pack.js';

export const MAX_BOUNCES = 12;
export const MAX_SPF = 8;

export const PRELUDE = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
`;

export const COMMON = `
const int MAX_SPHERES = ${LIMITS.spheres};
const int MAX_BOXES = ${LIMITS.boxes};
const int MAX_QUADS = ${LIMITS.quads};
const int MAX_BOUNCES = ${MAX_BOUNCES};
const int MAX_SPF = ${MAX_SPF};
const int SPHERES = ${HEADER_TEXELS};
const int SPHERE_STRIDE = ${STRIDE.sphere};
const int BOX_STRIDE = ${STRIDE.box};
const int QUAD_STRIDE = ${STRIDE.quad};
const int MATERIAL_STRIDE = ${STRIDE.material};

const int DIFFUSE = 0;
const int METAL = 1;
const int GLASS = 2;
const int EMISSIVE = 3;
const int PLASTIC = 4;

const float PI = 3.14159265358979;
const float TAU = 6.28318530717959;
const float INV_PI = 0.318309886183791;
const float INF = 1e30;
const float T_MIN = 1e-4;
const float EPS = 1e-3;
// GGX alpha below this is treated as a perfect mirror
const float MIRROR_ALPHA = 0.002;

uniform sampler2D uScene;   // packed scene, one row of RGBA float texels (see pack.js)
uniform sampler2D uPrev;    // running average so far
uniform ivec4 uCounts;      // spheres, boxes, quads, lights
uniform ivec4 uOffsets;     // first texel of boxes, quads, materials, lights
uniform vec2 uRes;
uniform int uSampleBase;    // samples already in uPrev
uniform int uSpf;           // samples to add in this pass
uniform int uEpoch;         // changes whenever accumulation restarts, for fresh noise
uniform int uMode;          // 0 path trace, 1 depth probe
uniform int uStrategy;      // 0 MIS, 1 BSDF sampling only, 2 light sampling only
uniform int uMaxBounces;
uniform float uClamp;
uniform float uHalfSteps;   // 1 when the target is half float

uniform vec3 uEye;
uniform vec3 uRight;
uniform vec3 uUp;
uniform vec3 uFwd;
uniform vec2 uTan;
uniform float uLensRadius;
uniform float uFocus;

uniform int uEnvMode;       // 0 constant colour, 1 sun and sky
uniform vec3 uEnvColor;
uniform vec3 uSunDir;
uniform vec3 uSunRadiance;
uniform vec2 uSunCone;      // cos of the sun's angular radius, and 1 - cos
uniform vec3 uSkySource;
uniform vec3 uSkyRayleigh;
uniform float uSkyMie;

float maxc(vec3 v) { return max(v.x, max(v.y, v.z)); }

/* Random numbers: a PCG stream per pixel and sample. */

uint gRng = 0u;

uint hashU(uint v) {
  uint s = v * 747796405u + 2891336453u;
  uint w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;
  return (w >> 22u) ^ w;
}

uint nextU() {
  gRng = gRng * 747796405u + 2891336453u;
  uint w = ((gRng >> ((gRng >> 28u) + 4u)) ^ gRng) * 277803737u;
  return (w >> 22u) ^ w;
}

// top 24 bits, so the result is exactly representable and strictly below 1
float unit(uint v) { return float(v >> 8u) * (1.0 / 16777216.0); }
float rnd() { return unit(nextU()); }
vec2 rnd2() {
  float a = rnd();
  float b = rnd();
  return vec2(a, b);
}

/* Sampling warps. */

// Orthonormal basis around a unit vector (Duff et al. 2017), stable for every direction.
void basis(vec3 n, out vec3 t, out vec3 b) {
  float s = n.z >= 0.0 ? 1.0 : -1.0;
  float a = -1.0 / (s + n.z);
  float c = n.x * n.y * a;
  t = vec3(1.0 + s * n.x * n.x * a, s * c, -s * n.x);
  b = vec3(c, s + n.y * n.y * a, -n.y);
}

vec3 cosineHemisphere(vec2 u) {
  float r = sqrt(u.x);
  float phi = TAU * u.y;
  return vec3(r * cos(phi), r * sin(phi), sqrt(max(0.0, 1.0 - u.x)));
}

// Shirley's concentric map: unit square to unit disc with little distortion.
vec2 concentricDisc(vec2 u) {
  vec2 o = 2.0 * u - 1.0;
  if (o.x == 0.0 && o.y == 0.0) return vec2(0.0);
  float r = 0.0;
  float th = 0.0;
  if (abs(o.x) > abs(o.y)) {
    r = o.x;
    th = (PI / 4.0) * (o.y / o.x);
  } else {
    r = o.y;
    th = PI / 2.0 - (PI / 4.0) * (o.x / o.y);
  }
  return r * vec2(cos(th), sin(th));
}

// Uniform direction inside a cone around axis; oneMinusCos = 1 - cos(half angle).
vec3 sampleCone(vec3 axis, float oneMinusCos, vec2 u) {
  float c = 1.0 - u.x * oneMinusCos;
  float s = sqrt(max(0.0, 1.0 - c * c));
  float phi = TAU * u.y;
  vec3 t = vec3(0.0);
  vec3 b = vec3(0.0);
  basis(axis, t, b);
  return normalize(t * (s * cos(phi)) + b * (s * sin(phi)) + axis * c);
}
`;
