// shader-view.js — the picture: dye with relief lighting, or a colour-mapped field.
// The colour maps are built in OKLCh so that lightness rises steadily with the value:
// "ember" (sequential) for speed, and a dark-centred diverging map for vorticity and pressure.

export const DISPLAY = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler2D;
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D uDye;
uniform sampler2D uVel;
uniform sampler2D uP;
uniform sampler2D uCurl;
uniform sampler2D uMask;
uniform vec2 uGrid;
uniform vec2 uInv;
uniform vec2 uDyeInv;
uniform int uView;
uniform float uScale;
uniform vec3 uBg;
uniform vec3 uBody;
uniform vec3 uRim;

// OKLCh to linear sRGB.
vec3 oklch(float L, float C, float h) {
  float a = C * cos(h);
  float b = C * sin(h);
  float l = L + 0.3963377774 * a + 0.2158037573 * b;
  float m = L - 0.1055613458 * a - 0.0638541728 * b;
  float s = L - 0.0894841775 * a - 1.2914855480 * b;
  l = l * l * l;
  m = m * m * m;
  s = s * s * s;
  return vec3(
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s);
}
vec3 toSrgb(vec3 c) {
  c = clamp(c, 0.0, 1.0);
  return mix(12.92 * c, 1.055 * pow(max(c, vec3(1e-6)), vec3(1.0 / 2.4)) - 0.055, step(vec3(0.0031308), c));
}
// t in 0..1: near-black violet, through red and orange, to pale yellow.
vec3 ember(float t) {
  return oklch(mix(0.10, 0.96, t), 0.03 + 0.14 * sin(3.14159265 * t), radians(285.0 + 180.0 * t));
}
// x in -1..1: blue for negative, orange for positive, dark at zero, equally light either side.
vec3 diverging(float x) {
  float a = min(abs(x), 1.0);
  float hue = x > 0.0 ? 45.0 + 45.0 * a : 255.0 - 45.0 * a;
  return oklch(0.13 + 0.80 * a, 0.13 * sin(2.2 * a), radians(hue));
}
// Compress an unbounded value into -1..1: linear near zero, levelling off for large values.
float squash(float x) { return x / sqrt(1.0 + x * x); }
float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }

vec3 dyeShade(vec2 uv) {
  vec3 d = max(texture(uDye, uv).rgb, vec3(0.0));
  float peak = max(d.r, max(d.g, d.b));
  vec2 e = 2.0 * uDyeInv;
  float gx = luma(texture(uDye, uv + vec2(e.x, 0.0)).rgb) - luma(texture(uDye, uv - vec2(e.x, 0.0)).rgb);
  float gy = luma(texture(uDye, uv + vec2(0.0, e.y)).rgb) - luma(texture(uDye, uv - vec2(0.0, e.y)).rgb);
  vec3 n = normalize(vec3(-1.8 * gx, -1.8 * gy, 1.0));
  vec3 light = normalize(vec3(-0.45, 0.6, 0.66));
  float diffuse = dot(n, light);
  float spec = pow(max(dot(n, normalize(light + vec3(0.0, 0.0, 1.0))), 1e-4), 28.0);
  // Scale all three channels alike so thick dye brightens without drifting in hue.
  // A soft toe keeps the thin haze left by mixing dark, so clear water still reads as clear.
  float tone = 1.0 - exp(-1.7 * peak * smoothstep(0.0, 0.3, peak));
  vec3 col = d / max(peak, 1e-4) * tone;
  col *= 0.62 + 0.58 * diffuse;
  col += vec3(0.16) * spec * tone;
  return uBg * (1.0 - 0.85 * tone) + col;
}

float pressureAt(vec2 x) {
  vec2 q = x - 0.5;
  ivec2 b = ivec2(floor(q));
  vec2 f = q - vec2(b);
  ivec2 top = ivec2(uGrid) - 1;
  float p00 = texelFetch(uP, clamp(b, ivec2(0), top), 0).r;
  float p10 = texelFetch(uP, clamp(b + ivec2(1, 0), ivec2(0), top), 0).r;
  float p01 = texelFetch(uP, clamp(b + ivec2(0, 1), ivec2(0), top), 0).r;
  float p11 = texelFetch(uP, clamp(b + ivec2(1, 1), ivec2(0), top), 0).r;
  return mix(mix(p00, p10, f.x), mix(p01, p11, f.x), f.y);
}

void main() {
  vec2 x = vUv * uGrid;
  // The outermost ring of cells is wall: show the fluid beside it, not what the wall holds.
  vec2 xf = clamp(x, vec2(1.5), uGrid - 1.5);
  vec3 col = vec3(0.0);
  if (uView == 0) {
    col = dyeShade(xf * uInv);
  } else if (uView == 1) {
    vec2 vel = vec2(texture(uVel, (xf + vec2(0.5, 0.0)) * uInv).r, texture(uVel, (xf + vec2(0.0, 0.5)) * uInv).g);
    col = ember(clamp(length(vel) * uScale, 0.0, 1.0));
  } else if (uView == 2) {
    col = diverging(squash(texture(uCurl, (xf + 0.5) * uInv).r * uScale));
  } else {
    col = diverging(squash(pressureAt(xf) * uScale));
  }

  // Obstacles, drawn from the mask. The walls on the edge of the domain are not shown.
  // Four taps half a cell apart blur the mask a little, which rounds off the cell staircase.
  vec2 o = 0.5 * uInv;
  float m = 0.25 * (texture(uMask, vUv + o).r + texture(uMask, vUv - o).r
    + texture(uMask, vUv + vec2(o.x, -o.y)).r + texture(uMask, vUv + vec2(-o.x, o.y)).r);
  float inside = smoothstep(1.5, 2.5, min(min(x.x, x.y), min(uGrid.x - x.x, uGrid.y - x.y)));
  float body = smoothstep(0.44, 0.56, m) * inside;
  float rim = (smoothstep(0.44, 0.56, m) - smoothstep(0.62, 0.84, m)) * inside;
  col = mix(col, uBody, body) + uRim * rim * 0.55;

  float noise = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
  fragColor = vec4(toSrgb(col) + (noise - 0.5) / 255.0, 1.0);
}`;
