// Pure simulation core (no DOM) so it can be unit-tested in Node.
import { rng } from '../../assets/js/kit.js';

export function createField(n, seed) {
  const r = rng(seed);
  const f = { n, x: new Float32Array(n), y: new Float32Array(n), vx: new Float32Array(n), vy: new Float32Array(n) };
  for (let i = 0; i < n; i++) {
    f.x[i] = r();
    f.y[i] = r();
    f.vx[i] = r.range(-0.2, 0.2);
    f.vy[i] = r.range(-0.2, 0.2);
  }
  return f;
}

export function stepField(f, target, pull, dt) {
  for (let i = 0; i < f.n; i++) {
    const dx = target.x - f.x[i];
    const dy = target.y - f.y[i];
    const d2 = dx * dx + dy * dy + 0.01;
    f.vx[i] = (f.vx[i] + (dx / d2) * pull * 0.02 * dt * 60) * 0.992;
    f.vy[i] = (f.vy[i] + (dy / d2) * pull * 0.02 * dt * 60) * 0.992;
    f.x[i] += f.vx[i] * dt;
    f.y[i] += f.vy[i] * dt;
  }
}
