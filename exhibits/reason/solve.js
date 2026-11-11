// Equation solving: exact roots for polynomials where a formula or a rational root exists,
// algebraic isolation when the unknown appears once, and numerical root-finding otherwise.
import { ZERO, NEG, TWO, HALF, E, int, isZero, isInt, toNumber, add, mul, pow, fn, neg, sub, div, exp, has, key } from './core.js';
import { coeffs, ratCoeffs, rationalRoots, pdeg, pgcd, pderiv, pdivmod } from './poly.js';
import { evalReal, findRoots } from './numeric.js';

const INVERSE = {
  ln: (t) => exp(t),
  sin: (t) => fn('asin', t),
  cos: (t) => fn('acos', t),
  tan: (t) => fn('atan', t),
  asin: (t) => fn('sin', t),
  acos: (t) => fn('cos', t),
  atan: (t) => fn('tan', t),
};
const PERIODIC = new Set(['sin', 'cos', 'tan']);

/** Undo the operations around a single occurrence of x. → list of solutions, or null */
function isolate(e, target, x, notes) {
  if (e === x) return [target];
  const split = (args) => [args.filter((a) => has(a, x)), args.filter((a) => !has(a, x))];
  if (e.t === 'add') {
    const [withX, without] = split(e.args);
    return withX.length === 1 ? isolate(withX[0], sub(target, add(...without)), x, notes) : null;
  }
  if (e.t === 'mul') {
    const [withX, without] = split(e.args);
    return withX.length === 1 ? isolate(withX[0], div(target, mul(...without)), x, notes) : null;
  }
  if (e.t === 'pow') {
    if (!has(e.exp, x)) {
      const root = pow(target, pow(e.exp, NEG));
      const plus = isolate(e.base, root, x, notes);
      if (!plus || !isInt(e.exp) || e.exp.n % 2n !== 0n) return plus;
      return [...plus, ...(isolate(e.base, neg(root), x, notes) || [])];
    }
    if (!has(e.base, x)) return isolate(e.exp, e.base === E ? fn('ln', target) : div(fn('ln', target), fn('ln', e.base)), x, notes);
    return null;
  }
  if (e.t === 'fn' && INVERSE[e.name]) {
    if (PERIODIC.has(e.name)) notes.add(`This is the principal solution; ${e.name} repeats, so there are infinitely many more.`);
    return isolate(e.arg, INVERSE[e.name](target), x, notes);
  }
  return null;
}

/**
 * solve(lhs, rhs, x) → { exact: expr[], approx: number[], all, none, notes: string[] }
 * exact solutions are symbolic; approx holds real roots found numerically.
 */
export function solve(lhs, rhs, x) {
  const f = sub(lhs, rhs);
  const notes = new Set();
  const out = { exact: [], approx: [], all: false, none: false, notes: [] };
  const done = () => {
    const seen = new Set();
    out.exact = out.exact.filter((s) => !seen.has(key(s)) && seen.add(key(s)));
    out.notes = [...notes];
    return out;
  };
  if (!has(f, x)) {
    out.all = isZero(f);
    out.none = !out.all;
    return done();
  }

  const quadratic = ([c, b, a]) => {
    const disc = sub(pow(b, TWO), mul(int(4), a, c));
    if (isZero(disc)) return [div(neg(b), mul(TWO, a))];
    const root = pow(disc, HALF);
    return [div(add(neg(b), root), mul(TWO, a)), div(sub(neg(b), root), mul(TWO, a))];
  };

  const p = ratCoeffs(f, x);
  if (p) {
    if (p.length === 1) {
      // the two sides differ by a constant: always equal, or never
      out.all = isZero(p[0]);
      out.none = !out.all;
      return done();
    }
    const { roots, rest } = rationalRoots(p);
    out.exact.push(...roots);
    // A repeated root does not change the sign, so a scan would miss it. The square-free part
    // has the same roots, each once.
    const g = pgcd(rest, pderiv(rest));
    const simple = pdeg(g) > 0 ? pdivmod(rest, g)[0] : rest;
    if (pdeg(simple) === 2) out.exact.push(...quadratic(simple));
    else if (pdeg(simple) > 2) {
      // Cauchy's bound: every root lies within 1 + max|aᵢ/aₙ| of zero
      const lead = Math.abs(toNumber(simple[simple.length - 1]));
      const bound = 1 + Math.max(...simple.slice(0, -1).map((c) => Math.abs(toNumber(c)) / lead));
      const poly = (t) => simple.reduceRight((acc, c) => acc * t + toNumber(c), 0);
      out.approx.push(...findRoots(poly, -bound, bound, 20000));
      notes.add(`The remaining factor has degree ${pdeg(simple)} and no rational roots, so its real roots are numerical.`);
    }
    return done();
  }

  const c = coeffs(f, x);
  if (c && c.length === 2) out.exact.push(neg(div(c[0], c[1])));
  else if (c && c.length === 3) out.exact.push(...quadratic(c));
  else {
    const found = isolate(f, ZERO, x, notes);
    if (found) out.exact.push(...found);
    else {
      notes.clear();
      out.approx.push(...findRoots((t) => evalReal(f, { [x.name]: t }), -20, 20));
      notes.add('No exact method applied, so these are the real roots between −20 and 20, found numerically.');
    }
  }
  return done();
}
