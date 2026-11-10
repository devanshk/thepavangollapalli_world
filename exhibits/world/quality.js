// Adaptive resolution. The browser only reports when frames arrive, not how long the GPU
// worked, so the controller watches the interval between frames: if frames are late it
// renders fewer pixels at once; if they have been on time for a while it probes upward,
// and backs off for longer each time a probe turns out to be too much.

const WINDOW = 9;
const SLOW_MS = 24; // a missed frame at 60 Hz
const FAST_MS = 19;
const TARGET_MS = 14;

/**
 * createQuality({ min, max }) → { scale, sample(intervalMs, nowMs), fps }
 * sample() returns true when `scale` changed; the caller then resizes the canvas.
 */
export function createQuality({ min = 0.4, max = 1, initial = max } = {}) {
  const recent = new Float32Array(WINDOW);
  const sorted = new Float32Array(WINDOW);
  let count = 0;
  let skip = 2;
  let scale = initial;
  let lastChange = -Infinity;
  let lastRaise = -Infinity;
  let raiseAfter = 2500;
  let median = 0;

  function change(next, now) {
    scale = next;
    lastChange = now;
    count = 0;
    skip = 2; // the first frames at a new size include the resize itself
  }

  return {
    get scale() {
      return scale;
    },
    /** Frames per second over the recent window, or 0 before there is enough data. */
    get fps() {
      return median > 0 ? 1000 / median : 0;
    },
    /** Median frame interval in ms at the current scale (0 until measured). */
    get interval() {
      return median;
    },
    /** Forget recent timings, e.g. after a pause, so stale gaps are not read as slow frames. */
    rest() {
      count = 0;
      skip = 2;
    },
    sample(intervalMs, now) {
      if (skip > 0) {
        skip--;
        return false;
      }
      recent[count % WINDOW] = Math.min(intervalMs, 400);
      count++;
      if (count < WINDOW) return false;
      sorted.set(recent);
      sorted.sort();
      median = sorted[WINDOW >> 1];
      if (median > SLOW_MS && scale > min) {
        // pixel count goes with the square of the scale
        const factor = Math.min(Math.max(Math.sqrt(TARGET_MS / median), 0.55), 0.9);
        if (now - lastRaise < 4000) raiseAfter = Math.min(raiseAfter * 2, 60000);
        change(Math.max(min, scale * factor), now);
        return true;
      }
      if (median < FAST_MS && scale < max && now - lastChange > raiseAfter) {
        lastRaise = now;
        change(Math.min(max, scale * 1.15), now);
        return true;
      }
      return false;
    },
  };
}
