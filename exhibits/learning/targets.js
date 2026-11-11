// targets.js — the pictures the network learns, all generated in code.
// ringsImage is pure (the tests use it in Node); the paint functions draw on a 2D canvas context.
import { rng, TAU } from '../../assets/js/kit.js';

export const TARGETS = [
  { value: 'scene', label: 'Scene' },
  { value: 'rings', label: 'Rings' },
  { value: 'letters', label: 'Letters' },
  { value: 'draw', label: 'Draw' },
];

export const PAPER = '#f1ead9';
export const INKS = [
  { name: 'ink', color: '#1b1a22' },
  { name: 'red', color: '#e0452f' },
  { name: 'yellow', color: '#f4b93a' },
  { name: 'green', color: '#2f9e77' },
  { name: 'blue', color: '#2f6fde' },
  { name: 'paper', color: PAPER },
];

const RING_WIDTH = 0.03;
const SERIF_FALLBACK = "Georgia, 'Times New Roman', serif";

/**
 * Thin concentric rings, alternately dark and brightly coloured, with the hue turning around
 * the centre. A ring and its gap span about 7.7 pixels at 128 px, which is fine detail for a
 * network. Returns n × n × 3 floats in 0..1, each pixel the average of ss × ss samples.
 */
export function ringsImage(n, ss = 4) {
  const out = new Float32Array(n * n * 3);
  const weight = 1 / (ss * ss);
  for (let py = 0; py < n; py++) {
    for (let px = 0; px < n; px++) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const dx = (px + (sx + 0.5) / ss) / n - 0.5;
          const dy = (py + (sy + 0.5) / ss) / n - 0.5;
          const radius = Math.sqrt(dx * dx + dy * dy);
          if (Math.floor(radius / RING_WIDTH) % 2 === 1) {
            r += 0.05;
            g += 0.06;
            b += 0.15;
          } else {
            const hue = Math.atan2(dy, dx) + radius * 5;
            r += 0.56 + 0.44 * Math.cos(hue);
            g += 0.56 + 0.44 * Math.cos(hue - 2.1);
            b += 0.56 + 0.44 * Math.cos(hue - 4.2);
          }
        }
      }
      const q = 3 * (py * n + px);
      out[q] = r * weight;
      out[q + 1] = g * weight;
      out[q + 2] = b * weight;
    }
  }
  return out;
}

function toRGBA(rgb, n) {
  const rgba = new Uint8ClampedArray(n * n * 4);
  for (let p = 0; p < n * n; p++) {
    rgba[4 * p] = rgb[3 * p] * 255;
    rgba[4 * p + 1] = rgb[3 * p + 1] * 255;
    rgba[4 * p + 2] = rgb[3 * p + 2] * 255;
    rgba[4 * p + 3] = 255;
  }
  return rgba;
}

function disc(ctx, x, y, radius) {
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, TAU);
  ctx.fill();
}

function streak(ctx, x0, x1, y, thickness) {
  ctx.lineWidth = thickness;
  ctx.beginPath();
  ctx.moveTo(x0, y);
  ctx.lineTo(x1, y);
  ctx.stroke();
}

const triangleWave = (t) => Math.abs((((t % 1) + 1) % 1) * 2 - 1);

function ridge(ctx, r, base, amp, top, bottom) {
  const p1 = r();
  const p2 = r();
  const p3 = r();
  ctx.beginPath();
  ctx.moveTo(0, 1);
  for (let i = 0; i <= 48; i++) {
    const x = i / 48;
    const height = 0.55 * triangleWave(x * 1.7 + p1) + 0.3 * triangleWave(x * 4.3 + p2) + 0.15 * triangleWave(x * 9.1 + p3);
    ctx.lineTo(x, base - amp * height);
  }
  ctx.lineTo(1, 1);
  ctx.closePath();
  const fill = ctx.createLinearGradient(0, base - amp, 0, base + 0.1);
  fill.addColorStop(0, top);
  fill.addColorStop(1, bottom);
  ctx.fillStyle = fill;
  ctx.fill();
}

function pine(ctx, x, base, height) {
  const width = height * 0.36;
  for (let tier = 0; tier < 4; tier++) {
    const top = base - height + tier * height * 0.2;
    const half = width * (0.34 + 0.22 * tier);
    ctx.beginPath();
    ctx.moveTo(x, top);
    ctx.lineTo(x + half, top + height * 0.42);
    ctx.lineTo(x - half, top + height * 0.42);
    ctx.closePath();
    ctx.fill();
  }
}

// A dusk landscape: smooth gradients (sky, glow, water) against crisp edges (sun, ridges, trees).
function paintScene(ctx, n) {
  const r = rng(23);
  ctx.scale(n, n);

  const sky = ctx.createLinearGradient(0, 0, 0, 0.8);
  sky.addColorStop(0, '#10143f');
  sky.addColorStop(0.4, '#4a2f86');
  sky.addColorStop(0.68, '#d9577c');
  sky.addColorStop(0.86, '#ff9d5c');
  sky.addColorStop(1, '#ffd27a');
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, 1, 1);

  ctx.fillStyle = '#fff4d6';
  for (let i = 0; i < 18; i++) disc(ctx, r(), r() * 0.34, r.range(0.005, 0.011));

  const sunX = 0.64;
  const sunY = 0.55;
  const glow = ctx.createRadialGradient(sunX, sunY, 0.08, sunX, sunY, 0.46);
  glow.addColorStop(0, 'rgba(255, 226, 150, 0.7)');
  glow.addColorStop(1, 'rgba(255, 226, 150, 0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, 1, 1);
  ctx.fillStyle = '#fff1bd';
  disc(ctx, sunX, sunY, 0.11);

  ctx.lineCap = 'round';
  ctx.strokeStyle = '#c24a7e';
  streak(ctx, 0.4, 0.74, 0.5, 0.022);
  streak(ctx, 0.58, 0.9, 0.585, 0.016);
  ctx.strokeStyle = '#7d3a8f';
  streak(ctx, 0.07, 0.3, 0.4, 0.02);
  streak(ctx, 0.2, 0.42, 0.44, 0.012);

  ridge(ctx, r, 0.63, 0.13, '#7a4590', '#51307a');
  ridge(ctx, r, 0.74, 0.11, '#33245f', '#1c1542');

  const lake = ctx.createLinearGradient(0, 0.8, 0, 1);
  lake.addColorStop(0, '#f08a63');
  lake.addColorStop(0.35, '#a5487c');
  lake.addColorStop(1, '#231a52');
  ctx.fillStyle = lake;
  ctx.fillRect(0, 0.8, 1, 0.2);
  ctx.strokeStyle = '#ffe6a3';
  for (let i = 0; i < 7; i++) {
    const half = 0.1 - i * 0.011 + r.range(-0.012, 0.012);
    const cx = sunX + r.range(-0.015, 0.015);
    streak(ctx, cx - half, cx + half, 0.818 + i * 0.026, 0.009);
  }

  ctx.fillStyle = '#0d0a24';
  pine(ctx, 0.1, 1.02, 0.38);
  pine(ctx, 0.21, 1.02, 0.26);
  pine(ctx, 0.9, 1.02, 0.31);
  pine(ctx, 0.99, 1.02, 0.2);
}

// A type specimen: two large serif characters, one in ink and one in red, on paper.
function paintLetters(ctx, n, serif) {
  ctx.fillStyle = PAPER;
  ctx.fillRect(0, 0, n, n);
  const family = serif || SERIF_FALLBACK;
  ctx.font = `600 100px ${family}`;
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  const whole = ctx.measureText('Ag');
  const first = ctx.measureText('A');
  const ascent = whole.actualBoundingBoxAscent || 72;
  const descent = whole.actualBoundingBoxDescent || 22;
  const fit = Math.min((0.86 * n) / whole.width, (0.8 * n) / (ascent + descent));
  ctx.font = `600 ${100 * fit}px ${family}`;
  const x = (n - whole.width * fit) / 2;
  const y = (n - (ascent + descent) * fit) / 2 + ascent * fit;
  ctx.fillStyle = '#1b1a22';
  ctx.fillText('A', x, y);
  ctx.fillStyle = '#d9412b';
  ctx.fillText('g', x + first.width * fit, y);
}

/** Paints one of the built-in pictures ('scene', 'rings' or 'letters') on an n × n canvas. */
export function paintTarget(ctx, n, kind, serif) {
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  if (kind === 'rings') ctx.putImageData(new ImageData(toRGBA(ringsImage(n), n), n, n), 0, 0);
  else if (kind === 'letters') paintLetters(ctx, n, serif);
  else paintScene(ctx, n);
  ctx.restore();
}

/** Wipes the canvas to blank paper for "Draw". */
export function clearPaper(ctx, n) {
  ctx.fillStyle = PAPER;
  ctx.fillRect(0, 0, n, n);
}
