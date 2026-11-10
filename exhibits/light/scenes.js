// The three scenes, as data. One scene unit is a decimetre: these are tabletop still lifes, which
// is what makes a real-world f-number produce visible depth of field. Colours are linear RGB.
import { rng } from '../../assets/js/kit.js';
import { cross, normalize, scale, sub } from './vec.js';

/** A rectangle centred at `c` whose front face looks toward `lookAt`. */
function panel(c, lookAt, halfWidth, halfHeight, mat, oneSided = false) {
  const n = normalize(sub(lookAt, c));
  const side = Math.abs(n[1]) > 0.999 ? [1, 0, 0] : normalize(cross([0, 1, 0], n));
  return { c, u: scale(side, halfWidth), v: scale(cross(n, side), halfHeight), mat, oneSided };
}

const studio = {
  id: 'studio',
  name: 'Studio',
  exposure: 1,
  env: { color: [0.01, 0.012, 0.016] },
  camera: {
    target: [0, 1.3, 0],
    yaw: 0.22,
    pitch: 0.12,
    distance: 14,
    fov: 30,
    minTanH: 0.4,
    fNumber: 2,
    focus: [0.3, 1.4, 2.5],
    limits: { pitch: [0.03, 1.1], distance: [6, 30] },
  },
  materials: {
    floor: { type: 'plastic', color: [0.36, 0.35, 0.34], roughness: 0.1, tiles: [2.6, 0.36] },
    backdrop: { type: 'diffuse', color: [0.1, 0.19, 0.34] },
    glass: { type: 'glass', color: [0.97, 0.995, 0.985], ior: 1.5 },
    chrome: { type: 'metal', color: [0.95, 0.95, 0.96], roughness: 0 },
    matte: { type: 'diffuse', color: [0.78, 0.17, 0.09] },
    gold: { type: 'metal', color: [1, 0.77, 0.33], roughness: 0.3 },
    ceramic: { type: 'plastic', color: [0.78, 0.76, 0.7], roughness: 0.1 },
    softbox: { type: 'emissive', color: [9, 8.6, 8] },
    strip: { type: 'emissive', color: [8, 13, 22] },
  },
  spheres: [
    { c: [0.3, 1.4, 1.2], r: 1.4, mat: 'glass' },
    { c: [-3.3, 1.75, -1.7], r: 1.75, mat: 'chrome' },
    { c: [3.4, 1.5, -1.0], r: 1.5, mat: 'matte' },
    { c: [-2.1, 0.8, 2.4], r: 0.8, mat: 'gold' },
    { c: [2.6, 0.6, 2.7], r: 0.6, mat: 'ceramic' },
  ],
  quads: [
    { c: [0, 0, 0], u: [70, 0, 0], v: [0, 0, -70], mat: 'floor' },
    { c: [0, 14, -15], u: [40, 0, 0], v: [0, 14, 0], mat: 'backdrop', oneSided: true },
    panel([-4, 10.5, 3], [0, 0, 0], 6, 4, 'softbox'),
    panel([10, 4.2, -5], [0, 1.5, 0], 0.7, 3.6, 'strip'),
  ],
};

const box = {
  id: 'box',
  name: 'Box',
  exposure: 1,
  env: { color: [0, 0, 0] },
  camera: {
    target: [0, 5, 0],
    yaw: 0,
    pitch: 0,
    distance: 20.6,
    fov: 38,
    minTanH: 0.3443,
    fNumber: 8,
    focus: [1.9, 1.6, 3.0],
    limits: { pitch: [-0.5, 0.9], distance: [9, 40] },
  },
  materials: {
    white: { type: 'diffuse', color: [0.73, 0.71, 0.68] },
    red: { type: 'diffuse', color: [0.63, 0.065, 0.05] },
    green: { type: 'diffuse', color: [0.14, 0.45, 0.091] },
    glass: { type: 'glass', color: [1, 1, 1], ior: 1.5 },
    lamp: { type: 'emissive', color: [11.5, 9.2, 6.3] },
  },
  spheres: [{ c: [2.0, 1.6, 1.5], r: 1.6, mat: 'glass' }],
  boxes: [{ c: [-1.7, 3, -1.5], h: [1.5, 3, 1.5], rotY: 0.3, mat: 'white' }],
  quads: [
    { c: [0, 0, 0], u: [5, 0, 0], v: [0, 0, -5], mat: 'white', oneSided: true },
    { c: [0, 10, 0], u: [5, 0, 0], v: [0, 0, 5], mat: 'white', oneSided: true },
    { c: [0, 5, -5], u: [5, 0, 0], v: [0, 5, 0], mat: 'white', oneSided: true },
    { c: [-5, 5, 0], u: [0, 0, -5], v: [0, 5, 0], mat: 'red', oneSided: true },
    { c: [5, 5, 0], u: [0, 0, 5], v: [0, 5, 0], mat: 'green', oneSided: true },
    { c: [0, 5, 5], u: [-5, 0, 0], v: [0, 5, 0], mat: 'white', oneSided: true },
    { c: [0, 9.98, 0], u: [1.8, 0, 0], v: [0, 0, 1.8], mat: 'lamp', oneSided: true },
  ],
};

/** Scatter small spheres on the ground around a few hero spheres, deterministically. */
function scatter(heroes, count, seed) {
  const r = rng(seed);
  const kinds = ['coral', 'mustard', 'teal', 'cream', 'navy', 'chrome', 'gold', 'copper', 'glass', 'amber'];
  const placed = heroes.slice();
  let guard = 0;
  while (placed.length < heroes.length + count && guard++ < 4000) {
    const radius = r.range(0.2, 0.4) + 0.45 * r() ** 3;
    // denser near the camera's line of sight, thinning out with distance behind the heroes
    const z = 4.5 - 26 * r() ** 1.3;
    const x = r.range(-1, 1) * (3 + 0.45 * (4.5 - z));
    const c = [x, radius, z];
    // keep the line of sight to the heroes open
    const inTheWay = z > 1.3 && Math.abs(x) < 1.7;
    const clear = placed.every((s) => Math.hypot(s.c[0] - c[0], s.c[2] - c[2]) > s.r + radius + 0.2);
    if (clear && !inTheWay) placed.push({ c, r: radius, mat: r.pick(kinds) });
  }
  return placed;
}

const outdoor = {
  id: 'outdoor',
  name: 'Outdoor',
  exposure: 6,
  env: { sun: { azimuth: -38, elevation: 13, radius: 2.2 }, intensity: 1, skyGain: 1.8 },
  camera: {
    target: [0, 0.8, 0],
    yaw: 0.06,
    pitch: 0.14,
    distance: 8.4,
    fov: 30,
    minTanH: 0.36,
    fNumber: 1.4,
    focus: [0, 1, 0.9],
    limits: { pitch: [0.03, 1.2], distance: [3.5, 24] },
  },
  materials: {
    ground: { type: 'diffuse', color: [0.46, 0.4, 0.33] },
    coral: { type: 'diffuse', color: [0.8, 0.2, 0.14] },
    mustard: { type: 'diffuse', color: [0.82, 0.55, 0.1] },
    teal: { type: 'diffuse', color: [0.07, 0.42, 0.44] },
    cream: { type: 'diffuse', color: [0.8, 0.76, 0.66] },
    navy: { type: 'plastic', color: [0.06, 0.1, 0.34], roughness: 0.12 },
    chrome: { type: 'metal', color: [0.95, 0.95, 0.96], roughness: 0 },
    gold: { type: 'metal', color: [1, 0.77, 0.33], roughness: 0.18 },
    copper: { type: 'metal', color: [0.96, 0.62, 0.5], roughness: 0.32 },
    glass: { type: 'glass', color: [1, 1, 1], ior: 1.5 },
    amber: { type: 'glass', color: [0.95, 0.55, 0.16], ior: 1.5 },
  },
  spheres: scatter(
    [
      { c: [0, 1, 0], r: 1, mat: 'glass' },
      { c: [-2.3, 0.8, -1.2], r: 0.8, mat: 'chrome' },
      { c: [1.9, 0.65, -0.5], r: 0.65, mat: 'coral' },
    ],
    44,
    11,
  ),
  quads: [{ c: [0, 0, 0], u: [1500, 0, 0], v: [0, 0, -1500], mat: 'ground' }],
};

export const SCENES = [studio, box, outdoor];
export const sceneById = (id) => SCENES.find((s) => s.id === id) || SCENES[0];
