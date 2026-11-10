// shaders.js — the simulation passes. Each one mirrors a function in ref.js.
// Velocity texture: r = u on the cell's left face, g = v on its bottom face, in cells per step.
// Mask texture: 0 fluid, 1 solid, 0.2 open outflow.

const HEAD = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D uVel;
uniform sampler2D uMask;
uniform ivec2 uSize;
uniform vec2 uInv;
uniform vec2 uSlip;
uniform float uInflow;
uniform float uDt;

float cellType(ivec2 c) {
  if (c.x < 0 || c.y < 0 || c.x >= uSize.x || c.y >= uSize.y) return 1.0;
  return texelFetch(uMask, c, 0).r;
}
bool isSolid(ivec2 c) { return cellType(c) > 0.6; }
vec2 fetchVel(ivec2 c) { return texelFetch(uVel, clamp(c, ivec2(0), uSize - 1), 0).rg; }
// x is a position in cells. uSlip keeps u lookups out of the tunnel walls (free slip).
float sampleU(sampler2D t, vec2 x) {
  vec2 q = (x + vec2(0.5, 0.0)) * uInv;
  q.y = clamp(q.y, uSlip.x, uSlip.y);
  return texture(t, q).r;
}
float sampleV(sampler2D t, vec2 x) { return texture(t, (x + vec2(0.0, 0.5)) * uInv).g; }
// Faces that touch a solid cell take the solid's velocity. Also the last line of defence
// against a non-finite value spreading through the field.
vec2 walls(ivec2 c, vec2 vel) {
  float t = cellType(c);
  if (t > 0.6 || isSolid(c - ivec2(1, 0))) vel.x = (uInflow > 0.0 && c.x <= 1) ? uInflow : 0.0;
  if (t > 0.1 || isSolid(c - ivec2(0, 1))) vel.y = 0.0;
  if (isnan(vel.x) || isinf(vel.x)) vel.x = 0.0;
  if (isnan(vel.y) || isinf(vel.y)) vel.y = 0.0;
  return clamp(vel, vec2(-64.0), vec2(64.0));
}
float nearSolid(vec2 x, vec2 back) { return texture(uMask, x * uInv).r + texture(uMask, back * uInv).r; }
`;

const SPLATS = `
uniform int uCount;
uniform vec4 uSeg[8];
float capsule(vec2 p, vec2 a, vec2 b) {
  vec2 pa = p - a;
  vec2 ba = b - a;
  float h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-6), 0.0, 1.0);
  return length(pa - ba * h);
}
`;

export const ADVECT_VEL = `${HEAD}
void main() {
  ivec2 c = ivec2(gl_FragCoord.xy);
  vec2 xu = vec2(float(c.x), float(c.y) + 0.5);
  vec2 xv = vec2(float(c.x) + 0.5, float(c.y));
  vec2 velU = vec2(sampleU(uVel, xu), sampleV(uVel, xu));
  vec2 velV = vec2(sampleU(uVel, xv), sampleV(uVel, xv));
  fragColor = vec4(sampleU(uVel, xu - uDt * velU), sampleV(uVel, xv - uDt * velV), 0.0, 1.0);
}`;

export const ADVECT_VEL_FIX = `${HEAD}
uniform sampler2D uHat;
void bounds(vec2 q, out vec2 lo, out vec2 hi) {
  ivec2 b = ivec2(floor(q - 0.5));
  ivec2 top = uSize - 1;
  vec2 s0 = texelFetch(uVel, clamp(b, ivec2(0), top), 0).rg;
  vec2 s1 = texelFetch(uVel, clamp(b + ivec2(1, 0), ivec2(0), top), 0).rg;
  vec2 s2 = texelFetch(uVel, clamp(b + ivec2(0, 1), ivec2(0), top), 0).rg;
  vec2 s3 = texelFetch(uVel, clamp(b + ivec2(1, 1), ivec2(0), top), 0).rg;
  lo = min(min(s0, s1), min(s2, s3));
  hi = max(max(s0, s1), max(s2, s3));
}
void main() {
  ivec2 c = ivec2(gl_FragCoord.xy);
  vec2 xu = vec2(float(c.x), float(c.y) + 0.5);
  vec2 xv = vec2(float(c.x) + 0.5, float(c.y));
  vec2 velU = vec2(sampleU(uVel, xu), sampleV(uVel, xu));
  vec2 velV = vec2(sampleU(uVel, xv), sampleV(uVel, xv));
  vec2 backU = xu - uDt * velU;
  vec2 backV = xv - uDt * velV;
  vec2 raw = texelFetch(uVel, c, 0).rg;
  vec2 hat = texelFetch(uHat, c, 0).rg;
  vec2 lo = vec2(0.0);
  vec2 hi = vec2(0.0);
  float u = hat.r;
  if (nearSolid(xu, backU) <= 0.0) {
    vec2 q = backU + vec2(0.5, 0.0);
    q.y = clamp(q.y, uSlip.x * float(uSize.y), uSlip.y * float(uSize.y));
    bounds(q, lo, hi);
    u = clamp(hat.r + 0.5 * (raw.r - sampleU(uHat, xu + uDt * velU)), lo.x, hi.x);
  }
  float v = hat.g;
  if (nearSolid(xv, backV) <= 0.0) {
    bounds(backV + vec2(0.0, 0.5), lo, hi);
    v = clamp(hat.g + 0.5 * (raw.g - sampleV(uHat, xv + uDt * velV)), lo.y, hi.y);
  }
  fragColor = vec4(walls(c, vec2(u, v)), 0.0, 1.0);
}`;

// Vorticity on cell corners: texel (i, j) is the lower-left corner of cell (i, j).
export const CURL = `${HEAD}
void main() {
  ivec2 c = ivec2(gl_FragCoord.xy);
  float w = 0.0;
  if (!(isSolid(c) || isSolid(c - ivec2(1, 0)) || isSolid(c - ivec2(0, 1)) || isSolid(c - ivec2(1, 1)))) {
    vec2 a = fetchVel(c);
    w = (a.g - fetchVel(c - ivec2(1, 0)).g) - (a.r - fetchVel(c - ivec2(0, 1)).r);
  }
  fragColor = vec4(w, 0.0, 0.0, 1.0);
}`;

export const FORCES = `${HEAD}
uniform sampler2D uCurl;
uniform float uConfine;
uniform float uVisc;
uniform float uFade;
float curlAt(ivec2 c) {
  if (c.x < 0 || c.y < 0 || c.x >= uSize.x || c.y >= uSize.y) return 0.0;
  return texelFetch(uCurl, c, 0).r;
}
void main() {
  ivec2 c = ivec2(gl_FragCoord.xy);
  vec2 vel = texelFetch(uVel, c, 0).rg;
  vec2 l = fetchVel(c - ivec2(1, 0));
  vec2 r = fetchVel(c + ivec2(1, 0));
  vec2 d = fetchVel(c - ivec2(0, 1));
  vec2 t = fetchVel(c + ivec2(0, 1));
  if (uInflow > 0.0) {
    if (c.y <= 1) d.x = vel.x;
    if (c.y >= uSize.y - 2) t.x = vel.x;
  }
  vec2 next = vel + uVisc * uDt * (l + r + d + t - 4.0 * vel);

  // Confinement pushes along N x w, where N points up the gradient of |w|.
  float w00 = curlAt(c);
  float w10 = curlAt(c + ivec2(1, 0));
  float w01 = curlAt(c + ivec2(0, 1));
  float a00 = abs(w00);
  float a10 = abs(w10);
  float a01 = abs(w01);
  float a11 = abs(curlAt(c + ivec2(1, 1)));
  vec2 g = vec2(0.25 * (a10 + a11 - abs(curlAt(c - ivec2(1, 0))) - abs(curlAt(c + ivec2(-1, 1)))), a01 - a00);
  next.x += uConfine * uDt * (g.y / (length(g) + 1e-4)) * 0.5 * (w00 + w01);
  g = vec2(a10 - a00, 0.25 * (a01 + a11 - abs(curlAt(c - ivec2(0, 1))) - abs(curlAt(c + ivec2(1, -1)))));
  next.y -= uConfine * uDt * (g.x / (length(g) + 1e-4)) * 0.5 * (w00 + w10);

  // Outflow sponge: ease back to the free stream so eddies leave quietly.
  if (uInflow > 0.0) {
    float s = 0.08 * smoothstep(0.88, 1.0, (float(c.x) + 0.5) * uInv.x);
    next = mix(next, vec2(uInflow, 0.0), s);
  }
  fragColor = vec4(walls(c, next * uFade), 0.0, 1.0);
}`;

// Pull the fluid under each stroke towards the stroke's own velocity.
export const SPLAT_VEL = `${HEAD}${SPLATS}
uniform vec4 uVal[8];
void main() {
  ivec2 c = ivec2(gl_FragCoord.xy);
  vec2 vel = texelFetch(uVel, c, 0).rg;
  for (int i = 0; i < 8; i++) {
    if (i >= uCount) break;
    float dist = capsule(gl_FragCoord.xy, uSeg[i].xy, uSeg[i].zw);
    float radius = max(uVal[i].z, 1e-3);
    vel = mix(vel, uVal[i].xy, uVal[i].w * exp(-dist * dist / (radius * radius)));
  }
  fragColor = vec4(walls(c, vel), 0.0, 1.0);
}`;

export const DIVERGENCE = `${HEAD}
void main() {
  ivec2 c = ivec2(gl_FragCoord.xy);
  float div = 0.0;
  if (cellType(c) < 0.1) {
    vec2 a = texelFetch(uVel, c, 0).rg;
    div = fetchVel(c + ivec2(1, 0)).r - a.r + fetchVel(c + ivec2(0, 1)).g - a.g;
  }
  fragColor = vec4(div, 0.0, 0.0, 1.0);
}`;

// One colour of a red-black over-relaxation sweep. Open cells hold p = 0; solid neighbours
// are skipped, which is the zero-gradient (Neumann) condition at a wall.
export const RELAX = `${HEAD}
uniform sampler2D uP;
uniform sampler2D uDiv;
uniform int uParity;
uniform float uOmega;
void main() {
  ivec2 c = ivec2(gl_FragCoord.xy);
  if (cellType(c) > 0.1) {
    fragColor = vec4(0.0, 0.0, 0.0, 1.0);
    return;
  }
  float pc = texelFetch(uP, c, 0).r;
  if (((c.x + c.y) & 1) != uParity) {
    fragColor = vec4(pc, 0.0, 0.0, 1.0);
    return;
  }
  float sum = 0.0;
  float count = 0.0;
  ivec2 nb = c - ivec2(1, 0);
  if (!isSolid(nb)) { sum += texelFetch(uP, nb, 0).r; count += 1.0; }
  nb = c + ivec2(1, 0);
  if (!isSolid(nb)) { sum += texelFetch(uP, nb, 0).r; count += 1.0; }
  nb = c - ivec2(0, 1);
  if (!isSolid(nb)) { sum += texelFetch(uP, nb, 0).r; count += 1.0; }
  nb = c + ivec2(0, 1);
  if (!isSolid(nb)) { sum += texelFetch(uP, nb, 0).r; count += 1.0; }
  float goal = count > 0.0 ? (sum - texelFetch(uDiv, c, 0).r) / count : 0.0;
  fragColor = vec4(clamp(pc + uOmega * (goal - pc), -4000.0, 4000.0), 0.0, 0.0, 1.0);
}`;

export const GRADIENT = `${HEAD}
uniform sampler2D uP;
void main() {
  ivec2 c = ivec2(gl_FragCoord.xy);
  vec2 vel = texelFetch(uVel, c, 0).rg;
  float pc = texelFetch(uP, c, 0).r;
  float pl = c.x > 0 ? texelFetch(uP, c - ivec2(1, 0), 0).r : 0.0;
  float pd = c.y > 0 ? texelFetch(uP, c - ivec2(0, 1), 0).r : 0.0;
  fragColor = vec4(walls(c, vel - vec2(pc - pl, pc - pd)), 0.0, 1.0);
}`;

const DYE_HEAD = `${HEAD}
uniform sampler2D uDye;
uniform vec2 uDyeSize;
vec2 velocityAt(vec2 x) { return vec2(sampleU(uVel, x), sampleV(uVel, x)); }
`;

export const ADVECT_DYE = `${DYE_HEAD}
void main() {
  vec2 x = vUv * vec2(uSize);
  fragColor = vec4(texture(uDye, (x - uDt * velocityAt(x)) * uInv).rgb, 1.0);
}`;

export const ADVECT_DYE_FIX = `${DYE_HEAD}
uniform sampler2D uHat;
void main() {
  ivec2 c = ivec2(gl_FragCoord.xy);
  vec2 x = vUv * vec2(uSize);
  vec2 vel = velocityAt(x);
  vec2 back = x - uDt * vel;
  vec3 dye = texelFetch(uHat, c, 0).rgb;
  if (nearSolid(x, back) <= 0.0) {
    ivec2 b = ivec2(floor(back * uInv * uDyeSize - 0.5));
    ivec2 top = ivec2(uDyeSize) - 1;
    vec3 s0 = texelFetch(uDye, clamp(b, ivec2(0), top), 0).rgb;
    vec3 s1 = texelFetch(uDye, clamp(b + ivec2(1, 0), ivec2(0), top), 0).rgb;
    vec3 s2 = texelFetch(uDye, clamp(b + ivec2(0, 1), ivec2(0), top), 0).rgb;
    vec3 s3 = texelFetch(uDye, clamp(b + ivec2(1, 1), ivec2(0), top), 0).rgb;
    vec3 fixed3 = dye + 0.5 * (texelFetch(uDye, c, 0).rgb - texture(uHat, (x + uDt * vel) * uInv).rgb);
    dye = clamp(fixed3, min(min(s0, s1), min(s2, s3)), max(max(s0, s1), max(s2, s3)));
  }
  fragColor = vec4(dye, 1.0);
}`;

// Fade, new dye from strokes, the tunnel's streaklines, and dye inside solids (which copies
// the fluid next to it so that walls neither add nor eat dye).
export const DYE_SOURCE = `${DYE_HEAD}${SPLATS}
uniform vec4 uCol[8];
uniform float uFade;
uniform float uStreaks;
uniform vec3 uStreakCol[6];
vec3 streak(float y) {
  float bands = 13.0;
  float f = fract(y * bands);
  float px = 1.5 * bands / uDyeSize.y;
  float band = smoothstep(0.34 - px, 0.34 + px, f) * (1.0 - smoothstep(0.66 - px, 0.66 + px, f));
  int index = int(clamp(floor(y * 6.0), 0.0, 5.0));
  return uStreakCol[index] * band;
}
void main() {
  vec2 x = vUv * vec2(uSize);
  ivec2 cell = ivec2(floor(x));
  vec3 dye = vec3(0.0);
  if (isSolid(cell)) {
    float count = 0.0;
    if (!isSolid(cell - ivec2(1, 0))) { dye += texture(uDye, (x - vec2(1.0, 0.0)) * uInv).rgb; count += 1.0; }
    if (!isSolid(cell + ivec2(1, 0))) { dye += texture(uDye, (x + vec2(1.0, 0.0)) * uInv).rgb; count += 1.0; }
    if (!isSolid(cell - ivec2(0, 1))) { dye += texture(uDye, (x - vec2(0.0, 1.0)) * uInv).rgb; count += 1.0; }
    if (!isSolid(cell + ivec2(0, 1))) { dye += texture(uDye, (x + vec2(0.0, 1.0)) * uInv).rgb; count += 1.0; }
    dye /= max(count, 1.0);
  } else {
    dye = texelFetch(uDye, ivec2(gl_FragCoord.xy), 0).rgb * uFade;
    for (int i = 0; i < 8; i++) {
      if (i >= uCount) break;
      float dist = capsule(x, uSeg[i].xy, uSeg[i].zw);
      float radius = max(uCol[i].a, 1e-3);
      dye = mix(dye, uCol[i].rgb, 0.85 * exp(-dist * dist / (radius * radius)));
    }
  }
  if (uStreaks > 1.5 || (uStreaks > 0.5 && x.x < 2.5)) dye = streak(vUv.y);
  fragColor = vec4(max(dye, vec3(0.0)), 1.0);
}`;

// Move the velocity field onto a grid of another resolution (uRatio = old size / new size),
// rescaling it because velocities are measured in cells.
export const RESAMPLE_VEL = `${HEAD}
uniform vec2 uRatio;
uniform float uScale;
void main() {
  ivec2 c = ivec2(gl_FragCoord.xy);
  vec2 xu = vec2(float(c.x), float(c.y) + 0.5) * uRatio;
  vec2 xv = vec2(float(c.x) + 0.5, float(c.y)) * uRatio;
  fragColor = vec4(uScale * sampleU(uVel, xu), uScale * sampleV(uVel, xv), 0.0, 1.0);
}`;

export const COPY = `#version 300 es
precision highp float;
precision highp sampler2D;
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D uSrc;
void main() {
  fragColor = texture(uSrc, vUv);
}`;
