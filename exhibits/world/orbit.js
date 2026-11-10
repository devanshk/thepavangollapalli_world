// The interactive view state: the planet's orientation (a trackball with inertia and a slow
// spin about its own axis) and the zoom. Pure logic, driven by index.js.
import { quatMul, quatNormalize, quatFromAxisAngle, quatBetween, quatToMat3, pickSphere } from './rotation.js';
import { initialOrientation, zoomDistance, zoomRange } from './camera.js';

const SPIN_RATE = 0.05; // rad/s, one turn in about two minutes
const INERTIA_DECAY = 0.85; // seconds for a flick to lose 63% of its speed
const MAX_FLICK = 7; // rad/s
/** At full zoom the planet's centre slides this far below the canvas centre, so the limb stays in view. */
const NEAR_SHIFT = 1.32;

export function createOrbit(tanFov) {
  const q = [0, 0, 0, 1];
  const step = [0, 0, 0, 1];
  const from = [0, 0, 1];
  const to = [0, 0, 1];
  const omega = [0, 0, 0];
  const rot = new Float32Array(9);
  const shift = [0, 0];
  let grabbed = false;
  let lastMoveAt = 0;
  let zoom = 0;
  let zoomTarget = 0;
  let fit = 0.66;
  let spinBlend = 1;

  const camDist = () => zoomDistance(zoom, fit, tanFov);
  const refresh = () => {
    quatNormalize(q, q);
    quatToMat3(rot, q);
    const z = zoom * zoom * (3 - 2 * zoom);
    shift[1] = -NEAR_SHIFT * z;
  };
  const pick = (out, u, v) => pickSphere(out, u - shift[0], v - shift[1], camDist(), tanFov);

  function rotateBy(x, y, z, angle) {
    quatFromAxisAngle(step, x, y, z, angle);
    quatMul(q, step, q);
  }

  refresh();
  return {
    /** planet → view rotation, column-major, kept current by every method */
    rot,
    q,
    /** screen position of the planet's centre, in half-canvas units */
    shift,
    get camDist() {
      return camDist();
    },
    get grabbed() {
      return grabbed;
    },
    get zoom() {
      return zoom;
    },
    get zoomTarget() {
      return zoomTarget;
    },
    set zoomTarget(z) {
      zoomTarget = Math.min(Math.max(z, 0), 1);
    },
    /** Multiply the on-screen size by `factor` (pinch). */
    zoomBy(factor) {
      if (!(factor > 0)) return;
      zoomTarget = Math.min(Math.max(zoomTarget + Math.log(factor) / zoomRange(fit), 0), 1);
    },
    setFit(radius) {
      fit = radius;
    },
    /** Face a new planet: its own tilt and longitude, no leftover motion. */
    reset(tiltDeg, longitude) {
      initialOrientation(q, tiltDeg, longitude);
      omega[0] = omega[1] = omega[2] = 0;
      grabbed = false;
      spinBlend = 1;
      refresh();
    },
    /** Pointer down at screen position (u, v), in half-canvas units with v up. */
    grab(u, v, timeMs) {
      grabbed = true;
      lastMoveAt = timeMs;
      omega[0] = omega[1] = omega[2] = 0;
      pick(from, u, v);
    },
    /** Pointer moved: turn the planet so the grabbed point stays under the pointer. */
    drag(u, v, timeMs) {
      if (!grabbed) return;
      pick(to, u, v);
      quatBetween(step, from, to);
      quatMul(q, step, q);
      const dt = Math.max((timeMs - lastMoveAt) / 1000, 0.004);
      const s = Math.hypot(step[0], step[1], step[2]);
      if (s > 1e-9) {
        const rate = (2 * Math.atan2(s, step[3])) / (s * dt);
        for (let i = 0; i < 3; i++) omega[i] += 0.6 * (step[i] * rate - omega[i]);
      }
      lastMoveAt = timeMs;
      from[0] = to[0];
      from[1] = to[1];
      from[2] = to[2];
      refresh();
    },
    /** Pointer up: keep turning if the pointer was still moving when it let go. */
    release(timeMs) {
      if (!grabbed) return;
      grabbed = false;
      const speed = Math.hypot(omega[0], omega[1], omega[2]);
      if (timeMs - lastMoveAt > 90 || speed < 0.05) omega[0] = omega[1] = omega[2] = 0;
      else if (speed > MAX_FLICK) for (let i = 0; i < 3; i++) omega[i] *= MAX_FLICK / speed;
    },
    /** Let go without a flick (a second finger arrived). */
    halt() {
      grabbed = false;
      omega[0] = omega[1] = omega[2] = 0;
    },
    /** Turn by `angle` radians about a view-space axis (keyboard). */
    turn(x, y, z, angle) {
      rotateBy(x, y, z, angle);
      refresh();
    },
    /**
     * Advance by dt seconds. Returns 0 when nothing changed, 1 when only the slow spin
     * moved the view, 2 while the visitor's own motion (drag, flick, zoom) is under way.
     */
    update(dt, spinning) {
      let state = grabbed ? 2 : 0;
      if (Math.abs(zoomTarget - zoom) > 1e-4) {
        zoom += (zoomTarget - zoom) * (1 - Math.exp(-10 * dt));
        if (Math.abs(zoomTarget - zoom) <= 1e-4) zoom = zoomTarget;
        state = 2;
      }
      const speed = Math.hypot(omega[0], omega[1], omega[2]);
      if (!grabbed && speed > 0.02) {
        rotateBy(omega[0] / speed, omega[1] / speed, omega[2] / speed, speed * dt);
        const decay = Math.exp(-dt / INERTIA_DECAY);
        for (let i = 0; i < 3; i++) omega[i] *= decay;
        state = 2;
      } else if (!grabbed) omega[0] = omega[1] = omega[2] = 0;
      // the spin eases back in once the visitor lets go
      spinBlend = state === 2 && (grabbed || speed > 0.02) ? 0 : Math.min(spinBlend + dt / 1.2, 1);
      if (spinning && spinBlend > 0) {
        quatFromAxisAngle(step, 0, 1, 0, SPIN_RATE * dt * spinBlend);
        quatMul(q, q, step);
        if (state === 0) state = 1;
      }
      if (state !== 0) refresh();
      return state;
    },
  };
}
