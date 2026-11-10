// Numbers: evaluating an expression in complex floating point, and the numerical tools the
// exhibit uses to check its own symbolic answers (sampling, differences, quadrature, roots).
import { toNumber, variables, E, PI, I } from './core.js';
import { rng } from '../../assets/js/kit.js';

const cmul = (a, b) => [a[0] * b[0] - a[1] * b[1], a[0] * b[1] + a[1] * b[0]];
const cdiv = (a, b) => {
  const m = b[0] * b[0] + b[1] * b[1];
  return [(a[0] * b[0] + a[1] * b[1]) / m, (a[1] * b[0] - a[0] * b[1]) / m];
};
const cexp = (a) => [Math.exp(a[0]) * Math.cos(a[1]), Math.exp(a[0]) * Math.sin(a[1])];
const clog = (a) => [Math.log(Math.hypot(a[0], a[1])), Math.atan2(a[1], a[0])];

function cpow(a, b) {
  if (b[1] === 0 && a[1] === 0 && (a[0] >= 0 || Number.isInteger(b[0]))) return [Math.pow(a[0], b[0]), 0];
  if (b[1] === 0 && Number.isInteger(b[0]) && Math.abs(b[0]) <= 32) {
    let out = [1, 0];
    for (let i = 0; i < Math.abs(b[0]); i++) out = cmul(out, a);
    return b[0] < 0 ? cdiv([1, 0], out) : out;
  }
  if (a[0] === 0 && a[1] === 0) return b[0] > 0 ? [0, 0] : [NaN, NaN];
  return cexp(cmul(b, clog(a)));
}

const REAL = { asin: Math.asin, acos: Math.acos, atan: Math.atan };
function cfn(name, z) {
  const [x, y] = z;
  switch (name) {
    case 'sin':
      return [Math.sin(x) * Math.cosh(y), Math.cos(x) * Math.sinh(y)];
    case 'cos':
      return [Math.cos(x) * Math.cosh(y), -Math.sin(x) * Math.sinh(y)];
    case 'tan':
      return cdiv(cfn('sin', z), cfn('cos', z));
    case 'sinh':
      return [Math.sinh(x) * Math.cos(y), Math.cosh(x) * Math.sin(y)];
    case 'cosh':
      return [Math.cosh(x) * Math.cos(y), Math.sinh(x) * Math.sin(y)];
    case 'tanh':
      return cdiv(cfn('sinh', z), cfn('cosh', z));
    case 'ln':
      return clog(z);
    case 'abs':
      return [Math.hypot(x, y), 0];
    default:
      return y === 0 ? [REAL[name](x), 0] : [NaN, NaN];
  }
}

/** Value of an expression as a complex number [re, im]. env maps variable names to numbers. */
export function evalC(e, env = {}) {
  switch (e.t) {
    case 'num':
      return [toNumber(e), 0];
    case 'flt':
      return [e.v, 0];
    case 'sym': {
      if (e === E) return [Math.E, 0];
      if (e === PI) return [Math.PI, 0];
      if (e === I) return [0, 1];
      const v = env[e.name];
      if (v === undefined) return [NaN, NaN];
      return typeof v === 'number' ? [v, 0] : v;
    }
    case 'add': {
      let re = 0;
      let im = 0;
      for (const a of e.args) {
        const v = evalC(a, env);
        re += v[0];
        im += v[1];
      }
      return [re, im];
    }
    case 'mul': {
      let out = [1, 0];
      for (const a of e.args) out = cmul(out, evalC(a, env));
      return out;
    }
    case 'pow':
      return cpow(evalC(e.base, env), evalC(e.exp, env));
    default:
      return cfn(e.name, evalC(e.arg, env));
  }
}

/** Real value, or NaN when the value is not real (or not defined). */
export function evalReal(e, env = {}) {
  const [re, im] = evalC(e, env);
  return Math.abs(im) <= 1e-9 * (1 + Math.abs(re)) ? re : NaN;
}

const close = (a, b, tol) => Math.abs(a - b) <= tol * (1 + Math.abs(a) + Math.abs(b));

function* samples(names, seed) {
  const r = rng(seed);
  for (let i = 0; i < 160; i++) {
    const env = {};
    // alternate between a symmetric range and a positive one, where logs and roots are defined
    for (const n of names) env[n] = i % 2 ? r.range(0.3, 2.2) : r.range(-2.4, 2.4);
    yield env;
  }
}

/**
 * Do two expressions have the same value? Compared at random real points where both are defined.
 * → { ok: true | false | null, points }   (null: too few points where both are defined)
 */
export function agree(a, b, { points = 12, tol = 1e-7, seed = 11 } = {}) {
  const names = [...new Set([...variables(a), ...variables(b)])];
  let valid = 0;
  for (const env of samples(names, seed)) {
    const va = evalReal(a, env);
    const vb = evalReal(b, env);
    if (!Number.isFinite(va) || !Number.isFinite(vb)) continue;
    if (!close(va, vb, tol)) return { ok: false, points: valid, at: env };
    if (++valid >= points) break;
    if (names.length === 0) break;
  }
  return { ok: valid >= Math.min(points, names.length ? 4 : 1) ? true : null, points: valid };
}

/** Five-point central difference. */
export function slope(f, x0, scale = 1) {
  const h = 1e-3 * scale * (1 + Math.abs(x0));
  return (f(x0 - 2 * h) - 8 * f(x0 - h) + 8 * f(x0 + h) - f(x0 + 2 * h)) / (12 * h);
}

/** Is df the derivative of f with respect to the variable named v? Same result shape as agree(). */
export function checkDerivative(f, df, v, { points = 12, seed = 23 } = {}) {
  const names = [...new Set([...variables(f), ...variables(df), v])];
  let valid = 0;
  for (const env of samples(names, seed)) {
    const at = (t) => evalReal(f, { ...env, [v]: t });
    const numeric = slope(at, env[v]);
    const symbolic = evalReal(df, env);
    if (!Number.isFinite(numeric) || !Number.isFinite(symbolic)) continue;
    // near a pole or a kink the difference quotient itself is unreliable: two step sizes must agree first
    if (!close(numeric, slope(at, env[v], 0.5), 1e-6)) continue;
    if (!close(numeric, symbolic, 1e-4)) return { ok: false, points: valid, at: env };
    if (++valid >= points) break;
  }
  return { ok: valid >= 4 ? true : null, points: valid };
}

/** Adaptive Simpson quadrature → { value, ok } (ok is false when it did not converge). */
export function quadrature(f, a, b, tol = 1e-10) {
  let ok = true;
  const simpson = (fa, fm, fb, h) => ((fa + 4 * fm + fb) * h) / 6;
  const recurse = (lo, hi, fl, fm, fh, whole, eps, depth) => {
    const mid = (lo + hi) / 2;
    const flm = f((lo + mid) / 2);
    const fmh = f((mid + hi) / 2);
    const left = simpson(fl, flm, fm, mid - lo);
    const right = simpson(fm, fmh, fh, hi - mid);
    const delta = left + right - whole;
    if (!Number.isFinite(delta)) {
      ok = false;
      return NaN;
    }
    if (depth <= 0) {
      if (Math.abs(delta) > 1e-6 * (1 + Math.abs(whole))) ok = false;
      return left + right + delta / 15;
    }
    if (Math.abs(delta) <= 15 * eps) return left + right + delta / 15;
    return recurse(lo, mid, fl, flm, fm, left, eps / 2, depth - 1) + recurse(mid, hi, fm, fmh, fh, right, eps / 2, depth - 1);
  };
  const sign = a <= b ? 1 : -1;
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  // 16 panels first, so that a narrow feature is not missed by the very first estimate
  let total = 0;
  for (let i = 0; i < 16 && ok; i++) {
    const p = lo + ((hi - lo) * i) / 16;
    const q = lo + ((hi - lo) * (i + 1)) / 16;
    const fp = f(p);
    const fq = f(q);
    const fm = f((p + q) / 2);
    total += recurse(p, q, fp, fm, fq, simpson(fp, fm, fq, q - p), tol / 16, 26);
  }
  return { value: sign * total, ok: ok && Number.isFinite(total) };
}

/** Real roots of f on [lo, hi]: scan for sign changes, then bisect. */
export function findRoots(f, lo, hi, cells = 4000) {
  const roots = [];
  const push = (r) => {
    if (!roots.some((x) => Math.abs(x - r) < 1e-7 * (1 + Math.abs(r)))) roots.push(r);
  };
  let x0 = lo;
  let f0 = f(x0);
  for (let i = 1; i <= cells; i++) {
    const x1 = lo + ((hi - lo) * i) / cells;
    const f1 = f(x1);
    if (Number.isFinite(f0) && Number.isFinite(f1)) {
      if (f0 === 0) push(x0);
      else if (f0 * f1 < 0) {
        let a = x0;
        let b = x1;
        let fa = f0;
        for (let k = 0; k < 80; k++) {
          const m = (a + b) / 2;
          const fm = f(m);
          if (!Number.isFinite(fm)) break;
          if (fa * fm <= 0) b = m;
          else {
            a = m;
            fa = fm;
          }
        }
        const r = (a + b) / 2;
        // a sign change across a pole is not a root
        if (Math.abs(f(r)) < 1e-6 * (1 + Math.abs(f0) + Math.abs(f1))) push(r);
      }
    }
    x0 = x1;
    f0 = f1;
  }
  if (f0 === 0) push(x0);
  return roots.sort((a, b) => a - b);
}
