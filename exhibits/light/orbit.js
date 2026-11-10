// Damped orbit state. Pointer input moves a goal pose; the rendered pose eases toward it with an
// exponential time constant, which smooths jitter while dragging and glides briefly on release.
import { clamp } from '../../assets/js/kit.js';

const SETTLED = 2e-4;

/**
 * createOrbit({ yaw, pitch, distance }, { pitch: [lo, hi], distance: [lo, hi], yaw?: [lo, hi] }, smoothing)
 * smoothing is the time constant in seconds; 0 follows the goal instantly.
 */
export function createOrbit(pose, limits, smoothing = 0.09) {
  const goal = { yaw: pose.yaw, pitch: pose.pitch, distance: pose.distance };
  const now = { ...goal };
  let bounds = limits;

  const constrain = () => {
    goal.pitch = clamp(goal.pitch, bounds.pitch[0], bounds.pitch[1]);
    goal.distance = clamp(goal.distance, bounds.distance[0], bounds.distance[1]);
    if (bounds.yaw) goal.yaw = clamp(goal.yaw, bounds.yaw[0], bounds.yaw[1]);
  };
  constrain();
  Object.assign(now, goal);

  return {
    /** Current (eased) pose. */
    get pose() {
      return now;
    },
    rotate(dYaw, dPitch) {
      goal.yaw += dYaw;
      goal.pitch += dPitch;
      constrain();
    },
    /** factor > 1 moves the camera closer. */
    zoom(factor) {
      goal.distance /= factor;
      constrain();
    },
    /** Jump to a new pose and limits without easing. */
    reset(nextPose, nextLimits) {
      bounds = nextLimits;
      Object.assign(goal, { yaw: nextPose.yaw, pitch: nextPose.pitch, distance: nextPose.distance });
      constrain();
      Object.assign(now, goal);
    },
    /** Advance by dt seconds. Returns true while the pose is still changing. */
    step(dt) {
      const k = smoothing > 0 ? 1 - Math.exp(-dt / smoothing) : 1;
      const gap =
        Math.abs(goal.yaw - now.yaw) + Math.abs(goal.pitch - now.pitch) + Math.abs(goal.distance / now.distance - 1);
      if (gap === 0) return false;
      if (gap < SETTLED || k >= 1) {
        Object.assign(now, goal);
        return true;
      }
      now.yaw += (goal.yaw - now.yaw) * k;
      now.pitch += (goal.pitch - now.pitch) * k;
      now.distance += (goal.distance - now.distance) * k;
      return true;
    },
  };
}
