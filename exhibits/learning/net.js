// net.js — a small multilayer perceptron on typed arrays: forward pass, backpropagation, Adam.
// Pure numerics with no DOM access, so it runs unchanged in a Worker, on the main thread and in Node.
//
// Layout: every parameter lives in one flat array. The weight from input k to output j of layer l
// is params[wOff[l] + k * nOut + j] (input-major). With that order a ReLU input that is exactly
// zero skips a whole contiguous row in the forward pass and in the backward pass, which removes
// roughly half of the arithmetic in the hidden layers.
import { rng } from '../../assets/js/kit.js';

export const ACTIVATIONS = ['relu', 'tanh'];
export const ADAM = { beta1: 0.9, beta2: 0.999, eps: 1e-8 };

const TWO_PI = Math.PI * 2;

/**
 * createNet({ hidden, activation, fourier, scale, seed, maxBatch, Float })
 *   hidden      widths of the hidden layers, e.g. [64, 64, 64]
 *   activation  'relu' (He initialisation) or 'tanh' (Xavier initialisation)
 *   fourier     number of random Fourier features m; the input becomes 2m values. 0 = raw (x, y)
 *   scale       standard deviation of the Gaussian frequency matrix, in cycles per image width
 *   maxBatch    largest batch the preallocated buffers can hold
 *   Float       Float32Array (default) or Float64Array (the reference path used by the tests)
 * The output layer always has three units behind a sigmoid: red, green, blue.
 */
export function createNet(options = {}) {
  const {
    hidden = [64, 64, 64],
    activation = 'relu',
    fourier = 0,
    scale = 10,
    seed = 1,
    maxBatch = 1024,
    Float = Float32Array,
  } = options;
  if (!ACTIVATIONS.includes(activation)) throw new Error(`Unknown activation "${activation}"`);
  const inDim = fourier > 0 ? 2 * fourier : 2;
  const sizes = [inDim, ...hidden, 3];
  const layers = sizes.length - 1;
  const wOff = [];
  const bOff = [];
  let count = 0;
  for (let l = 0; l < layers; l++) {
    wOff.push(count);
    count += sizes[l] * sizes[l + 1];
    bOff.push(count);
    count += sizes[l + 1];
  }
  const net = {
    sizes,
    layers,
    activation,
    relu: activation === 'relu',
    fourier,
    scale,
    inDim,
    maxBatch,
    count,
    wOff,
    bOff,
    params: new Float(count),
    grads: new Float(count),
    m: new Float(count),
    v: new Float(count),
    t: 0,
    freq: new Float(2 * fourier),
    acts: sizes.map((s) => new Float(maxBatch * s)),
    deltas: sizes.map((s, l) => new Float(l === 0 ? 0 : maxBatch * s)),
  };
  initWeights(net, seed);
  return net;
}

/**
 * Seeded initialisation. Hidden ReLU layers use He (variance 2 / fan-in); tanh layers and the
 * sigmoid output layer use Xavier (variance 2 / (fan-in + fan-out)). Hidden biases are uniform in
 * ±1 / sqrt(fan-in) so that, with raw coordinates, the first layer's hinge lines are spread over
 * the picture instead of all passing through its centre.
 */
export function initWeights(net, seed) {
  const r = rng(seed);
  const { sizes, layers, params, freq } = net;
  for (let k = 0; k < freq.length; k++) freq[k] = r.gauss() * net.scale;
  for (let l = 0; l < layers; l++) {
    const nIn = sizes[l];
    const nOut = sizes[l + 1];
    const last = l === layers - 1;
    const std = Math.sqrt(net.relu && !last ? 2 / nIn : 2 / (nIn + nOut));
    const w0 = net.wOff[l];
    const b0 = net.bOff[l];
    for (let i = 0; i < nIn * nOut; i++) params[w0 + i] = r.gauss() * std;
    const bound = 1 / Math.sqrt(nIn);
    for (let j = 0; j < nOut; j++) params[b0 + j] = last ? 0 : r.range(-bound, bound);
  }
  net.grads.fill(0);
  net.m.fill(0);
  net.v.fill(0);
  net.t = 0;
}

/**
 * Writes the network input for n points into out (n rows of net.inDim values).
 * coords holds u, v pairs in 0..1. Raw mode maps them to -1..1. Fourier mode writes
 * sin(2π B·p) for every row of the frequency matrix B, followed by cos(2π B·p).
 */
export function encode(net, coords, n, out) {
  const F = net.fourier;
  if (F === 0) {
    for (let i = 0; i < 2 * n; i++) out[i] = 2 * coords[i] - 1;
    return;
  }
  const freq = net.freq;
  const D = 2 * F;
  for (let i = 0; i < n; i++) {
    const u = coords[2 * i];
    const v = coords[2 * i + 1];
    const o = i * D;
    for (let k = 0; k < F; k++) {
      const phase = TWO_PI * (freq[2 * k] * u + freq[2 * k + 1] * v);
      out[o + k] = Math.sin(phase);
      out[o + F + k] = Math.cos(phase);
    }
  }
}

/** Forward pass over the first n rows of net.acts[0]. Returns the output buffer (n × 3, in 0..1). */
export function forward(net, n) {
  const { sizes, layers, params, acts, relu, wOff, bOff } = net;
  for (let l = 0; l < layers; l++) {
    const nIn = sizes[l];
    const nOut = sizes[l + 1];
    const a = acts[l];
    const z = acts[l + 1];
    const w0 = wOff[l];
    const b0 = bOff[l];
    for (let i = 0; i < n; i++) {
      const zo = i * nOut;
      const ao = i * nIn;
      for (let j = 0; j < nOut; j++) z[zo + j] = params[b0 + j];
      for (let k = 0; k < nIn; k++) {
        const x = a[ao + k];
        if (x === 0) continue;
        const wo = w0 + k * nOut;
        let j = 0;
        for (; j + 3 < nOut; j += 4) {
          z[zo + j] += x * params[wo + j];
          z[zo + j + 1] += x * params[wo + j + 1];
          z[zo + j + 2] += x * params[wo + j + 2];
          z[zo + j + 3] += x * params[wo + j + 3];
        }
        for (; j < nOut; j++) z[zo + j] += x * params[wo + j];
      }
    }
    const total = n * nOut;
    if (l === layers - 1) {
      for (let q = 0; q < total; q++) z[q] = 1 / (1 + Math.exp(-z[q]));
    } else if (relu) {
      for (let q = 0; q < total; q++) if (z[q] < 0) z[q] = 0;
    } else {
      for (let q = 0; q < total; q++) z[q] = Math.tanh(z[q]);
    }
  }
  return acts[layers];
}

/** Mean squared error of the last forward pass against target (n × 3). */
export function mseLoss(net, n, target) {
  const out = net.acts[net.layers];
  let sum = 0;
  for (let q = 0; q < 3 * n; q++) {
    const e = out[q] - target[q];
    sum += e * e;
  }
  return sum / (3 * n);
}

/**
 * Backpropagation for the last forward pass. Overwrites net.grads with the gradient of the
 * mean squared error and returns that error.
 */
export function backward(net, n, target) {
  const { sizes, layers, params, grads, acts, deltas, relu, wOff, bOff } = net;
  grads.fill(0);
  const out = acts[layers];
  const dOut = deltas[layers];
  const inv = 1 / (3 * n);
  let loss = 0;
  for (let q = 0; q < 3 * n; q++) {
    const y = out[q];
    const e = y - target[q];
    loss += e * e;
    dOut[q] = 2 * inv * e * y * (1 - y);
  }
  for (let l = layers - 1; l >= 0; l--) {
    const nIn = sizes[l];
    const nOut = sizes[l + 1];
    const a = acts[l];
    const d = deltas[l + 1];
    const dPrev = deltas[l];
    const w0 = wOff[l];
    const b0 = bOff[l];
    for (let i = 0; i < n; i++) {
      const dOff = i * nOut;
      const ao = i * nIn;
      for (let j = 0; j < nOut; j++) grads[b0 + j] += d[dOff + j];
      if (l === 0) {
        // The inputs need no gradient of their own, only the weights do.
        for (let k = 0; k < nIn; k++) {
          const x = a[ao + k];
          if (x === 0) continue;
          const wo = w0 + k * nOut;
          let j = 0;
          for (; j + 3 < nOut; j += 4) {
            grads[wo + j] += x * d[dOff + j];
            grads[wo + j + 1] += x * d[dOff + j + 1];
            grads[wo + j + 2] += x * d[dOff + j + 2];
            grads[wo + j + 3] += x * d[dOff + j + 3];
          }
          for (; j < nOut; j++) grads[wo + j] += x * d[dOff + j];
        }
        continue;
      }
      for (let k = 0; k < nIn; k++) {
        const x = a[ao + k];
        if (relu && x === 0) {
          // An inactive ReLU passes no gradient back and contributes none to its weights.
          dPrev[ao + k] = 0;
          continue;
        }
        const wo = w0 + k * nOut;
        let s0 = 0;
        let s1 = 0;
        let s2 = 0;
        let s3 = 0;
        let j = 0;
        for (; j + 3 < nOut; j += 4) {
          const d0 = d[dOff + j];
          const d1 = d[dOff + j + 1];
          const d2 = d[dOff + j + 2];
          const d3 = d[dOff + j + 3];
          grads[wo + j] += x * d0;
          grads[wo + j + 1] += x * d1;
          grads[wo + j + 2] += x * d2;
          grads[wo + j + 3] += x * d3;
          s0 += params[wo + j] * d0;
          s1 += params[wo + j + 1] * d1;
          s2 += params[wo + j + 2] * d2;
          s3 += params[wo + j + 3] * d3;
        }
        for (; j < nOut; j++) {
          const dj = d[dOff + j];
          grads[wo + j] += x * dj;
          s0 += params[wo + j] * dj;
        }
        const s = s0 + s1 + s2 + s3;
        dPrev[ao + k] = relu ? s : s * (1 - x * x);
      }
    }
  }
  return loss * inv;
}

/** One Adam update from net.grads, with bias-corrected first and second moments. */
export function adamStep(net, lr) {
  const { params, grads, m, v, count } = net;
  const { beta1, beta2, eps } = ADAM;
  net.t += 1;
  const c1 = 1 / (1 - Math.pow(beta1, net.t));
  const c2 = 1 / (1 - Math.pow(beta2, net.t));
  for (let i = 0; i < count; i++) {
    const g = grads[i];
    const mi = beta1 * m[i] + (1 - beta1) * g;
    const vi = beta2 * v[i] + (1 - beta2) * g * g;
    m[i] = mi;
    v[i] = vi;
    params[i] -= (lr * mi * c1) / (Math.sqrt(vi * c2) + eps);
  }
}
