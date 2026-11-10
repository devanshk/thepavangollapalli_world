// Assembles the planet's fragment shader: one full-screen pass, one ray per pixel.
import { SPEC } from './terrain.js';
import { GLSL_NOISE } from './glsl-noise.js';
import { GLSL_SKY } from './glsl-sky.js';
import { GLSL_SURFACE } from './glsl-surface.js';

const layerConstants = Object.entries(SPEC.layers)
  .map(([name, index]) => `const uint L_${name.replace(/[A-Z]/g, (c) => '_' + c).toUpperCase()} = ${index}u;`)
  .join('\n');

/** Debug views read back by the tests: elevation, or one component of the surface gradient. */
export const DEBUG = { off: 0, elevation: 1, slopeX: 2, slopeY: 3, slopeZ: 4 };
/** Debug values v are written as 0.5 + v * scale, packed into 16 bits across red and green. */
export const DEBUG_SCALE = { elevation: 0.125, slope: 1 / 128 };

export const FRAGMENT_SHADER = /* glsl */ `#version 300 es
precision highp float;
precision highp int;

in vec2 vUv;
out vec4 outColor;

uniform vec2 uRes;         // canvas size in backing-store pixels
uniform float uPix;        // angle one pixel subtends at the centre of the view
uniform float uStarSize;   // star radius, in units of half the smaller canvas side
uniform float uCamDist;    // camera distance from the planet's centre (radius = 1)
uniform float uTanFov;
uniform vec2 uShift;       // where the planet's centre sits on screen
uniform mat3 uRot;         // planet space to view space
uniform vec3 uSun;         // unit vector toward the sun, view space
uniform uint uSeed;

uniform float uSea;
uniform float uContFreq;
uniform float uWarp;
uniform float uGain;
uniform float uMtnAmp;
uniform float uMtnFreq;
uniform float uBump;
uniform float uTempBase;
uniform float uTempLat;
uniform float uMoistBase;
uniform vec3 uPal[12];
uniform float uLava;
uniform float uLavaGlow;
uniform float uLights;

uniform vec3 uCloud;       // cover (0 when hidden), frequency, swirl
uniform vec2 uCloudTime;   // drift angle, evolution offset
uniform vec3 uCloudColor;

uniform float uAtmoOn;
uniform vec3 uTauR;        // Rayleigh vertical optical depth per channel
uniform float uTauM;       // haze vertical optical depth
uniform vec3 uTauExt;      // total extinction
uniform float uX;          // planet radius in scale heights
uniform float uTop;        // radius where the atmosphere is cut off
uniform vec3 uSkyLight;    // light the sky adds to a sunlit surface

uniform vec3 uRing;        // inner radius, outer radius, opacity (0 = no rings)
uniform vec3 uRingColor;

uniform float uLodBias;    // octaves dropped while the view is moving
uniform vec2 uFixedOcts;   // nonzero: force these octave counts (tests)
uniform int uDebug;

${layerConstants}
${GLSL_NOISE}
${GLSL_SKY}
${GLSL_SURFACE}

vec3 tonemap(vec3 x) {
  // ACES filmic fit (K. Narkowicz)
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
}

vec3 pack16(float v) {
  float q = floor(clamp(v, 0.0, 1.0) * 65535.0 + 0.5);
  float hi = floor(q / 256.0);
  return vec3(hi / 255.0, (q - hi * 256.0) / 255.0, 1.0);
}

void main() {
  vec2 uv = (vUv * 2.0 - 1.0) * uRes / min(uRes.x, uRes.y);
  vec3 ro = vec3(0.0, 0.0, uCamDist);
  vec3 rd = normalize(vec3((uv - uShift) * uTanFov, -1.0));
  float b = dot(ro, rd);
  float miss2 = dot(ro, ro) - b * b;   // squared distance from the planet's centre to the ray
  bool hit = miss2 < 1.0;
  float tGround = -b - sqrt(max(1.0 - miss2, 0.0));

  if (uDebug != 0) {
    vec3 o = vec3(0.0);
    if (hit) {
      vec3 p = normalize(ro + rd * tGround) * uRot;
      Terrain tr = terrain(p, uFixedOcts.x, uFixedOcts.y);
      vec3 slope = tr.g - p * dot(p, tr.g);
      float v = tr.e * ${DEBUG_SCALE.elevation};
      if (uDebug == 2) v = slope.x * ${DEBUG_SCALE.slope};
      if (uDebug == 3) v = slope.y * ${DEBUG_SCALE.slope};
      if (uDebug == 4) v = slope.z * ${DEBUG_SCALE.slope};
      o = pack16(0.5 + v);
    }
    outColor = vec4(o, 1.0);
    return;
  }

  // the limb is anti-aliased by blending the surface in over one pixel
  float cover = clamp(0.5 + (1.0 - sqrt(miss2)) / (uPix * -b), 0.0, 1.0);
  vec3 col = cover < 1.0 ? stars(uv) : vec3(0.0);

  float tRing = -1.0;
  vec4 ring = ringLayer(ro, rd, tRing);
  bool ringInFront = tRing > 0.0 && tRing < (hit ? tGround : -b);
  if (tRing > 0.0 && !ringInFront) col = mix(col, ring.rgb, ring.a);
  if (cover > 0.0) col = mix(col, shadeSurface(normalize(ro + rd * tGround), rd, tGround), cover);

  if (uAtmoOn > 0.5 && miss2 < uTop * uTop) {
    float halfChord = sqrt(uTop * uTop - miss2);
    vec3 trans = vec3(1.0);
    float farWeight = smoothstep(1.0, 1.0 + 0.5 / uX, sqrt(miss2));
    vec3 scattered = atmosphere(ro, rd, -b - halfChord, hit ? tGround : -b + halfChord, -b, farWeight, trans);
    col = col * trans + scattered;
  }

  if (ringInFront) col = mix(col, ring.rgb, ring.a);
  col += sunGlare(ro, rd, hit);

  col = pow(tonemap(col), vec3(1.0 / 2.2));
  // a little noise breaks up banding in the dark gradients
  uint n = mix32(uint(gl_FragCoord.x) * KX + uint(gl_FragCoord.y) * KY);
  col += (float(n & 255u) / 255.0 - 0.5) / 255.0;
  outColor = vec4(col, 1.0);
}
`;
