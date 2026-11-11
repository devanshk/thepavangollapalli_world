// trainer.js — one training session: a network, the picture it is learning, and the ways to
// look at it (full-image prediction, hidden-unit maps, a magnified patch). Pure, no DOM.
import { rng } from '../../assets/js/kit.js';
import { createNet, encode, forward, backward, adamStep } from './net.js';

export const TILE_COUNT = 12;
const TILE_STRIDE = 2;

// Spread the tiles evenly over the hidden layers: the first few units of each one.
function pickTileUnits(hidden) {
  const per = Math.ceil(TILE_COUNT / hidden.length);
  const units = [];
  for (let t = 0; t < TILE_COUNT; t++) {
    const layer = Math.min(hidden.length - 1, Math.floor(t / per));
    units.push({ layer, unit: (t - layer * per) % hidden[layer] });
  }
  return units;
}

/**
 * createSession({ size, hidden, activation, fourier, scale, seed, batch, lr })
 * The picture is size × size pixels. Pixel (px, py) sits at u = (px + 0.5) / size.
 */
export function createSession(config) {
  const { size, hidden, activation, fourier, scale, seed, batch } = config;
  const net = createNet({ hidden, activation, fourier, scale, seed, maxBatch: batch });
  const pixels = size * size;
  const D = net.inDim;
  const input = net.acts[0];
  const coords = new Float32Array(2 * batch);

  // The encoded input of every pixel centre, computed once: training then needs no trigonometry.
  const table = new Float32Array(pixels * D);
  for (let p0 = 0; p0 < pixels; p0 += batch) {
    const n = Math.min(batch, pixels - p0);
    for (let i = 0; i < n; i++) {
      const p = p0 + i;
      const px = p % size;
      coords[2 * i] = (px + 0.5) / size;
      coords[2 * i + 1] = ((p - px) / size + 0.5) / size;
    }
    encode(net, coords, n, input);
    table.set(input.subarray(0, n * D), p0 * D);
  }

  const target = new Float32Array(pixels * 3);
  const batchTarget = new Float32Array(batch * 3);
  const pick = rng((seed ^ 0x9e3779b9) >>> 0);
  const tileSize = size / TILE_STRIDE;
  const tileArea = tileSize * tileSize;
  const tileUnits = pickTileUnits(hidden);
  const tileRaw = new Float32Array(TILE_COUNT * tileArea);
  let squaredError = 0;

  function captureTiles(p0, n) {
    for (let i = 0; i < n; i++) {
      const p = p0 + i;
      const px = p % size;
      const py = (p - px) / size;
      if (px % TILE_STRIDE !== 0 || py % TILE_STRIDE !== 0) continue;
      const cell = (py / TILE_STRIDE) * tileSize + px / TILE_STRIDE;
      for (let t = 0; t < TILE_COUNT; t++) {
        const { layer, unit } = tileUnits[t];
        tileRaw[t * tileArea + cell] = net.acts[layer + 1][i * net.sizes[layer + 1] + unit];
      }
    }
  }

  const session = {
    net,
    size,
    lr: config.lr,
    steps: 0,
    tileSize,
    tileUnits,

    /** Replace the picture from RGBA bytes (size × size × 4). Alpha is ignored. */
    setTargetRGBA(rgba) {
      for (let p = 0; p < pixels; p++) {
        target[3 * p] = rgba[4 * p] / 255;
        target[3 * p + 1] = rgba[4 * p + 1] / 255;
        target[3 * p + 2] = rgba[4 * p + 2] / 255;
      }
    },

    /** One optimisation step on a random mini-batch of pixels. Returns the batch loss. */
    step() {
      for (let i = 0; i < batch; i++) {
        const p = pick.int(pixels);
        const src = p * D;
        const dst = i * D;
        for (let k = 0; k < D; k++) input[dst + k] = table[src + k];
        batchTarget[3 * i] = target[3 * p];
        batchTarget[3 * i + 1] = target[3 * p + 1];
        batchTarget[3 * i + 2] = target[3 * p + 2];
      }
      forward(net, batch);
      const loss = backward(net, batch, batchTarget);
      adamStep(net, session.lr);
      session.steps += 1;
      return loss;
    },

    beginPredict() {
      squaredError = 0;
    },

    /** Predict rows y0..y1 of the picture into rgba, accumulating error and hidden-unit maps. */
    predictRows(y0, y1, rgba) {
      const end = y1 * size;
      for (let p0 = y0 * size; p0 < end; p0 += batch) {
        const n = Math.min(batch, end - p0);
        input.set(table.subarray(p0 * D, (p0 + n) * D));
        const out = forward(net, n);
        for (let i = 0; i < n; i++) {
          const p = p0 + i;
          const r = out[3 * i];
          const g = out[3 * i + 1];
          const b = out[3 * i + 2];
          const er = r - target[3 * p];
          const eg = g - target[3 * p + 1];
          const eb = b - target[3 * p + 2];
          squaredError += er * er + eg * eg + eb * eb;
          rgba[4 * p] = r * 255;
          rgba[4 * p + 1] = g * 255;
          rgba[4 * p + 2] = b * 255;
          rgba[4 * p + 3] = 255;
        }
        captureTiles(p0, n);
      }
    },

    /**
     * Finish a full prediction: writes the hidden-unit maps, each scaled by its own largest
     * magnitude into -1..1, and returns the mean squared error over the whole picture.
     */
    endPredict(tilesOut) {
      for (let t = 0; t < TILE_COUNT; t++) {
        const from = t * tileArea;
        let peak = 0;
        for (let q = from; q < from + tileArea; q++) {
          const mag = Math.abs(tileRaw[q]);
          if (mag > peak) peak = mag;
        }
        const k = peak > 0 ? 1 / peak : 0;
        for (let q = from; q < from + tileArea; q++) tilesOut[q] = tileRaw[q] * k;
      }
      return squaredError / (3 * pixels);
    },

    /**
     * Evaluate the network on a res × res grid over the square with corner (x0, y0) and side
     * span (all in 0..1). The grid can be far finer than the training pixels.
     */
    renderPatch(x0, y0, span, res, rgba) {
      const total = res * res;
      for (let p0 = 0; p0 < total; p0 += batch) {
        const n = Math.min(batch, total - p0);
        for (let i = 0; i < n; i++) {
          const p = p0 + i;
          const px = p % res;
          coords[2 * i] = x0 + ((px + 0.5) / res) * span;
          coords[2 * i + 1] = y0 + (((p - px) / res + 0.5) / res) * span;
        }
        encode(net, coords, n, input);
        const out = forward(net, n);
        for (let i = 0; i < n; i++) {
          const q = 4 * (p0 + i);
          rgba[q] = out[3 * i] * 255;
          rgba[q + 1] = out[3 * i + 1] * 255;
          rgba[q + 2] = out[3 * i + 2] * 255;
          rgba[q + 3] = 255;
        }
      }
    },
  };
  return session;
}
