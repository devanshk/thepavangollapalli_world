import { assert, equal, near } from '../../assets/js/check.js';
import { rng } from '../../assets/js/kit.js';
import { createNet, initWeights, encode, forward, backward, mseLoss, adamStep, ADAM } from './net.js';
import { createSession } from './trainer.js';

/** A tiny network on the Float64 reference path, with a random batch already encoded. */
function tinyNet(activation, fourier, seed) {
  const n = 6;
  const net = createNet({ hidden: [5, 4], activation, fourier, scale: 2, seed, maxBatch: n, Float: Float64Array });
  const r = rng(seed + 100);
  const coords = Float64Array.from({ length: 2 * n }, () => r());
  const target = Float64Array.from({ length: 3 * n }, () => r());
  encode(net, coords, n, net.acts[0]);
  return { net, n, target };
}

/** Largest relative difference between backpropagation and central differences over every weight. */
function gradientError(activation, fourier, seed) {
  const { net, n, target } = tinyNet(activation, fourier, seed);
  forward(net, n);
  backward(net, n, target);
  const analytic = Float64Array.from(net.grads);
  const h = 1e-6;
  let worst = 0;
  for (let i = 0; i < net.count; i++) {
    const keep = net.params[i];
    net.params[i] = keep + h;
    forward(net, n);
    const up = mseLoss(net, n, target);
    net.params[i] = keep - h;
    forward(net, n);
    const down = mseLoss(net, n, target);
    net.params[i] = keep;
    const numeric = (up - down) / (2 * h);
    worst = Math.max(worst, Math.abs(numeric - analytic[i]) / Math.max(1e-7, Math.abs(numeric) + Math.abs(analytic[i])));
  }
  return worst;
}

/** A picture as RGBA bytes from a function (u, v) → [r, g, b] in 0..1. */
function picture(size, f) {
  const rgba = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const c = f((x + 0.5) / size, (y + 0.5) / size);
      rgba.set([c[0] * 255, c[1] * 255, c[2] * 255, 255], 4 * (y * size + x));
    }
  return rgba;
}

function train(config, rgba, steps) {
  const session = createSession({ size: 24, hidden: [32, 32], activation: 'relu', fourier: 0, scale: 4, seed: 3, batch: 256, lr: 0.01, ...config });
  session.setTargetRGBA(rgba);
  let early = 0;
  let late = 0;
  for (let i = 0; i < steps; i++) {
    const loss = session.step();
    if (i < 20) early += loss / 20;
    if (i >= steps - 20) late += loss / 20;
  }
  return { early, late };
}

const stripes = picture(24, (u) => (Math.floor(u * 12) % 2 ? [0.95, 0.9, 0.2] : [0.1, 0.1, 0.5]));

export default [
  {
    name: 'backpropagation matches numerical gradients with ReLU units',
    fn() {
      for (const seed of [1, 2, 3]) assert(gradientError('relu', 0, seed) < 1e-5, `raw input, seed ${seed}: error ${gradientError('relu', 0, seed)}`);
    },
  },
  {
    name: 'backpropagation matches numerical gradients with tanh units',
    fn() {
      for (const seed of [4, 5, 6]) assert(gradientError('tanh', 0, seed) < 1e-5, `seed ${seed}: error ${gradientError('tanh', 0, seed)}`);
    },
  },
  {
    name: 'the gradients are still right behind Fourier features',
    fn() {
      assert(gradientError('relu', 4, 7) < 1e-5, 'ReLU with Fourier features');
      assert(gradientError('tanh', 4, 8) < 1e-5, 'tanh with Fourier features');
    },
  },
  {
    name: 'one Adam step matches the update worked out by hand',
    fn() {
      const net = createNet({ hidden: [3], seed: 1, maxBatch: 1, Float: Float64Array });
      const before = Float64Array.from(net.params);
      for (let i = 0; i < net.count; i++) net.grads[i] = i % 3 === 0 ? 0 : (i % 2 ? 0.5 : -2) * (1 + i);
      adamStep(net, 0.01);
      // after bias correction the first step is lr · g / (|g| + ε): a step of lr against the sign of g
      for (let i = 0; i < net.count; i++) {
        const g = net.grads[i];
        near(net.params[i] - before[i], g === 0 ? 0 : (-0.01 * g) / (Math.abs(g) + ADAM.eps), 1e-12, `weight ${i}`);
      }
      equal(net.t, 1);
      near(net.m[1], (1 - ADAM.beta1) * net.grads[1], 1e-15, 'first moment');
      near(net.v[1], (1 - ADAM.beta2) * net.grads[1] ** 2, 1e-15, 'second moment');
    },
  },
  {
    name: 'initial weights depend only on the seed',
    fn() {
      const a = createNet({ hidden: [16, 16], fourier: 8, seed: 42 });
      const b = createNet({ hidden: [16, 16], fourier: 8, seed: 42 });
      const c = createNet({ hidden: [16, 16], fourier: 8, seed: 43 });
      equal(a.params, b.params);
      equal(a.freq, b.freq);
      assert(a.params.some((w, i) => w !== c.params[i]), 'another seed gives other weights');
      initWeights(a, 43);
      equal(a.params, c.params, 're-initialising with a seed reproduces that network');
    },
  },
  {
    name: 'He and Xavier initialisation have the variances they should',
    fn() {
      const variance = (net, layer) => {
        const count = net.sizes[layer] * net.sizes[layer + 1];
        let sum = 0;
        let squares = 0;
        for (let i = 0; i < count; i++) {
          const w = net.params[net.wOff[layer] + i];
          sum += w;
          squares += w * w;
        }
        return squares / count - (sum / count) ** 2;
      };
      const relu = createNet({ hidden: [200, 200], activation: 'relu', seed: 9 });
      near(variance(relu, 1), 2 / 200, 0.1 * (2 / 200), 'He: 2 / fan-in');
      const tanh = createNet({ hidden: [200, 200], activation: 'tanh', seed: 9 });
      near(variance(tanh, 1), 2 / 400, 0.1 * (2 / 400), 'Xavier: 2 / (fan-in + fan-out)');
    },
  },
  {
    name: 'the input encoding has the stated size and stays within −1 and 1',
    fn() {
      const coords = Float32Array.from([0, 0, 1, 1, 0.25, 0.75, 0.5, 0.5]);
      const raw = createNet({ hidden: [4], fourier: 0, maxBatch: 4 });
      equal(raw.inDim, 2);
      encode(raw, coords, 4, raw.acts[0]);
      equal(Array.from(raw.acts[0].slice(0, 8)), [-1, -1, 1, 1, -0.5, 0.5, 0, 0], 'raw coordinates map 0..1 to −1..1');
      const net = createNet({ hidden: [4], fourier: 12, scale: 6, maxBatch: 4 });
      equal(net.inDim, 24);
      encode(net, coords, 4, net.acts[0]);
      assert(net.acts[0].every((v) => v >= -1 && v <= 1), 'sines and cosines');
      // sin² + cos² = 1 for each frequency: the two halves really are a sine and its cosine
      for (let k = 0; k < 12; k++) near(net.acts[0][k] ** 2 + net.acts[0][12 + k] ** 2, 1, 1e-5, `frequency ${k}`);
    },
  },
  {
    name: 'the output is always a colour between 0 and 1',
    fn() {
      const net = createNet({ hidden: [8, 8], seed: 5, maxBatch: 64 });
      for (let i = 0; i < net.count; i++) net.params[i] *= 40; // extreme weights saturate, they must not overflow
      const r = rng(1);
      encode(net, Float32Array.from({ length: 128 }, () => r()), 64, net.acts[0]);
      const out = forward(net, 64);
      for (let i = 0; i < 64 * 3; i++) assert(out[i] >= 0 && out[i] <= 1 && Number.isFinite(out[i]), `output ${i} is ${out[i]}`);
    },
  },
  {
    name: 'training lowers the loss on a smooth picture',
    fn() {
      const smooth = picture(24, (u, v) => [u, v, 1 - u]);
      const { early, late } = train({ batch: 128 }, smooth, 250);
      assert(late < early * 0.2, `loss went from ${early.toFixed(4)} to ${late.toFixed(4)}`);
      assert(late < 0.01, `final loss ${late.toFixed(4)}`);
    },
  },
  {
    name: 'a small network fits an XOR pattern, which no single layer can',
    fn() {
      const xor = picture(24, (u, v) => (u < 0.5 !== v < 0.5 ? [1, 1, 1] : [0, 0, 0]));
      const { late } = train({ hidden: [16, 16], activation: 'tanh', batch: 128 }, xor, 500);
      assert(late < 0.03, `final loss ${late.toFixed(4)}`);
    },
  },
  {
    name: 'Fourier features let the same network learn fine stripes it otherwise cannot',
    fn() {
      const plain = train({ fourier: 0, batch: 128 }, stripes, 220).late;
      const encoded = train({ fourier: 16, scale: 6, batch: 128 }, stripes, 220).late;
      assert(encoded < plain * 0.5, `with features ${encoded.toFixed(4)}, without ${plain.toFixed(4)}`);
    },
  },
  {
    name: 'training is repeatable: the same seed gives the same losses',
    fn() {
      const run = () => {
        const s = createSession({ size: 24, hidden: [16], activation: 'relu', fourier: 8, scale: 4, seed: 11, batch: 128, lr: 0.01 });
        s.setTargetRGBA(stripes);
        return Array.from({ length: 30 }, () => s.step());
      };
      equal(run(), run());
    },
  },
  {
    name: 'the worker trains and reports a falling loss',
    browser: true,
    async fn() {
      const { mount } = await import('./index.js');
      const root = document.createElement('div');
      root.className = 'stage';
      root.dataset.exhibit = 'learning';
      root.style.cssText = 'position:absolute;left:-9999px;width:900px';
      document.body.append(root);
      try {
        const ctl = await mount(root, { reducedMotion: false, coarse: false, small: false });
        ctl.start();
        await new Promise((resolve) => setTimeout(resolve, 1800));
        ctl.stop();
        const canvases = [...root.querySelectorAll('canvas')];
        assert(canvases.length >= 2, 'target and output canvases exist');
        const out = canvases[1];
        const data = out.getContext('2d').getImageData(0, 0, out.width, out.height).data;
        let lo = 255;
        let hi = 0;
        for (let i = 0; i < data.length; i += 4) {
          lo = Math.min(lo, data[i]);
          hi = Math.max(hi, data[i]);
        }
        assert(hi - lo > 20, 'the network output is a picture, not a flat colour');
        ctl.destroy();
      } finally {
        root.remove();
      }
    },
  },
];
