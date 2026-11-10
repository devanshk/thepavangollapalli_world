// Seed text → every parameter of a planet. Pure and deterministic: the same text always
// produces the same world. Ranges are curated per family so no draw lands on an ugly planet.
import { rng, hashString, lerp, clamp } from '../../assets/js/kit.js';
import { planetName } from './names.js';

/** Palette slots, in the order the shader's uPal[] array expects. */
export const PALETTE_SLOTS = ['deep', 'shallow', 'beach', 'hotDry', 'hotWet', 'mildDry', 'mildWet', 'coldDry', 'coldWet', 'rock', 'snow', 'ice'];

// Ranges are [min, max]. `tau` is the vertical optical depth of the clear atmosphere per
// colour channel: scattering strength, and therefore also what is removed from sunlight.
export const FAMILIES = [
  {
    id: 'temperate',
    terms: { sea: 'Ocean', wet: 'Forest', open: 'Grassland', dry: 'Desert' },
    label: 'Temperate',
    weight: 30,
    ocean: [0.52, 0.76],
    contFreq: [1.0, 1.65],
    warp: [0.55, 1.0],
    mtnAmp: [0.5, 0.9],
    tempBase: [0.88, 1.06],
    tempLat: [1.1, 1.36],
    moist: [0.44, 0.58],
    tau: [0.05, 0.11, 0.24],
    thickness: [0.85, 1.25],
    clouds: [0.38, 0.54],
    cloudColor: '#ffffff',
    lights: [0.55, 1],
    palette: ['#051c4a', '#1b7c9c', '#c9bb92', '#c2a36d', '#24521f', '#8f9455', '#2f6328', '#8a8468', '#2b4a33', '#77695c', '#f4f7fa', '#dce8f2'],
  },
  {
    id: 'arid',
    terms: { sea: 'Sea', wet: 'Scrub', open: 'Steppe', dry: 'Desert' },
    label: 'Arid',
    weight: 15,
    ocean: [0.14, 0.38],
    contFreq: [1.0, 1.6],
    warp: [0.5, 0.95],
    mtnAmp: [0.55, 1.0],
    tempBase: [0.98, 1.16],
    tempLat: [0.95, 1.2],
    moist: [0.2, 0.32],
    tau: [0.085, 0.11, 0.17],
    thickness: [0.6, 0.95],
    clouds: [0.18, 0.32],
    cloudColor: '#fff4e2',
    lights: [0.25, 0.7],
    palette: ['#08323f', '#27868a', '#d8bd8b', '#c47f45', '#66722f', '#b98a55', '#7c7a3c', '#a38b70', '#74684b', '#7c5642', '#f1ebe1', '#e8e4dc'],
  },
  {
    id: 'frozen',
    terms: { sea: 'Ocean', wet: 'Taiga', open: 'Tundra', dry: 'Barrens' },
    label: 'Frozen',
    weight: 13,
    ocean: [0.4, 0.68],
    contFreq: [1.0, 1.7],
    warp: [0.5, 1.0],
    mtnAmp: [0.5, 0.95],
    tempBase: [0.3, 0.5],
    tempLat: [0.75, 1.05],
    moist: [0.4, 0.55],
    tau: [0.045, 0.11, 0.21],
    thickness: [0.75, 1.15],
    clouds: [0.3, 0.48],
    cloudColor: '#f4f9ff',
    lights: [0, 0.35],
    palette: ['#071d38', '#2f6688', '#8b979e', '#8b8f86', '#3d5a49', '#7d8876', '#38544a', '#9aa4a8', '#465c55', '#676d76', '#f5f9fc', '#d3e5f3'],
  },
  {
    id: 'volcanic',
    terms: { sea: 'Lava', wet: 'Sulphur flats', open: 'Ash plains', dry: 'Basalt' },
    label: 'Volcanic',
    weight: 10,
    ocean: [0.16, 0.36],
    contFreq: [1.1, 1.8],
    warp: [0.6, 1.05],
    mtnAmp: [0.65, 1.05],
    tempBase: [1.3, 1.6],
    tempLat: [0.5, 0.8],
    moist: [0.3, 0.5],
    tau: [0.13, 0.08, 0.055],
    thickness: [0.6, 1.0],
    clouds: [0.2, 0.36],
    cloudColor: '#6e645c',
    lights: [0, 0],
    lava: true,
    palette: ['#120504', '#2a0c05', '#1c1817', '#3b302b', '#6b5a22', '#2d2725', '#40291c', '#3c3836', '#2e2a28', '#56504c', '#8d857e', '#7a746f'],
  },
  {
    id: 'ocean',
    terms: { sea: 'Ocean', wet: 'Forest', open: 'Grassland', dry: 'Dunes' },
    label: 'Ocean world',
    weight: 12,
    ocean: [0.86, 0.95],
    contFreq: [1.3, 2.1],
    warp: [0.6, 1.05],
    mtnAmp: [0.6, 1.0],
    tempBase: [0.92, 1.1],
    tempLat: [1.05, 1.3],
    moist: [0.5, 0.64],
    tau: [0.04, 0.1, 0.25],
    thickness: [1.0, 1.4],
    clouds: [0.44, 0.6],
    cloudColor: '#ffffff',
    lights: [0.3, 0.9],
    palette: ['#041f5c', '#149db3', '#e2d5a3', '#c8b679', '#2a7436', '#8aa957', '#36843f', '#8a9071', '#39694a', '#79746a', '#f5f8fa', '#dcebf5'],
  },
  {
    id: 'violet',
    terms: { sea: 'Ocean', wet: 'Violet forest', open: 'Heath', dry: 'Desert' },
    label: 'Violet flora',
    weight: 10,
    ocean: [0.45, 0.72],
    contFreq: [1.0, 1.65],
    warp: [0.55, 1.0],
    mtnAmp: [0.5, 0.9],
    tempBase: [0.9, 1.08],
    tempLat: [1.05, 1.3],
    moist: [0.46, 0.6],
    tau: [0.05, 0.125, 0.2],
    thickness: [0.85, 1.25],
    clouds: [0.34, 0.5],
    cloudColor: '#fbfff8',
    lights: [0.3, 0.9],
    palette: ['#062a3a', '#1f8f8f', '#d8cdb0', '#cdb08e', '#6a1f7d', '#a67bb0', '#7d2f92', '#8e7f96', '#4b2a63', '#6b6370', '#f4f1f8', '#e3e0f0'],
  },
  {
    id: 'crimson',
    terms: { sea: 'Ocean', wet: 'Red forest', open: 'Savanna', dry: 'Desert' },
    label: 'Crimson flora',
    weight: 10,
    ocean: [0.42, 0.7],
    contFreq: [1.0, 1.65],
    warp: [0.55, 1.0],
    mtnAmp: [0.5, 0.9],
    tempBase: [0.9, 1.08],
    tempLat: [1.05, 1.3],
    moist: [0.44, 0.58],
    tau: [0.1, 0.085, 0.22],
    thickness: [0.8, 1.2],
    clouds: [0.32, 0.5],
    cloudColor: '#fff8f4',
    lights: [0.3, 0.9],
    palette: ['#120f45', '#3d4aa8', '#dcc9a2', '#d4b483', '#8e1f1c', '#c7823f', '#a8321f', '#9a8576', '#6b2224', '#5f5560', '#f7f3ef', '#e8e2ee'],
  },
];

/** Limits every generated planet stays within (asserted by the tests). */
export const LIMITS = {
  tiltDeg: [2, 32],
  gain: [0.5, 0.56],
  mtnFreq: [3.2, 5.4],
  scaleHeight: [0.014, 0.022],
  cloudFreq: [3.0, 4.2],
  swirl: [0.1, 0.2],
  ringInner: [1.32, 1.6],
  ringOuter: [1.95, 2.4],
  ringChance: 0.18,
};

const srgbToLinear = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));

/** '#rrggbb' → [r, g, b] in linear light, 0..1. */
export function hexToLinear(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [srgbToLinear(((n >> 16) & 255) / 255), srgbToLinear(((n >> 8) & 255) / 255), srgbToLinear((n & 255) / 255)];
}

/** [r, g, b] linear → 'rgb(r g b)' sRGB string, for swatches on the data card. */
export function linearToCss(rgb) {
  const enc = (c) => Math.round(255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055));
  return `rgb(${enc(clamp(rgb[0]))} ${enc(clamp(rgb[1]))} ${enc(clamp(rgb[2]))})`;
}

// Rotate hue about the grey axis and scale saturation, so each seed has its own cast.
function tint(rgb, hue, sat) {
  const c = Math.cos(hue);
  const s = Math.sin(hue);
  const k = (1 - c) / 3;
  const q = s / Math.sqrt(3);
  const r = rgb[0] * (c + k) + rgb[1] * (k - q) + rgb[2] * (k + q);
  const g = rgb[0] * (k + q) + rgb[1] * (c + k) + rgb[2] * (k - q);
  const b = rgb[0] * (k - q) + rgb[1] * (k + q) + rgb[2] * (c + k);
  const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return [clamp(luma + (r - luma) * sat), clamp(luma + (g - luma) * sat), clamp(luma + (b - luma) * sat)];
}

/** Tidy the text a visitor typed: trimmed, at most 24 characters, never empty. */
export function normalizeSeed(text) {
  const s = String(text == null ? '' : text).trim().slice(0, 24);
  return s || 'world';
}

/** paramsFromSeed('any text') → the complete, immutable description of one planet. */
export function paramsFromSeed(text) {
  const seed = normalizeSeed(text);
  const hash = hashString(seed);
  const r = rng(hash);
  const span = (range) => lerp(range[0], range[1], r());

  const totalWeight = FAMILIES.reduce((sum, f) => sum + f.weight, 0);
  let ticket = r() * totalWeight;
  let family = FAMILIES[FAMILIES.length - 1];
  for (const f of FAMILIES) {
    ticket -= f.weight;
    if (ticket < 0) {
      family = f;
      break;
    }
  }

  const oceanTarget = span(family.ocean);
  const contFreq = span(family.contFreq);
  const warp = span(family.warp);
  const gain = span(LIMITS.gain);
  const mtnAmp = span(family.mtnAmp);
  const mtnFreq = span(LIMITS.mtnFreq);
  const tempBase = span(family.tempBase);
  const tempLat = span(family.tempLat);
  const moistBase = span(family.moist);
  const thickness = span(family.thickness);
  const scaleHeight = span(LIMITS.scaleHeight);
  const cloudCover = span(family.clouds);
  const cloudFreq = span(LIMITS.cloudFreq);
  const swirl = span(LIMITS.swirl);
  const lights = span(family.lights);
  const tiltDeg = span(LIMITS.tiltDeg);
  const longitude = r() * Math.PI * 2;
  const hue = (r() - 0.5) * 0.3;
  const sat = lerp(0.9, 1.12, r());
  const hasRing = r() < LIMITS.ringChance;
  const ringInner = span(LIMITS.ringInner);
  const ringOuter = span(LIMITS.ringOuter);
  const ringOpacity = lerp(0.55, 0.9, r());
  const ringWarmth = r();

  const palette = new Float32Array(PALETTE_SLOTS.length * 3);
  family.palette.forEach((hex, i) => {
    // snow and ice keep their own colour; everything else takes the seed's cast
    const base = hexToLinear(hex);
    palette.set(i >= 10 ? base : tint(base, hue, sat), i * 3);
  });

  return Object.freeze({
    seed,
    hash,
    name: planetName(hash),
    family: family.id,
    familyLabel: family.label,
    terms: family.terms,
    oceanTarget,
    contFreq,
    warp,
    gain,
    mtnAmp,
    mtnFreq,
    tempBase,
    tempLat,
    moistBase,
    palette,
    lava: !!family.lava,
    lights,
    atmosphere: Object.freeze({
      tau: Object.freeze(family.tau.map((t) => t * thickness)),
      mie: 0.012 * thickness,
      scaleHeight,
      thickness,
    }),
    clouds: Object.freeze({ cover: cloudCover, freq: cloudFreq, swirl, color: Object.freeze(hexToLinear(family.cloudColor)) }),
    tiltDeg,
    longitude,
    ring: hasRing
      ? Object.freeze({
          inner: ringInner,
          outer: ringOuter,
          opacity: ringOpacity,
          color: Object.freeze([lerp(0.62, 0.86, ringWarmth), lerp(0.62, 0.74, ringWarmth), lerp(0.66, 0.56, ringWarmth)]),
        })
      : null,
  });
}
