// shapes.js — obstacles. The visitor's drawing lives in a bitmap that does not depend on the
// simulation resolution; buildMask() turns it into the cell-type mask for whatever grid the
// solver is currently using. Rows are bottom-up, like the simulation.

export const MASK_FLUID = 0;
export const MASK_OPEN = 51;
export const MASK_SOLID = 255;

const DRAWING_WIDTH = 256;
const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);

export function createDrawing(aspect) {
  const w = DRAWING_WIDTH;
  const h = Math.max(16, Math.round(w / aspect));
  return { w, h, data: new Uint8Array(w * h) };
}

/** Paint (value 1) or erase (value 0) a round-capped stroke. Coordinates are 0..1, radius is a fraction of the width. */
export function stampLine(d, x0, y0, x1, y1, radius, value) {
  const { w, h, data } = d;
  const ax = x0 * w;
  const ay = y0 * h;
  const dx = x1 * w - ax;
  const dy = y1 * h - ay;
  const r = radius * w;
  const len2 = dx * dx + dy * dy;
  const minX = clamp(Math.floor(Math.min(ax, ax + dx) - r), 0, w - 1);
  const maxX = clamp(Math.ceil(Math.max(ax, ax + dx) + r), 0, w - 1);
  const minY = clamp(Math.floor(Math.min(ay, ay + dy) - r), 0, h - 1);
  const maxY = clamp(Math.ceil(Math.max(ay, ay + dy) + r), 0, h - 1);
  for (let py = minY; py <= maxY; py++)
    for (let px = minX; px <= maxX; px++) {
      const qx = px + 0.5 - ax;
      const qy = py + 0.5 - ay;
      const t = len2 > 0 ? clamp((qx * dx + qy * dy) / len2, 0, 1) : 0;
      const ex = qx - dx * t;
      const ey = qy - dy * t;
      if (ex * ex + ey * ey <= r * r) data[px + py * w] = value;
    }
}

function fill(d, inside) {
  for (let py = 0; py < d.h; py++)
    for (let px = 0; px < d.w; px++) d.data[px + py * d.w] = inside(px + 0.5, py + 0.5) ? 1 : 0;
}

/** Diameter of the cylinder preset as a fraction of the tunnel height. */
export const CYLINDER_DIAMETER = 0.17;

// A cambered 14 % thick aerofoil (the NACA four-digit thickness law), nose up by nine degrees.
function aerofoil(d) {
  const chord = 0.34 * d.w;
  const angle = (9 * Math.PI) / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const noseX = 0.17 * d.w;
  const noseY = 0.5 * d.h + 0.5 * chord * sin;
  const thickness = 0.14;
  const camber = 0.04;
  const peak = 0.4;
  return (x, y) => {
    const rx = x - noseX;
    const ry = y - noseY;
    const s = (rx * cos - ry * sin) / chord;
    if (s < 0 || s > 1) return false;
    const t = (rx * sin + ry * cos) / chord;
    const half = 5 * thickness * (0.2969 * Math.sqrt(s) - 0.126 * s - 0.3516 * s * s + 0.2843 * s ** 3 - 0.1036 * s ** 4);
    const mean = s < peak
      ? (camber / (peak * peak)) * (2 * peak * s - s * s)
      : (camber / ((1 - peak) * (1 - peak))) * (1 - 2 * peak + 2 * peak * s - s * s);
    return Math.abs(t - mean) <= half;
  };
}

/** Replace the drawing with a preset: 'cylinder', 'plate', 'aerofoil' or 'none'. */
export function preset(d, name) {
  const cx = 0.24 * d.w;
  const cy = 0.5 * d.h;
  if (name === 'cylinder') {
    const r = 0.5 * CYLINDER_DIAMETER * d.h;
    fill(d, (x, y) => (x - cx) * (x - cx) + (y - cy) * (y - cy) <= r * r);
  } else if (name === 'plate') {
    const halfT = 0.012 * d.w;
    const halfH = 0.13 * d.h;
    fill(d, (x, y) => Math.abs(x - cx) <= halfT && Math.abs(y - cy) <= halfH);
  } else if (name === 'aerofoil') {
    fill(d, aerofoil(d));
  } else {
    d.data.fill(0);
  }
}

/**
 * Cell types for an n × m grid, as bytes for an R8 texture.
 * Ink: a closed box. Tunnel: inlet column on the left (solid, moving at the inflow speed),
 * open column on the right, walls above and below, plus the drawing. A strip beside each wall
 * and beside the inlet and outlet is kept clear so that no drawing can seal the tunnel, which
 * would leave the pressure equation without a solution.
 */
export function buildMask(d, n, m, tunnel, out = new Uint8Array(n * m)) {
  const margin = Math.max(2, Math.round(m * 0.035));
  for (let j = 0; j < m; j++) {
    const sy = Math.min(d.h - 1, Math.floor(((j + 0.5) / m) * d.h));
    for (let i = 0; i < n; i++) {
      let t = MASK_FLUID;
      if (!tunnel) {
        if (i === 0 || j === 0 || i === n - 1 || j === m - 1) t = MASK_SOLID;
      } else if (j === 0 || j === m - 1 || i === 0) {
        t = MASK_SOLID;
      } else if (i === n - 1) {
        t = MASK_OPEN;
      } else if (i >= 4 && i < n - 4 && j > margin && j < m - 1 - margin) {
        const sx = Math.min(d.w - 1, Math.floor(((i + 0.5) / n) * d.w));
        if (d.data[sx + sy * d.w]) t = MASK_SOLID;
      }
      out[i + j * n] = t;
    }
  }
  return out;
}
