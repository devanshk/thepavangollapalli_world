// Orbit camera and thin-lens model, mirrored by the ray generation in shader/integrate.js.
// Scene units are decimetres, so the tabletop scenes photograph like real still lifes: the
// f-number is defined for a 24 mm-tall sensor, exactly as on a full-frame camera.
import { add, cross, dot, madd, normalize, scale, sub } from './vec.js';

export const SENSOR_HEIGHT = 0.24;
export const METRES_PER_UNIT = 0.1;

/** Eye position and orthonormal basis of a camera orbiting `target`. Yaw 0 looks along −z. */
export function orbitBasis({ target, yaw, pitch, distance }) {
  const cp = Math.cos(pitch);
  const back = [Math.sin(yaw) * cp, Math.sin(pitch), Math.cos(yaw) * cp];
  const fwd = scale(back, -1);
  const right = normalize(cross(fwd, [0, 1, 0]));
  return { eye: madd(target, back, distance), fwd, right, up: cross(right, fwd) };
}

/**
 * Half-angle tangents of the view. `fovDeg` is the vertical field of view; on narrow canvases the
 * view widens just enough to keep `minTanH` of horizontal coverage so compositions stay in frame.
 */
export function fieldOfView(fovDeg, aspect, minTanH = 0) {
  let tanV = Math.tan((fovDeg * Math.PI) / 360);
  let tanH = tanV * aspect;
  if (tanH < minTanH) {
    tanH = minTanH;
    tanV = tanH / aspect;
  }
  return { tanH, tanV };
}

/** Focal length (scene units) of the lens that gives this vertical field of view. */
export const focalLength = (tanV) => SENSOR_HEIGHT / (2 * tanV);

/** Radius of the aperture for an f-number: diameter = focal length / N. */
export const lensRadius = (tanV, fNumber) => focalLength(tanV) / (2 * fNumber);

/** Everything the shader needs to generate rays. `focus` is measured along the view axis. */
export function makeCamera(pose, { fovDeg, aspect, minTanH = 0, fNumber, focus }) {
  const { tanH, tanV } = fieldOfView(fovDeg, aspect, minTanH);
  return { ...orbitBasis(pose), tanH, tanV, lensRadius: lensRadius(tanV, fNumber), focus };
}

/** Un-normalised direction through a point of the image. nx, ny run 0..1 from the top-left corner. */
const through = (cam, nx, ny) =>
  madd(madd(cam.fwd, cam.right, (2 * nx - 1) * cam.tanH), cam.up, (1 - 2 * ny) * cam.tanV);

/** Ray through the centre of the lens: what a pinhole camera would see at (nx, ny). */
export function pinholeRay(cam, nx, ny) {
  return { o: cam.eye, d: normalize(through(cam, nx, ny)) };
}

/**
 * Ray from the point (lx, ly) of the unit lens disc. Every lens point aims at the same spot on
 * the focus plane, so only objects on that plane are sharp.
 */
export function lensRay(cam, nx, ny, lx, ly) {
  const focusPoint = madd(cam.eye, through(cam, nx, ny), cam.focus);
  const o = add(cam.eye, add(scale(cam.right, lx * cam.lensRadius), scale(cam.up, ly * cam.lensRadius)));
  return { o, d: normalize(sub(focusPoint, o)) };
}

/** Distance of a world point from the camera measured along the view axis. */
export const depthOf = (cam, point) => dot(sub(point, cam.eye), cam.fwd);
