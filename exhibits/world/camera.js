// Framing: where the sun is, how the planet first faces the camera, and how zoom maps to
// camera distance. Pure math, no DOM.
import { quatFromAxisAngle, quatMul, distanceForRadius } from './rotation.js';

const DEG = Math.PI / 180;
/** The sun rides this far above the view's horizontal plane when it is behind the camera. */
const SUN_LIFT = 15 * DEG;
/** On-screen radius of the disc at full zoom-out and full zoom-in, in half-canvas units. */
const FAR_RADIUS = 0.66;
const NEAR_RADIUS = 2.0;

/**
 * Unit vector toward the sun for a slider angle in degrees. 0 puts the sun behind the
 * camera (a full disc), ±90 lights the planet from the side, ±180 puts the sun directly
 * behind the planet. The lift fades out toward ±180 so that position is a true eclipse.
 */
export function sunDirection(out, angleDeg) {
  const a = angleDeg * DEG;
  const half = Math.cos(a / 2);
  const lift = SUN_LIFT * half * half;
  out[0] = Math.sin(a) * Math.cos(lift);
  out[1] = Math.sin(lift);
  out[2] = Math.cos(a) * Math.cos(lift);
  return out;
}

/**
 * The orientation a planet starts in: turned to its seed's longitude, nodded so the north
 * pole tips toward the viewer, then rolled by its axial tilt.
 */
export function initialOrientation(out, tiltDeg, longitude) {
  const spin = quatFromAxisAngle([0, 0, 0, 1], 0, 1, 0, longitude);
  const nod = quatFromAxisAngle([0, 0, 0, 1], 1, 0, 0, 0.3);
  const roll = quatFromAxisAngle([0, 0, 0, 1], 0, 0, 1, -tiltDeg * DEG);
  quatMul(out, nod, spin);
  return quatMul(out, roll, out);
}

/**
 * Disc radius at full zoom-out. A ring system has to fit across the canvas, so ringed
 * planets sit further away. aspect = canvas width / height.
 */
export function fitRadius(aspect, ringOuter) {
  if (!ringOuter) return FAR_RADIUS;
  const halfWidth = Math.max(aspect, 1);
  return Math.min(FAR_RADIUS, (0.95 * halfWidth) / ringOuter);
}

/** Natural log of the size ratio between full zoom-in and full zoom-out. */
export const zoomRange = (fit) => Math.log(NEAR_RADIUS / fit);

/** Camera distance for zoom in [0, 1]: the disc radius grows geometrically from fit to near. */
export function zoomDistance(zoom, fit, tanFov) {
  return distanceForRadius(fit * Math.pow(NEAR_RADIUS / fit, zoom), tanFov);
}
