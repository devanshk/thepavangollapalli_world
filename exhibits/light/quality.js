// Adaptive quality. The controller keeps one number, `budget`: how many pixel-samples (pixels
// traced × samples per pixel) the GPU manages inside one frame. It is seeded by a timed probe at
// mount and then corrected from measured frame times. Resolution and samples-per-frame are both
// derived from it, so a slow phone renders fewer, larger pixels and a fast laptop several samples
// per frame at full resolution.

export const SCALES = [0.25, 0.3, 0.35, 0.42, 0.5, 0.6, 0.7, 0.85, 1];
const TARGET_MS = 13;
const FAST_MS = 20;
const SLOW_MS = 30;
const MOVING_SPF = 2;
// Below these pixel counts the picture is too coarse to be worth the smoother frame rate.
const MIN_STILL_PIXELS = 1.2e5;
const MIN_MOVING_PIXELS = 4e4;

const median3 = (a, b, c) => Math.max(Math.min(a, b), Math.min(Math.max(a, b), c));

/**
 * createQuality({ maxPixels, maxSpf }) → controller
 *   calibrate(msPerPixelSample)        seed the budget from a timed render
 *   feedback(frameMs, work)            report the time the last frame took and its pixel-samples
 *   plan(fullW, fullH)                 → { still: { w, h }, moving: { w, h, spf } }
 *   spf(w, h)                          samples per frame affordable at that resolution
 */
export function createQuality({ maxPixels = 1.4e6, maxSpf = 4 } = {}) {
  const minBudget = 2e4;
  const maxBudget = maxPixels * maxSpf;
  let budget = 2.5e5;
  let ceiling = Infinity;
  const recent = [TARGET_MS, TARGET_MS, TARGET_MS];
  let cursor = 0;

  const clampBudget = () => {
    budget = Math.min(maxBudget, Math.max(minBudget, budget));
  };

  /** Largest scale whose pixel count fits `pixels`, between a floor of `minPixels` and `maxScale`. */
  const fit = (fullW, fullH, pixels, minPixels, maxScale) => {
    const full = fullW * fullH;
    const top = Math.min(maxScale, 1, Math.sqrt(maxPixels / full));
    let scale = Math.min(top, Math.sqrt(minPixels / full));
    for (const s of SCALES) if (s <= top && s > scale && full * s * s <= pixels) scale = s;
    return { scale, w: Math.max(1, Math.round(fullW * scale)), h: Math.max(1, Math.round(fullH * scale)) };
  };

  return {
    get budget() {
      return budget;
    },
    calibrate(msPerPixelSample) {
      budget = TARGET_MS / msPerPixelSample;
      ceiling = Infinity;
      clampBudget();
    },
    feedback(frameMs, work) {
      recent[cursor] = frameMs;
      cursor = (cursor + 1) % 3;
      const ms = median3(recent[0], recent[1], recent[2]);
      if (ms > SLOW_MS && work > 0.5 * budget) {
        ceiling = budget * 0.9;
        budget *= Math.max(0.6, TARGET_MS / ms);
      } else if (ms < FAST_MS && work > 0.8 * budget) {
        // climb quickly back to the last level that held, then probe above it slowly
        budget *= budget < ceiling ? 1.05 : 1.002;
      }
      clampBudget();
    },
    plan(fullW, fullH) {
      const still = fit(fullW, fullH, budget, MIN_STILL_PIXELS, 1);
      const moving = fit(fullW, fullH, (budget * 0.85) / MOVING_SPF, MIN_MOVING_PIXELS, still.scale);
      const spf = Math.min(MOVING_SPF, Math.max(1, Math.floor((budget * 0.85) / (moving.w * moving.h))));
      return { still, moving: { ...moving, spf } };
    },
    spf(w, h) {
      return Math.min(maxSpf, Math.max(1, Math.floor(budget / (w * h))));
    },
  };
}
