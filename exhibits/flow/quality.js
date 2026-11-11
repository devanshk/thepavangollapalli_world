// quality.js — how fine a grid to run, decided from measured time. Pure, so it is testable.

/** Resolution ladder: cell budget and pressure sweeps (one sweep = a red and a black pass). */
export const LEVELS = [
  { cells: 16000, sweeps: 10 },
  { cells: 25600, sweeps: 12 },
  { cells: 36864, sweeps: 14 },
  { cells: 57600, sweeps: 16 },
  { cells: 92160, sweeps: 18 },
  { cells: 147456, sweeps: 20 },
];

/** Grid of square cells with the view's aspect ratio: 16:9 gives 256 × 144 up to 512 × 288. */
export function gridFor(level, aspect) {
  const a = Math.min(Math.max(aspect, 0.5), 2.5);
  const n = Math.round(Math.sqrt(LEVELS[level].cells * a));
  return { n, m: Math.max(8, Math.round(n / a)) };
}

/** Starting level from the measured cost of one 256 × 144 step, in milliseconds. */
export function levelForStepTime(ms, small) {
  const top = small ? 3 : LEVELS.length - 1;
  const level = ms < 1.5 ? 5 : ms < 2.5 ? 4 : ms < 5 ? 3 : ms < 9 ? 2 : ms < 14 ? 1 : 0;
  return Math.min(level, top);
}

/**
 * Follows the frame time while running. A second of slow frames drops one level and holds it
 * there for a while (longer after every drop); three seconds of fast frames raise it again.
 */
export function createGovernor(start, top = LEVELS.length - 1) {
  let level = Math.min(start, top);
  let average = 1 / 60;
  let slow = 0;
  let fast = 0;
  let clock = 0;
  let holdUntil = 0;
  let hold = 20;
  // The display can impose its own pace (30 Hz in Low Power Mode or in a frame not yet touched).
  // Two drops in a row that did not shorten the frame reveal it: go back up and judge "slow"
  // against that pace from then on.
  let pace = 0;
  let dropFrom = 0;
  let dropAt = 0;
  let wasted = 0;
  return {
    get level() {
      return level;
    },
    /** elapsed: seconds since the previous frame. Returns the level to use now. */
    sample(elapsed) {
      // One long stall, such as a tab switch, is capped: alone it never adds up to a slow second.
      const dt = Math.min(elapsed, 0.25);
      clock += dt;
      average += (dt - average) * 0.1;
      if (pace && average < pace * 0.75) pace = 0;
      if (average > Math.max(1 / 42, pace * 1.3)) {
        slow += dt;
        fast = 0;
      } else if (average < Math.max(1 / 55, pace * 1.12)) {
        fast += dt;
        slow = 0;
      } else {
        slow = 0;
        fast = 0;
      }
      if (slow > 1) {
        const helped = !dropFrom || clock - dropAt > 3 || average < dropFrom * 0.85;
        wasted = helped ? 0 : wasted + 1;
        if (wasted >= 2) {
          pace = average;
          level = Math.min(level + 2, top);
          wasted = 0;
          dropFrom = 0;
          slow = 0;
          holdUntil = 0;
          hold = 20;
        } else if (level > 0) {
          dropFrom = average;
          dropAt = clock;
          level--;
          slow = 0;
          average = Math.max(1 / 50, pace);
          holdUntil = clock + hold;
          hold = Math.min(hold * 2, 300);
        }
      } else if (fast > 3 && level < top && clock >= holdUntil) {
        level++;
        fast = 0;
      }
      return level;
    },
  };
}
