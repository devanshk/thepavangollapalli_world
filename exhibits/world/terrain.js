// The planet's terrain and climate as plain functions of a point on the unit sphere.
// glsl-surface.js implements the same formulas with analytic gradients; SPEC is injected
// into that shader so the constants cannot drift apart.
import { noise3, fbm3, ridged3, layerSeed } from './noise.js';

export const SPEC = {
  warpFreq: 1.15,
  // mountain belts: thin lines where a low-frequency noise crosses zero
  beltFreq: 1.9,
  beltSharp: 2.4,
  maskBase: 0.2,
  // mountains fade in from just offshore to the interior
  landLo: -0.03,
  landHi: 0.24,
  ridgeSharp: 1.7,
  ridgeAmp: 0.62,
  ridgeGain: 0.5,
  // climate
  lapse: 0.55,
  tempNoiseFreq: 2.7,
  tempNoiseAmp: 0.14,
  moistFreq: 2.1,
  moistNoiseAmp: 0.85,
  moistBand: 0.2,
  moistAltitude: 0.35,
  seaIceTemp: -0.06,
  // octave counts used for measurement (the shader picks its own from pixel size)
  surveyOctaves: 6,
  surveyRidgeOctaves: 4,
  layers: { warp1: 1, warp2: 2, warp3: 3, continent: 4, belt: 5, ridge: 6, temp: 7, moist: 8, cloud: 9, cloudWarp: 10, city: 11, ring: 12, lava: 13, stars: 14 },
};

/** One terrain unit of height is reported as this many kilometres on the data card. */
export const KM_PER_UNIT = 7;

const smooth01 = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));

/**
 * createTerrain(params) → sampling functions for one planet. `params` needs
 * { hash, contFreq, warp, gain, mtnAmp, mtnFreq, tempBase, tempLat, moistBase }.
 */
export function createTerrain(params) {
  const { hash, contFreq, warp, gain, mtnAmp, mtnFreq, tempBase, tempLat, moistBase } = params;
  const L = SPEC.layers;
  const sW1 = layerSeed(hash, L.warp1);
  const sW2 = layerSeed(hash, L.warp2);
  const sW3 = layerSeed(hash, L.warp3);
  const sCont = layerSeed(hash, L.continent);
  const sBelt = layerSeed(hash, L.belt);
  const sRidge = layerSeed(hash, L.ridge);
  const sTemp = layerSeed(hash, L.temp);
  const sMoist = layerSeed(hash, L.moist);

  /** Domain-warped fbm: the large-scale shape of land and sea, roughly in [-1, 1]. */
  function continent(x, y, z, octaves = SPEC.surveyOctaves) {
    const wx = x * SPEC.warpFreq;
    const wy = y * SPEC.warpFreq;
    const wz = z * SPEC.warpFreq;
    return fbm3(
      x * contFreq + warp * noise3(wx, wy, wz, sW1),
      y * contFreq + warp * noise3(wx, wy, wz, sW2),
      z * contFreq + warp * noise3(wx, wy, wz, sW3),
      sCont,
      octaves,
      gain,
    );
  }

  /** Elevation relative to sea level (positive is land), mountains included. */
  function elevation(x, y, z, sea, octaves = SPEC.surveyOctaves, ridgeOctaves = SPEC.surveyRidgeOctaves) {
    const e0 = continent(x, y, z, octaves) - sea;
    const land = smooth01((e0 - SPEC.landLo) / (SPEC.landHi - SPEC.landLo));
    if (land <= 0) return e0;
    const bn = noise3(x * SPEC.beltFreq, y * SPEC.beltFreq, z * SPEC.beltFreq, sBelt);
    const br = Math.max(1 - SPEC.beltSharp * Math.abs(bn), 0);
    const mask = (SPEC.maskBase + (1 - SPEC.maskBase) * br * br) * land;
    const r = ridged3(x * mtnFreq, y * mtnFreq, z * mtnFreq, sRidge, ridgeOctaves, SPEC.ridgeSharp, SPEC.ridgeAmp, SPEC.ridgeGain);
    return e0 + mtnAmp * mask * r;
  }

  /** Temperature: warm equator, cold poles, colder with altitude. Below zero is frozen. */
  function temperature(x, y, z, elev) {
    const n = noise3(x * SPEC.tempNoiseFreq, y * SPEC.tempNoiseFreq, z * SPEC.tempNoiseFreq, sTemp);
    return tempBase - tempLat * y * y - SPEC.lapse * Math.max(elev, 0) + SPEC.tempNoiseAmp * n;
  }

  /** Moisture: wet equator and mid-latitudes, dry subtropics, drier with altitude. */
  function moisture(x, y, z, elev) {
    const f = SPEC.moistFreq;
    const n = fbm3(x * f, y * f, z * f, sMoist, 2, 0.5);
    return moistBase + SPEC.moistBand * Math.cos(6.6 * Math.abs(y)) + SPEC.moistNoiseAmp * n - SPEC.moistAltitude * Math.max(elev, 0);
  }

  return { continent, elevation, temperature, moisture };
}

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

/** i-th of n points spread evenly over the unit sphere (Fibonacci spiral), written to out[0..2]. */
export function spherePoint(i, n, phase, out) {
  const y = 1 - (2 * (i + 0.5)) / n;
  const r = Math.sqrt(Math.max(1 - y * y, 0));
  const a = i * GOLDEN_ANGLE + phase;
  out[0] = r * Math.cos(a);
  out[1] = y;
  out[2] = r * Math.sin(a);
  return out;
}

/**
 * Pick the sea level that floods `oceanTarget` of the continent field: the matching
 * quantile of n evenly spread samples. Every seed then gets a curated share of ocean.
 */
export function solveSeaLevel(terrain, oceanTarget, n = 1200) {
  const values = new Float64Array(n);
  const p = [0, 0, 0];
  for (let i = 0; i < n; i++) {
    spherePoint(i, n, 0, p);
    values[i] = terrain.continent(p[0], p[1], p[2], 5);
  }
  values.sort();
  const k = Math.min(Math.max(oceanTarget, 0), 1) * (n - 1);
  const lo = Math.floor(k);
  const hi = Math.min(lo + 1, n - 1);
  return values[lo] + (values[hi] - values[lo]) * (k - lo);
}

/**
 * Survey the finished terrain at n points (a different set from solveSeaLevel's).
 * Returns a job to run in slices so the main thread never stalls:
 *   const job = createSurvey(terrain, sea, 12000);
 *   while (!job.step(6)) await nextTask();   // step(ms budget) → true when finished
 *   job.result() → { samples, ocean, seaIce, frozen, peak, deepest, land: { wet, open, dry } }
 * Fractions are of the whole surface: ocean is everything below sea level (sea ice included),
 * frozen is sea ice plus frozen land, and land.* splits the unfrozen land by moisture.
 * peak and deepest are in terrain units.
 */
export function createSurvey(terrain, sea, n = 12000) {
  const p = [0, 0, 0];
  let i = 0;
  let ocean = 0;
  let seaIce = 0;
  let landIce = 0;
  let wet = 0;
  let dry = 0;
  let open = 0;
  let peak = -Infinity;
  let deepest = Infinity;
  const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

  function sample() {
    spherePoint(i, n, 1.7, p);
    const e = terrain.elevation(p[0], p[1], p[2], sea);
    const t = terrain.temperature(p[0], p[1], p[2], e);
    if (e > peak) peak = e;
    if (e < deepest) deepest = e;
    if (e <= 0) {
      ocean++;
      if (t < SPEC.seaIceTemp) seaIce++;
    } else if (t < 0) landIce++;
    else {
      const m = terrain.moisture(p[0], p[1], p[2], e);
      if (m > 0.55) wet++;
      else if (m < 0.32) dry++;
      else open++;
    }
    i++;
  }

  return {
    get done() {
      return i >= n;
    },
    step(budgetMs = 6) {
      const t0 = now();
      while (i < n) {
        for (let k = 0; k < 64 && i < n; k++) sample();
        if (now() - t0 >= budgetMs) break;
      }
      return i >= n;
    },
    result() {
      const total = Math.max(i, 1);
      return {
        samples: i,
        ocean: ocean / total,
        seaIce: seaIce / total,
        frozen: (seaIce + landIce) / total,
        peak: Math.max(peak, 0),
        deepest: Math.max(-deepest, 0),
        land: { wet: wet / total, open: open / total, dry: dry / total },
      };
    },
  };
}
