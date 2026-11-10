// palette.js — dye colours and the idle emitters. Colours are chosen in OKLCh at one shared
// lightness and returned as linear-light RGB, which is what the dye texture stores.

/** OKLCh (hue in degrees) → linear sRGB, unclamped. */
export function oklchToLinear(L, C, hueDeg) {
  const h = (hueDeg * Math.PI) / 180;
  const a = C * Math.cos(h);
  const b = C * Math.sin(h);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

export const inGamut = (rgb) => rgb.every((x) => x >= 0 && x <= 1);

export const DYE_LIGHTNESS = 0.74;

/** The most saturated colour of a hue at the shared lightness that sRGB can still show. */
export function dyeColor(hueDeg) {
  let chroma = 0.21;
  let rgb = oklchToLinear(DYE_LIGHTNESS, chroma, hueDeg);
  while (!inGamut(rgb) && chroma > 0.01) {
    chroma *= 0.97;
    rgb = oklchToLinear(DYE_LIGHTNESS, chroma, hueDeg);
  }
  return rgb;
}

export const PALETTE = [25, 70, 140, 195, 250, 300, 345].map(dyeColor);
/** Tunnel streaklines, cool at the top and warm at the bottom, so the two rows of a vortex street differ. */
export const STREAKS = [28, 55, 85, 185, 215, 250].map(dyeColor);

/** Colour for the k-th touch: a stride of three keeps consecutive touches far apart in hue. */
export const touchColor = (k) => PALETTE[(k * 3) % PALETTE.length];

const JETS = [
  { x: 0.2, y: 0.3, rx: 0.06, ry: 0.1, rate: 0.11, aim: 0.55 },
  { x: 0.8, y: 0.64, rx: 0.06, ry: 0.1, rate: 0.09, aim: Math.PI + 0.45 },
  { x: 0.52, y: 0.14, rx: 0.1, ry: 0.04, rate: 0.13, aim: Math.PI / 2 },
];
export const JET_COUNT = JETS.length;

/**
 * State of idle emitter k at time t (seconds), written into `out`:
 * position in 0..1 (y up), a unit direction, a 0.2..1 pulse and a linear RGB colour.
 */
export function emitter(k, t, out = { x: 0, y: 0, dx: 0, dy: 0, pulse: 0, color: [0, 0, 0] }) {
  const j = JETS[k];
  out.x = j.x + j.rx * Math.sin(j.rate * t + k * 2.1);
  out.y = j.y + j.ry * Math.cos(j.rate * 1.3 * t + k);
  const angle = j.aim + 0.7 * Math.sin(0.23 * t + k * 1.7);
  out.dx = Math.cos(angle);
  out.dy = Math.sin(angle);
  out.pulse = 0.6 + 0.4 * Math.sin(1.1 * t + k * 2.4);
  const s = t / 11 + k * 2.33;
  const i = Math.floor(s) % PALETTE.length;
  const f = Math.min(Math.max((s - Math.floor(s) - 0.7) / 0.3, 0), 1);
  const a = PALETTE[i];
  const b = PALETTE[(i + 1) % PALETTE.length];
  for (let c = 0; c < 3; c++) out.color[c] = a[c] + (b[c] - a[c]) * f;
  return out;
}
