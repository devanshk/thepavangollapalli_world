// GLSL: the sky, the path-tracing loop, camera ray generation and progressive accumulation.

export const INTEGRATE = `
out vec4 outColor;

/* Sun and sky (see sky.js for the model). */

float airMass(float cosZenith) { return 1.0 / (cosZenith + 0.025 * exp(-11.0 * cosZenith)); }

vec3 skyRadiance(vec3 d) {
  float mu = dot(d, uSunDir);
  float phaseR = (3.0 / (16.0 * PI)) * (1.0 + mu * mu);
  const float g = 0.76;
  float phaseM = (1.0 - g * g) / (4.0 * PI * pow(max(1.0 + g * g - 2.0 * g * mu, 1e-3), 1.5));
  vec3 tau = uSkyRayleigh + vec3(uSkyMie);
  vec3 scattered = (uSkyRayleigh * phaseR + vec3(uSkyMie * phaseM)) / tau;
  return uSkySource * scattered * (1.0 - exp(-tau * airMass(max(d.y, 0.0))));
}

// Radiance arriving from outside the scene. The sun's disc is returned separately because it is
// also sampled directly, so the caller has to weight it.
vec3 environment(vec3 d, out vec3 sun) {
  sun = vec3(0.0);
  if (uEnvMode == 0) return uEnvColor;
  if (dot(d, uSunDir) >= uSunCone.x) sun = uSunRadiance;
  return skyRadiance(d);
}

/* Path tracing. */

// Scale a contribution down so its largest channel does not exceed cap (hue is preserved).
vec3 limit(vec3 c, float cap) {
  float m = maxc(c);
  return m > cap ? c * (cap / m) : c;
}

// Power heuristic for combining two sampling strategies: a^2 / (a^2 + b^2).
float misWeight(float a, float b) {
  float r = b / max(a, 1e-20);
  return 1.0 / (1.0 + r * r);
}

vec3 radiance(vec3 ro, vec3 rd) {
  vec3 L = vec3(0.0);
  vec3 beta = vec3(1.0);        // throughput of the path so far
  vec3 sigma = vec3(0.0);       // absorption of the glass the ray is inside, if any
  float pdfBsdf = 0.0;          // density of the last sampled direction
  bool delta = true;            // the last event was a mirror or glass (or the camera itself)
  int rough = 0;                // diffuse or glossy events so far
  float lightCount = float(uCounts.w + (uEnvMode == 1 ? 1 : 0));

  for (int bounce = 0; bounce <= MAX_BOUNCES; bounce++) {
    if (bounce > uMaxBounces) break;
    // Light reached by following the BSDF is left alone when it is seen directly, through
    // mirrors and glass only, or as the BSDF half of direct lighting. Anything longer is
    // where fireflies come from, so it is clamped.
    float cap = (rough == 0 || (rough == 1 && !delta)) ? INF : uClamp;

    Hit hit = Hit(INF, vec3(0.0, 1.0, 0.0), 0, 0, 0);
    if (!closestHit(ro, rd, hit)) {
      vec3 sun = vec3(0.0);
      vec3 sky = environment(rd, sun);
      if (maxc(sun) > 0.0 && !delta) {
        if (uStrategy == 2) sun = vec3(0.0);
        else if (uStrategy == 0) sun *= misWeight(pdfBsdf, sunPdf(lightCount));
      }
      L += limit(beta * (sky + sun), cap);
      break;
    }

    beta *= exp(-sigma * hit.t);
    vec3 p = ro + rd * hit.t;
    Material m = material(hit.mat, p);
    bool front = dot(rd, hit.n) < 0.0;
    vec3 n = front ? hit.n : -hit.n;

    if (m.type == EMISSIVE) {
      if (front) {
        float w = 1.0;
        if (!delta) {
          if (uStrategy == 2) w = 0.0;
          else if (uStrategy == 0) w = misWeight(pdfBsdf, emitterPdf(hit, ro, rd, lightCount));
        }
        L += limit(beta * m.color * w, cap);
      }
      break;
    }
    if (bounce == uMaxBounces) break;

    if (m.type == GLASS) {
      float eta = front ? 1.0 / m.ior : m.ior;
      float cosI = clamp(-dot(rd, n), 0.0, 1.0);
      float sin2T = eta * eta * (1.0 - cosI * cosI);
      float cosT = 0.0;
      bool refracted = false;
      if (sin2T < 1.0) {
        cosT = sqrt(1.0 - sin2T);
        refracted = rnd() >= fresnelDielectric(cosI, cosT, eta);
      }
      if (refracted) {
        rd = normalize(eta * rd + (eta * cosI - cosT) * n);
        ro = p - n * EPS;
        sigma = front ? -log(max(m.color, vec3(1e-4))) : vec3(0.0);
      } else {
        rd = reflect(rd, n);
        ro = p + n * EPS;
      }
      delta = true;
    } else {
      vec3 t = vec3(0.0);
      vec3 b = vec3(0.0);
      basis(n, t, b);
      vec3 wo = vec3(-dot(rd, t), -dot(rd, b), -dot(rd, n));
      bool mirror = m.type == METAL && m.alpha < MIRROR_ALPHA;

      // Next-event estimation: connect to a point on a light. The light is sampled from the
      // same lifted origin the shadow ray uses, so the ray cannot stop short on the light itself.
      vec3 lifted = p + n * EPS;
      if (!mirror && uStrategy != 1 && lightCount > 0.5) {
        LightSample ls = LightSample(vec3(0.0, 1.0, 0.0), 0.0, vec3(0.0), 0.0);
        if (sampleLight(lifted, lightCount, ls)) {
          vec3 wi = vec3(dot(ls.wi, t), dot(ls.wi, b), dot(ls.wi, n));
          float pdfB = 0.0;
          vec3 f = evalBsdf(m, wo, wi, pdfB);
          if (maxc(f) > 0.0 && !occluded(lifted, ls.wi, ls.dist - EPS)) {
            float w = uStrategy == 2 ? 1.0 : misWeight(ls.pdf, pdfB);
            L += limit(beta * f * ls.radiance * (w / ls.pdf), rough == 0 ? INF : uClamp);
          }
        }
      }

      // Continue the path by sampling the BSDF.
      vec3 wi = vec3(0.0, 0.0, 1.0);
      vec3 weight = vec3(0.0);
      bool isDelta = false;
      if (!sampleBsdf(m, wo, wi, weight, pdfBsdf, isDelta)) break;
      beta *= weight;
      rd = normalize(t * wi.x + b * wi.y + n * wi.z);
      ro = lifted;
      delta = isDelta;
      if (!delta) rough++;
    }

    float survive = maxc(beta);
    if (survive <= 0.0) break;
    // Russian roulette: end dim paths at random and boost the survivors to stay unbiased.
    if (bounce >= 3 && survive < 1.0) {
      float q = max(survive, 0.05);
      if (rnd() >= q) break;
      beta /= q;
    }
  }
  return L;
}

/* Accumulation. */

// Stochastic rounding to values a half float stores exactly. Without it, updates smaller than
// half a step would be rounded away and the running average would stall after a few hundred
// samples. The tiny upward nudge makes the result land on the same step whether the GPU
// rounds or truncates.
vec3 toHalfSteps(vec3 c) {
  vec3 e = floor(log2(max(c, vec3(6.2e-5))));
  vec3 q = exp2(e - 10.0);
  float a = rnd();
  float b = rnd();
  float d = rnd();
  return floor(c / q + vec3(a, b, d)) * q * 1.00006;
}

void main() {
  ivec2 px = ivec2(gl_FragCoord.xy);

  if (uMode == 1) {
    // Depth probe for the tests: the pinhole ray through the pixel centre.
    vec2 ndc = (vec2(px) + 0.5) / uRes * 2.0 - 1.0;
    Hit hit = Hit(INF, vec3(0.0, 1.0, 0.0), 0, 0, 0);
    bool found = closestHit(uEye, normalize(uFwd + ndc.x * uTan.x * uRight + ndc.y * uTan.y * uUp), hit);
    outColor = vec4(found ? hit.t : -1.0, float(hit.kind), float(hit.index), 1.0);
    return;
  }

  uint pixel = hashU(uint(px.x) + hashU(uint(px.y) + hashU(uint(uEpoch))));
  gRng = pixel;
  // per-pixel offsets for the low-discrepancy sequence that drives the pixel and lens positions
  uint s0 = nextU();
  uint s1 = nextU();
  uint s2 = nextU();
  uint s3 = nextU();

  vec3 sum = vec3(0.0);
  for (int s = 0; s < MAX_SPF; s++) {
    if (s >= uSpf) break;
    uint k = uint(uSampleBase + s);
    gRng = hashU(pixel + k * 2654435769u);
    // Roberts' R4 sequence in fixed point: additive recurrences with irrational steps
    vec2 jitter = vec2(unit(s0 + k * 3679390609u), unit(s1 + k * 3152041523u));
    vec2 lens = concentricDisc(vec2(unit(s2 + k * 2700274807u), unit(s3 + k * 2313257605u)));
    vec2 ndc = (vec2(px) + jitter) / uRes * 2.0 - 1.0;
    vec3 focusPoint = uEye + (uFwd + ndc.x * uTan.x * uRight + ndc.y * uTan.y * uUp) * uFocus;
    vec3 ro = uEye + uLensRadius * (lens.x * uRight + lens.y * uUp);
    vec3 L = radiance(ro, normalize(focusPoint - ro));
    if (any(isnan(L)) || any(isinf(L))) L = vec3(0.0);
    sum += clamp(L, vec3(0.0), vec3(6.0e4));
  }

  vec3 color = sum / float(max(uSpf, 1));
  if (uSampleBase > 0) {
    vec3 prev = texelFetch(uPrev, px, 0).rgb;
    color = mix(prev, color, float(uSpf) / float(uSampleBase + uSpf));
  }
  if (uHalfSteps > 0.5) color = toHalfSteps(color);
  outColor = vec4(color, 1.0);
}
`;
