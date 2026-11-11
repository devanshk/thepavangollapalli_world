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
      if (average > 1 / 42) {
        slow += dt;
        fast = 0;
      } else if (average < 1 / 55) {
        fast += dt;
        slow = 0;
      } else {
        slow = 0;
        fast = 0;
      }
      if (slow > 1 && level > 0) {
        level--;
        slow = 0;
        average = 1 / 50;
        holdUntil = clock + hold;
        hold = Math.min(hold * 2, 300);
      } else if (fast > 3 && level < top && clock >= holdUntil) {
        level++;
        fast = 0;
      }
      return level;
    },
  };
}
