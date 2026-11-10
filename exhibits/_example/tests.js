import { assert, equal, near } from '../../assets/js/check.js';
import { createField, stepField } from './field.js';

export default [
  {
    name: 'same seed gives the same field',
    fn() {
      equal(createField(16, 3).x, createField(16, 3).x);
    },
  },
  {
    name: 'particles move toward the target',
    fn() {
      const f = createField(64, 1);
      const dist = () => { let s = 0; for (let i = 0; i < f.n; i++) s += Math.hypot(f.x[i] - 0.5, f.y[i] - 0.5); return s / f.n; };
      const before = dist();
      for (let i = 0; i < 120; i++) stepField(f, { x: 0.5, y: 0.5 }, 1, 1 / 60);
      assert(dist() < before, 'mean distance should shrink');
    },
  },
  {
    name: 'zero pull only applies drag',
    fn() {
      const f = createField(1, 5);
      const v0 = f.vx[0];
      stepField(f, { x: 0, y: 0 }, 0, 1 / 60);
      near(f.vx[0], v0 * 0.992, 1e-6);
    },
  },
  {
    name: 'canvas 2D is available',
    browser: true,
    fn() {
      assert(document.createElement('canvas').getContext('2d'), '2D context');
    },
  },
];
