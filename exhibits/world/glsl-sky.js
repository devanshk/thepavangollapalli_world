// GLSL: everything that is not the surface. Atmospheric scattering, the ring system,
// the star field and the sun's glare.
import { chapmanGLSL } from './atmosphere.js';

export const GLSL_SKY = /* glsl */ `
const float PI = 3.14159265;
const int ATMO_STEPS = 8;
// Single scattering only; this stands in for the light that scatters more than once.
const float SCATTER_GAIN = 1.7;

${chapmanGLSL}

// Sunlight left after crossing the atmosphere to a point at height h (in scale heights),
// where c is the cosine of the sun's zenith angle. Blue is removed first, so low sun is red.
vec3 sunTransmit(float h, float c) {
  if (uAtmoOn < 0.5) return vec3(smoothstep(-0.015, 0.03, c));
  return exp(-uTauExt * chapman(uX, h, c));
}

// Sunlight scattered toward the camera along the ray between t0 and t1, and how much of
// what lies behind survives the trip. Each step asks the closed-form Chapman function how
// much air the sun's ray crossed to reach it, so no second loop is needed.
// A ray that just clears the ground sees twice the air of one that just touches it;
// farWeight fades in that far half over the lowest half scale height, so the horizon
// reads as haze instead of a hard line.
vec3 atmosphere(vec3 ro, vec3 rd, float t0, float t1, float tMid, float farWeight, out vec3 trans) {
  float dt = (t1 - t0) / float(ATMO_STEPS);
  float od = 0.0;
  vec3 sum = vec3(0.0);
  for (int i = 0; i < ATMO_STEPS; i++) {
    float t = t0 + (float(i) + 0.5) * dt;
    vec3 pos = ro + rd * t;
    float r = length(pos);
    float h = max(r - 1.0, 0.0) * uX;
    float seg = exp(-h) * dt * uX;
    float odSun = chapman(uX, h, dot(pos, uSun) / r);
    sum += (t > tMid ? farWeight : 1.0) * seg * exp(-uTauExt * (od + 0.5 * seg + odSun));
    od += seg;
  }
  trans = exp(-uTauExt * od);
  float mu = dot(rd, uSun);
  float phaseR = 0.1875 * (1.0 + mu * mu);
  const float g = 0.76;
  float phaseM = 0.375 * (1.0 - g * g) * (1.0 + mu * mu) / ((2.0 + g * g) * pow(1.0 + g * g - 2.0 * g * mu, 1.5));
  return SCATTER_GAIN * (uTauR * phaseR + vec3(uTauM * phaseM)) * sum;
}

float hash01(uint n) {
  return float(mix32(n) >> 8) / 16777216.0;
}

float noise1(float x, uint seed) {
  float cell = floor(x);
  float f = x - cell;
  uint n = uint(int(cell)) + seed;
  return mix(hash01(n), hash01(n + 1u), f * f * (3.0 - 2.0 * f));
}

// Optical thickness of the rings at radius r: broad bands, ringlets and one dark division.
// blur is the size of a pixel in the same normalised units and fades what it cannot resolve.
float ringDensity(float r, float blur) {
  float x = (r - uRing.x) / (uRing.y - uRing.x);
  if (x <= 0.0 || x >= 1.0) return 0.0;
  uint s = layerSeed(L_RING);
  float mid = (noise1(x * 15.0, s + 7u) - 0.5) * clamp(1.0 / (blur * 45.0), 0.0, 1.0);
  float fine = (noise1(x * 53.0, s + 13u) - 0.5) * clamp(1.0 / (blur * 160.0), 0.0, 1.0);
  float hair = (noise1(x * 170.0, s + 17u) - 0.5) * clamp(1.0 / (blur * 510.0), 0.0, 1.0);
  float broad = noise1(x * 4.0, s);
  float d = (0.12 + 0.88 * broad * broad) * (1.0 + 1.3 * mid + 1.1 * fine + 0.8 * hair);
  float gap = 0.34 + 0.3 * hash01(s + 99u);
  d *= 0.06 + 0.94 * smoothstep(0.012, 0.026 + blur, abs(x - gap));
  d *= smoothstep(0.0, 0.03 + blur, x) * smoothstep(1.0, 0.95 - blur, x);
  return clamp(d, 0.0, 1.0) * uRing.z;
}

// Where the view ray crosses the ring plane (the planet's equator): colour in rgb,
// coverage in a. tHit is negative when the ray misses the rings.
vec4 ringLayer(vec3 ro, vec3 rd, out float tHit) {
  tHit = -1.0;
  if (uRing.z <= 0.0) return vec4(0.0);
  vec3 axis = uRot[1];
  float cosV = dot(rd, axis);
  if (abs(cosV) < 1e-4) return vec4(0.0);
  float t = -dot(ro, axis) / cosV;
  if (t <= 0.0) return vec4(0.0);
  vec3 pos = ro + rd * t;
  float r = length(pos);
  if (r <= uRing.x || r >= uRing.y) return vec4(0.0);
  float blur = t * uPix / ((uRing.y - uRing.x) * max(abs(cosV), 0.05));
  float d = ringDensity(r, blur);
  float alpha = 1.0 - exp(-1.1 * d / max(abs(cosV), 0.12));
  // the planet's shadow falls across the far side of the rings
  float lit = 1.0;
  float along = dot(pos, uSun);
  if (along < 0.0) lit = 0.02 + 0.98 * smoothstep(0.975, 1.05, sqrt(max(r * r - along * along, 0.0)));
  float cosS = dot(uSun, axis);
  // seen from the unlit side, only light filtering through thin parts shows
  float face = cosS * cosV < 0.0 ? 1.0 : 0.1 + 1.6 * d * exp(-3.0 * d);
  float glow = mix(0.45, 1.0, min(abs(cosS) * 2.5, 1.0));
  vec3 tone = uRingColor * (0.7 + 0.4 * noise1((r - uRing.x) * 7.0, layerSeed(L_RING) + 31u));
  tHit = t;
  return vec4(tone * lit * face * glow, alpha);
}

// How much sunlight the rings let through to a point on the planet (view space).
float ringShadow(vec3 pv) {
  if (uRing.z <= 0.0) return 1.0;
  vec3 axis = uRot[1];
  float cosS = dot(uSun, axis);
  if (abs(cosS) < 1e-4) return 1.0;
  float s = -dot(pv, axis) / cosS;
  if (s <= 0.0) return 1.0;
  float d = ringDensity(length(pv + uSun * s), 0.02);
  return exp(-1.1 * d / max(abs(cosS), 0.12));
}

// One sparse layer of stars on a grid: at most one star per cell, kept clear of the cell's
// edge so no neighbour lookups are needed. Most are faint; brightness rises steeply.
vec3 starLayer(vec2 uv, float cells, uint salt, float chance, float swell, float gain) {
  vec2 g = uv * cells;
  vec2 id = floor(g);
  uint h = mix32(uint(int(id.x)) * KX + uint(int(id.y)) * KY + layerSeed(L_STARS) + salt);
  if (float(h & 255u) > chance * 255.0) return vec3(0.0);
  vec2 pos = 0.22 + 0.56 * vec2(float((h >> 8) & 255u), float((h >> 16) & 255u)) / 255.0;
  float m = float(h >> 24) / 255.0;
  float mag = m * m * m;
  mag *= mag;
  float size = uStarSize * (1.0 + swell * mag);
  vec2 d = (g - id - pos) / (cells * size);
  float warmth = float(mix32(h) & 255u) / 255.0;
  vec3 tint = warmth < 0.5 ? mix(vec3(1.0, 0.72, 0.5), vec3(1.0), warmth * 2.0) : mix(vec3(1.0), vec3(0.64, 0.78, 1.0), warmth * 2.0 - 1.0);
  return tint * gain * (0.04 + mag) * exp(-dot(d, d));
}

// The sky behind the planet: three layers of stars and a faint band of unresolved ones,
// laid across the view at an angle the seed picks.
vec3 stars(vec2 uv) {
  uint s = layerSeed(L_STARS);
  float angle = 6.2832 * hash01(s + 5u);
  vec2 dir = vec2(cos(angle), sin(angle));
  float across = dot(uv, vec2(-dir.y, dir.x)) - (hash01(s + 6u) - 0.5);
  float band = exp(-across * across * 2.6) * max(0.5 + 1.1 * fbm(vec3(uv * 1.9, 0.5), s, 3.0, 0.55), 0.0);
  vec3 sky = vec3(0.5, 0.58, 0.82) * 0.016 * band;
  float rich = 0.6 + 1.3 * band;
  sky += starLayer(uv, 43.0, 0u, 0.16 * rich, 0.3, 0.55);
  sky += starLayer(uv + 0.37, 16.0, 31u, 0.1 * rich, 0.7, 1.1);
  sky += starLayer(uv - 0.19, 5.0, 77u, 0.14, 1.3, 2.4);
  return sky;
}

// The sun's disc and the glare around it, dimmed and reddened as it sets behind the limb.
vec3 sunGlare(vec3 ro, vec3 rd, bool hitGround) {
  float c = dot(rd, uSun);
  if (c <= 0.0) return vec3(0.0);
  vec3 vis = vec3(1.0);
  float along = dot(ro, uSun);
  if (along < 0.0) {
    float miss = sqrt(max(dot(ro, ro) - along * along, 0.0));
    vis = vec3(smoothstep(0.996, 1.012, miss));
    if (uAtmoOn > 0.5) {
      float x0 = miss * uX;
      vis *= exp(-uTauExt * (2.0 * sqrt(0.5 * PI * x0) * exp(clamp(uX - x0, -40.0, 30.0))));
    }
  }
  float angle = sqrt(max(2.0 - 2.0 * c, 0.0));
  float disc = hitGround ? 0.0 : 40.0 * smoothstep(0.0062, 0.0042, angle);
  float q1 = angle / 0.011;
  float q2 = angle / 0.07;
  return vis * (disc + 1.1 / (1.0 + q1 * q1) + 0.07 / (1.0 + q2 * q2));
}
`;
