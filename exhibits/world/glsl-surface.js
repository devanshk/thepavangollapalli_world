// GLSL: the planet's surface. Terrain with an analytic gradient, climate, biomes, ocean,
// lava, city lights and the cloud layer. terrain.js is the JavaScript twin of terrain()
// and of the temperature and moisture formulas; SPEC supplies the shared constants.
import { SPEC } from './terrain.js';

const f = (x) => (Number.isInteger(x) ? x.toFixed(1) : String(x));

export const GLSL_SURFACE = /* glsl */ `
const float WARP_FREQ = ${f(SPEC.warpFreq)};
const float BELT_FREQ = ${f(SPEC.beltFreq)};
const float BELT_SHARP = ${f(SPEC.beltSharp)};
const float MASK_BASE = ${f(SPEC.maskBase)};
const float LAND_LO = ${f(SPEC.landLo)};
const float LAND_HI = ${f(SPEC.landHi)};
const float RIDGE_SHARP = ${f(SPEC.ridgeSharp)};
const float RIDGE_AMP = ${f(SPEC.ridgeAmp)};
const float RIDGE_GAIN = ${f(SPEC.ridgeGain)};
const float LAPSE = ${f(SPEC.lapse)};
const float TEMP_FREQ = ${f(SPEC.tempNoiseFreq)};
const float TEMP_AMP = ${f(SPEC.tempNoiseAmp)};
const float MOIST_FREQ = ${f(SPEC.moistFreq)};
const float MOIST_AMP = ${f(SPEC.moistNoiseAmp)};
const float MOIST_BAND = ${f(SPEC.moistBand)};
const float MOIST_ALT = ${f(SPEC.moistAltitude)};
const float SEA_ICE_T = ${f(SPEC.seaIceTemp)};
const float CLOUD_ALT = 0.007;
const float CLOUD_WARP_FREQ = 1.7;
const float CLOUD_STRETCH = 1.25;

struct Terrain {
  float e;      // elevation relative to sea level
  vec3 g;       // exact gradient of e with respect to position
  float ridge;  // how much of e is mountain
};

// Domain-warped continents plus ridged mountains along belts. The gradient is carried
// through every step by the chain rule, so relief lighting needs no extra samples.
Terrain terrain(vec3 p, float octs, float octsR) {
  vec3 wq = p * WARP_FREQ;
  vec4 w1 = noised(wq, layerSeed(L_WARP1));
  vec4 w2 = noised(wq, layerSeed(L_WARP2));
  vec4 w3 = noised(wq, layerSeed(L_WARP3));
  vec3 q = p * uContFreq + uWarp * vec3(w1.x, w2.x, w3.x);
  vec4 c = fbmd(q, layerSeed(L_CONTINENT), octs, uGain);
  Terrain t;
  t.e = c.x - uSea;
  t.g = uContFreq * c.yzw + (uWarp * WARP_FREQ) * (w1.yzw * c.y + w2.yzw * c.z + w3.yzw * c.w);
  t.ridge = 0.0;
  float s = clamp((t.e - LAND_LO) / (LAND_HI - LAND_LO), 0.0, 1.0);
  if (s > 0.0) {
    float land = s * s * (3.0 - 2.0 * s);
    vec3 dland = (6.0 * s * (1.0 - s) / (LAND_HI - LAND_LO)) * t.g;
    vec4 bn = noised(p * BELT_FREQ, layerSeed(L_BELT));
    float br = max(1.0 - BELT_SHARP * abs(bn.x), 0.0);
    float belt = MASK_BASE + (1.0 - MASK_BASE) * br * br;
    vec3 dbelt = (-2.0 * (1.0 - MASK_BASE) * br * BELT_SHARP * BELT_FREQ * sign(bn.x)) * bn.yzw;
    vec4 r = ridged(p * uMtnFreq, layerSeed(L_RIDGE), octsR, RIDGE_SHARP, RIDGE_AMP, RIDGE_GAIN);
    float mask = belt * land;
    t.ridge = mask * r.x;
    t.e += uMtnAmp * t.ridge;
    t.g += uMtnAmp * (r.x * (dbelt * land + belt * dland) + mask * uMtnFreq * r.yzw);
  }
  return t;
}

// How many octaves of a layer with base frequency f0 a pixel covering fp of the surface
// can resolve (finest cell at least two pixels wide), less a penalty while moving.
float octavesFor(float f0, float fp, float cap) {
  return clamp(log2(0.5 / (fp * f0)) / log2(LAC) + 1.0 - uLodBias, 1.5, cap);
}

// Cloud lookups drift about the spin axis and are advected along the contours of a slow
// pressure field, which wraps fronts around highs and lows.
vec3 cloudFrame(vec3 p) {
  float ca = cos(uCloudTime.x);
  float sa = sin(uCloudTime.x);
  return vec3(ca * p.x - sa * p.z, p.y, sa * p.x + ca * p.z);
}

vec3 cloudCoord(vec3 pc, out float pressure) {
  vec4 w = noised(pc * CLOUD_WARP_FREQ + vec3(0.0, uCloudTime.y, 0.0), layerSeed(L_CLOUD_WARP));
  pressure = w.x;
  vec3 q = pc + uCloud.z * cross(pc, w.yzw);
  q.y *= CLOUD_STRETCH;
  return q * uCloud.y + vec3(uCloudTime.y * 0.6, 0.0, 0.0);
}

float cloudAmount(float shape, float pressure, float lat) {
  float bands = 0.1 * cos(lat * 9.4) - 0.1 * smoothstep(0.75, 1.0, lat);
  return smoothstep(0.0, 0.3, shape * 0.8 - pressure * 0.75 + bands + (uCloud.x - 0.5) * 1.25 - 0.08);
}

// Cloud shape: three coarse octaves ride the advected coordinates and make the weather
// systems; the finer ones use plain coordinates so small-scale texture stays crisp.
const float CLOUD_FINE = 7.3;
const float CLOUD_FINE_AMP = 0.24;

// Cloud cover (x) and the gradient of its shape in the cloud frame (yzw), for self-shadowing.
vec4 cloudLayer(vec3 pc, float octs) {
  float pressure = 0.0;
  vec3 q = cloudCoord(pc, pressure);
  vec4 c = fbmd(q, layerSeed(L_CLOUD), min(octs, 3.0), 0.6);
  if (octs > 3.0) c += vec4(CLOUD_FINE_AMP, vec3(CLOUD_FINE_AMP * CLOUD_FINE)) * fbmd(pc * (uCloud.y * CLOUD_FINE), layerSeed(L_CLOUD) + 1u, octs - 3.0, 0.62);
  return vec4(cloudAmount(c.x, pressure, abs(pc.y)), c.yzw * uCloud.y);
}

float cloudCover(vec3 pc, float octs) {
  float pressure = 0.0;
  vec3 q = cloudCoord(pc, pressure);
  float c = fbm(q, layerSeed(L_CLOUD), min(octs, 3.0), 0.6);
  if (octs > 3.0) c += CLOUD_FINE_AMP * fbm(pc * (uCloud.y * CLOUD_FINE), layerSeed(L_CLOUD) + 1u, octs - 3.0, 0.62);
  return cloudAmount(c, pressure, abs(pc.y));
}

// Settlements: threads of light along low, mild, watered land with towns strung on them,
// densest near the coast. Detail finer than a pixel is replaced by its average.
float cityLights(vec3 p, float e, float temp, float moist, float fp) {
  float habitable = smoothstep(0.0, 0.01, e) * smoothstep(0.45, 0.03, e) * smoothstep(0.03, 0.22, temp) * smoothstep(0.12, 0.34, moist);
  if (habitable <= 0.0) return 0.0;
  uint s = layerSeed(L_CITY);
  float region = smoothstep(0.0, 0.34, noise(p * 3.6, s) + 0.22 * exp(-e * 9.0));
  float web = max(1.0 - abs(noise(p * 24.0, s + 1u)) * 5.0, 0.0);
  web *= web;
  float towns = smoothstep(0.18, 0.4, noise(p * 58.0, s + 2u) + 0.22 * web);
  float townDetail = clamp(0.6 / (fp * 58.0) - 0.4, 0.0, 1.0);
  float grainDetail = clamp(0.6 / (fp * 170.0) - 0.4, 0.0, 1.0);
  float grain = mix(1.0, 2.4 * smoothstep(0.08, 0.38, noise(p * 170.0, s + 3u)), grainDetail);
  return habitable * region * (0.22 * web + mix(0.16, 1.6 * towns, townDetail)) * grain;
}

// Glow of molten rock for heat in [0, 1]: dull red through orange to yellow-white.
vec3 lavaGlow(float heat) {
  return uLavaGlow * heat * vec3(1.0, 0.1 + 0.36 * heat, 0.012 + 0.1 * heat * heat);
}

vec3 biomeColor(float temp, float moist, float elev, float steep, float beach) {
  vec3 cold = mix(uPal[7], uPal[8], smoothstep(0.38, 0.62, moist));
  vec3 mild = mix(uPal[5], uPal[6], smoothstep(0.34, 0.58, moist));
  vec3 hot = mix(uPal[3], uPal[4], smoothstep(0.42, 0.68, moist));
  vec3 c = mix(cold, mild, smoothstep(0.1, 0.34, temp));
  c = mix(c, hot, smoothstep(0.52, 0.8, temp));
  c = mix(c, uPal[2], beach * smoothstep(0.12, 0.4, temp));
  c = mix(c, uPal[9], smoothstep(0.26, 0.72, elev * 0.9 + steep * 0.45));
  return c;
}

// Colour of the planet at view-space point pv seen along rd from distance t.
vec3 shadeSurface(vec3 pv, vec3 rd, float t) {
  vec3 p = pv * uRot;
  vec3 L = uSun * uRot;
  vec3 V = -rd * uRot;
  float mu = max(dot(p, V), 0.0);
  float muS = dot(p, L);
  float fp = t * uPix / sqrt(max(mu, 0.05));
  float octs = uFixedOcts.x > 0.0 ? uFixedOcts.x : octavesFor(uContFreq, fp, 9.0);
  float octsR = uFixedOcts.y > 0.0 ? uFixedOcts.y : octavesFor(uMtnFreq, fp, 6.0);
  Terrain tr = terrain(p, octs, octsR);

  vec3 slope = tr.g - p * dot(p, tr.g);
  float steep = length(slope) * uBump;
  float edge = max(length(slope) * fp, 1e-5);
  float land = smoothstep(-edge, edge, tr.e);

  float lat = abs(p.y);
  float elev = max(tr.e, 0.0);
  float tempNoise = noise(p * TEMP_FREQ, layerSeed(L_TEMP));
  float tempSea = uTempBase - uTempLat * lat * lat + TEMP_AMP * tempNoise;
  float temp = tempSea - LAPSE * elev;
  float daylight = smoothstep(-0.25, 0.2, muS);
  bool lit = muS > -0.3;

  // clouds: the layer floats above the ground, so the view ray and the sun's ray each
  // cross it somewhere other than straight overhead
  float cloud = 0.0;
  vec3 cloudCol = vec3(0.0);
  float shadow = lit ? ringShadow(pv) : 1.0;
  if (uCloud.x > 0.0) {
    float octsC = octavesFor(uCloud.y, fp, 7.0);
    float shell = CLOUD_ALT * (2.0 + CLOUD_ALT);
    vec3 pc = cloudFrame(normalize(p + V * (-mu + sqrt(mu * mu + shell))));
    vec3 Lc = cloudFrame(L);
    if (lit) {
      vec4 cl = cloudLayer(pc, octsC);
      cloud = cl.x;
      float cmu = dot(pc, Lc);
      // denser cloud toward the sun means this spot sits in its shade
      vec3 Lt = Lc - pc * cmu;
      float shade = clamp(1.0 - 0.04 * dot(cl.yzw, Lt), 0.3, 1.2);
      vec3 cloudSun = sunTransmit(CLOUD_ALT * uX, cmu) * clamp(cmu * 0.8 + 0.2, 0.0, 1.0);
      cloudCol = uCloudColor * (0.72 + 0.28 * cloud) * (cloudSun * shade * shadow + uSkyLight * daylight * 1.3);
      if (muS > 0.0) {
        vec3 ps = cloudFrame(normalize(p + L * (-muS + sqrt(muS * muS + shell))));
        shadow *= 1.0 - 0.7 * cloudCover(ps, octsC - 1.0);
      }
    } else cloud = cloudCover(pc, octsC - 1.0);
  }

  vec3 sun = sunTransmit(0.0, muS) * shadow;
  vec3 ambient = uSkyLight * daylight + vec3(0.0012, 0.0015, 0.002);
  vec3 col = vec3(0.0);

  float moist = 0.0;
  if (land > 0.0) {
    float moistNoise = fbm(p * MOIST_FREQ, layerSeed(L_MOIST), 2.0, 0.5);
    moist = uMoistBase + MOIST_BAND * cos(6.6 * lat) + MOIST_AMP * moistNoise - MOIST_ALT * elev;
    float beach = 1.0 - smoothstep(0.0, 0.014 + edge, tr.e);
    vec3 albedo = biomeColor(temp, moist, elev, steep, beach);
    albedo *= 0.88 + 0.5 * tr.ridge;
    float snow = smoothstep(0.035, -0.035, temp + 0.07 * moistNoise + 0.1 * steep);
    albedo = mix(albedo, uPal[10], snow);
    vec3 N = normalize(p - uBump * slope);
    // relief may catch low sun, but not light the sphere itself is hiding
    float diffuse = max(dot(N, L), 0.0) * smoothstep(-0.1, 0.08, muS);
    col = albedo * (sun * diffuse + ambient);
    if (uLava > 0.5) {
      // the shore glows, and fissures open across low ground in some regions
      uint s = layerSeed(L_LAVA);
      float fissure = max(1.0 - abs(noise(p * 15.0, s + 5u)) * 13.0, 0.0);
      fissure *= fissure * smoothstep(0.32, 0.04, tr.e) * smoothstep(0.0, 0.22, noise(p * 2.6, s + 6u));
      col += lavaGlow(min(0.55 * smoothstep(0.09, 0.0, tr.e) + 0.8 * fissure, 1.0)) * (1.0 - snow);
    }
  }

  if (land < 1.0) {
    float depth = max(-tr.e, 0.0);
    vec3 sea = vec3(0.0);
    if (uLava > 0.5) {
      // a lava sea: dark crust broken into plates, molten where the crust thins and near shore
      uint s = layerSeed(L_LAVA);
      float crust = 0.6 * noise(p * 8.0, s) + 0.3 * noise(p * 21.0, s + 1u) + 0.14 * noise(p * 55.0, s + 2u);
      float shore = exp(-depth * 7.0);
      float seam = max(1.0 - abs(crust) * 9.0, 0.0);
      float heat = clamp(0.62 * smoothstep(-0.02, -0.3, crust - 0.3 * shore) + 0.5 * seam * seam + 0.2 * shore, 0.0, 1.0);
      sea = uPal[0] * (sun * max(muS, 0.0) + ambient) + lavaGlow(heat);
    } else {
      vec3 water = mix(uPal[0], uPal[1], exp(-depth * 10.0));
      float fresnel = 0.02 + 0.98 * pow(1.0 - mu, 5.0);
      vec3 H = L + V;
      H /= max(length(H), 1e-4);
      float nh = max(dot(p, H), 0.0);
      float rough = 0.18 + 0.1 * tempNoise;
      float a2 = rough * rough * rough * rough;
      float dn = nh * nh * (a2 - 1.0) + 1.0;
      float glint = a2 / (PI * dn * dn) * (0.02 + 0.98 * pow(1.0 - max(dot(V, H), 0.0), 5.0)) * 0.25;
      sea = water * (sun * max(muS, 0.0) + ambient) * (1.0 - fresnel)
        + sun * glint * smoothstep(0.0, 0.1, muS)
        + uSkyLight * daylight * min(fresnel, 0.35) * 2.0;
      float ice = smoothstep(SEA_ICE_T + 0.025, SEA_ICE_T - 0.025, tempSea + 0.05 * noise(p * 21.0, layerSeed(L_TEMP) + 3u));
      sea = mix(sea, uPal[11] * (sun * max(muS, 0.0) + ambient), ice);
    }
    col = mix(sea, col, land);
  }

  if (uLights > 0.0 && muS < 0.1 && land > 0.0) {
    float night = smoothstep(0.08, -0.12, muS);
    col += vec3(1.0, 0.72, 0.38) * (2.2 * uLights * night * land * cityLights(p, tr.e, temp, moist, fp)) * (1.0 - 0.85 * cloud);
  }
  return mix(col, cloudCol, cloud * 0.97);
}
`;
