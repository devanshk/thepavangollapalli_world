// GLSL display pass: expose and tone-map the accumulation buffer, upsample it, encode for the screen.

export const DISPLAY = `
in vec2 vUv;
out vec4 outColor;

uniform sampler2D uAccum;
uniform vec2 uAccumSize;
uniform float uExposure;

// Stephen Hill's fit of the ACES reference rendering and output transforms.
const mat3 ACES_IN = mat3(0.59719, 0.07600, 0.02840, 0.35458, 0.90834, 0.13383, 0.04823, 0.01566, 0.83777);
const mat3 ACES_OUT = mat3(1.60475, -0.10208, -0.00327, -0.53108, 1.10813, -0.07276, -0.07367, -0.00605, 1.07602);

vec3 toneMap(vec3 c) {
  vec3 v = ACES_IN * c;
  vec3 a = v * (v + 0.0245786) - 0.000090537;
  vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081;
  return clamp(ACES_OUT * (a / b), 0.0, 1.0);
}

vec3 toSrgb(vec3 c) {
  vec3 lo = c * 12.92;
  vec3 hi = 1.055 * pow(max(c, vec3(0.0031308)), vec3(1.0 / 2.4)) - 0.055;
  return mix(hi, lo, vec3(lessThan(c, vec3(0.0031308))));
}

vec3 developed(ivec2 at) {
  return toSrgb(toneMap(max(texelFetch(uAccum, at, 0).rgb, vec3(0.0)) * uExposure));
}

// Bilinear upsampling by hand (float32 textures cannot be filtered by the GPU on many phones).
// Texels are tone-mapped and encoded before they are blended: blending raw radiance would let
// one very bright texel swamp its neighbours and turn smooth edges into staircases.
vec3 sampleDeveloped(vec2 uv) {
  vec2 p = uv * uAccumSize - 0.5;
  vec2 base = floor(p);
  vec2 f = p - base;
  ivec2 hi = ivec2(uAccumSize) - 1;
  ivec2 a = clamp(ivec2(base), ivec2(0), hi);
  ivec2 b = clamp(ivec2(base) + 1, ivec2(0), hi);
  return mix(
    mix(developed(a), developed(ivec2(b.x, a.y)), f.x),
    mix(developed(ivec2(a.x, b.y)), developed(b), f.x),
    f.y
  );
}

float hash12(vec2 p) {
  vec3 q = fract(vec3(p.xyx) * 0.1031);
  q += dot(q, q.yzx + 33.33);
  return fract((q.x + q.y) * q.z);
}

void main() {
  vec3 srgb = sampleDeveloped(vUv);
  // triangular dither of one 8-bit step hides banding in smooth gradients
  float noise = hash12(gl_FragCoord.xy) - hash12(gl_FragCoord.xy + 17.0);
  outColor = vec4(srgb + noise / 255.0, 1.0);
}
`;
