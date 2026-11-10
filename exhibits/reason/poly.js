// Polynomials in one variable with exact rational coefficients, stored lowest degree first:
// x² − 1 is [−1, 0, 1]. Division, gcd, rational roots, and factorisation over the rationals.
import { ZERO, ONE, num, int, isZero, isNum, isInt, nadd, nmul, nneg, ninv, gcd, factorInt, add, mul, pow, has, expand } from './core.js';

/** Coefficients of e as a polynomial in x (each one an expression free of x), or null. */
export function coeffs(e, x) {
  let ex;
  try {
    ex = expand(e);
  } catch {
    return null;
  }
  const out = [ZERO];
  for (const term of ex.t === 'add' ? ex.args : [ex]) {
    let deg = 0;
    const rest = [];
    for (const f of term.t === 'mul' ? term.args : [term]) {
      if (f === x) deg += 1;
      else if (f.t === 'pow' && f.base === x && isInt(f.exp) && f.exp.n > 0n && f.exp.n <= 200n) deg += Number(f.exp.n);
      else if (has(f, x)) return null;
      else rest.push(f);
    }
    while (out.length <= deg) out.push(ZERO);
    out[deg] = add(out[deg], mul(...rest));
  }
  while (out.length > 1 && isZero(out[out.length - 1])) out.pop();
  return out;
}

/** Same, but only when every coefficient is a rational number. */
export function ratCoeffs(e, x) {
  const c = coeffs(e, x);
  return c && c.every(isNum) ? c : null;
}

const trim = (p) => {
  while (p.length > 1 && isZero(p[p.length - 1])) p.pop();
  return p;
};
export const pdeg = (p) => p.length - 1;
export const pzero = (p) => p.length === 1 && isZero(p[0]);
export const padd = (a, b) => trim(Array.from({ length: Math.max(a.length, b.length) }, (_, i) => nadd(a[i] || ZERO, b[i] || ZERO)));
export const pscale = (a, c) => trim(a.map((x) => nmul(x, c)));
export function pmul(a, b) {
  const out = Array(a.length + b.length - 1).fill(ZERO);
  a.forEach((x, i) => b.forEach((y, j) => (out[i + j] = nadd(out[i + j], nmul(x, y)))));
  return trim(out);
}
export function pdivmod(a, b) {
  if (pzero(b)) throw new Error('polynomial division by zero');
  const r = [...a];
  const q = Array(Math.max(1, a.length - b.length + 1)).fill(ZERO);
  const lead = ninv(b[b.length - 1]);
  for (let i = a.length - b.length; i >= 0; i--) {
    const c = nmul(r[i + b.length - 1], lead);
    q[i] = c;
    if (!isZero(c)) for (let j = 0; j < b.length; j++) r[i + j] = nadd(r[i + j], nneg(nmul(c, b[j])));
  }
  return [trim(q), trim(r.slice(0, Math.max(1, b.length - 1)))];
}
/** Monic greatest common divisor. */
export function pgcd(a, b) {
  while (!pzero(b)) [a, b] = [b, pdivmod(a, b)[1]];
  return pscale(a, ninv(a[a.length - 1]));
}
export const pderiv = (p) => (p.length === 1 ? [ZERO] : p.slice(1).map((c, i) => nmul(c, int(i + 1))));
export const peval = (p, x) => p.reduceRight((acc, c) => nadd(nmul(acc, x), c), ZERO);
export const pexpr = (p, x) => add(...p.map((c, i) => mul(c, pow(x, int(i)))));

function divisors(n) {
  let out = [1n];
  for (const [prime, count] of factorInt(n)) {
    const next = [];
    let power = 1n;
    for (let k = 0n; k <= count; k++) {
      for (const d of out) next.push(d * power);
      power *= prime;
    }
    out = next;
    if (out.length > 3000) break;
  }
  return out;
}

/** Scale to integer coefficients with no common factor → { ints: BigInt[], scale: num } with p = scale · ints. */
function primitive(p) {
  const den = p.reduce((l, c) => (l * c.d) / gcd(l, c.d), 1n);
  let ints = p.map((c) => (c.n * den) / c.d);
  let g = ints.reduce((acc, c) => gcd(acc, c), 0n) || 1n;
  if (ints[ints.length - 1] < 0n) g = -g;
  ints = ints.map((c) => c / g);
  return { ints, scale: num(g, den) };
}

/**
 * Rational roots, with multiplicity. Each root a/b is divided out as the factor (b·x − a), so the
 * remaining polynomial keeps integer coefficients. → { roots: num[], rest: num[] }
 */
export function rationalRoots(p) {
  let rest = primitive(p).ints.map(int);
  const roots = [];
  while (pdeg(rest) >= 1 && isZero(rest[0])) {
    roots.push(ZERO);
    rest = rest.slice(1);
  }
  search: while (pdeg(rest) >= 1) {
    const a0 = rest[0].n < 0n ? -rest[0].n : rest[0].n;
    const an = rest[rest.length - 1].n < 0n ? -rest[rest.length - 1].n : rest[rest.length - 1].n;
    if (a0 > 10n ** 14n || an > 10n ** 14n) break;
    const tops = divisors(a0);
    const bottoms = divisors(an);
    if (tops.length * bottoms.length > 40000) break;
    for (const b of bottoms) {
      for (const a of tops) {
        if (gcd(a, b) !== 1n) continue;
        for (const r of [num(a, b), num(-a, b)]) {
          if (!isZero(peval(rest, r))) continue;
          roots.push(r);
          rest = pdivmod(rest, [int(-r.n), int(r.d)])[0];
          continue search;
        }
      }
    }
    break;
  }
  return { roots, rest };
}

/** Try to split an integer quartic into two integer quadratics. → [quadratic, quadratic] or null */
function splitQuartic(q) {
  const [a0, a1, a2, a3, a4] = q.map((c) => c.n);
  const signed = (n) => divisors(n < 0n ? -n : n).flatMap((d) => [d, -d]);
  if (a0 === 0n) return null;
  for (const p of divisors(a4)) {
    const s = a4 / p;
    for (const r of signed(a0)) {
      const u = a0 / r;
      // (p x² + q x + r)(s x² + t x + u): match the x³ and x coefficients, then test x²
      const det = s * r - p * u;
      const tryQT = (qq, t) => (p * t + qq * s === a3 && qq * u + r * t === a1 && p * u + qq * t + r * s === a2 ? [[int(r), int(qq), int(p)], [int(u), int(t), int(s)]] : null);
      if (det !== 0n) {
        const qn = a3 * r - p * a1;
        const tn = s * a1 - u * a3;
        if (qn % det === 0n && tn % det === 0n) {
          const found = tryQT(qn / det, tn / det);
          if (found) return found;
        }
      } else {
        for (let qq = -60n; qq <= 60n; qq++) {
          if ((a3 - s * qq) % p !== 0n) continue;
          const found = tryQT(qq, (a3 - s * qq) / p);
          if (found) return found;
        }
      }
    }
  }
  return null;
}

/**
 * Factor over the rationals. → { content: num, factors: [{ p: num[] (integer coefficients), mult }] }
 * Finds every linear factor, and splits a remaining quartic into quadratics when it can.
 */
export function factorPoly(p) {
  const { roots, rest } = rationalRoots(p);
  const factors = [];
  const sorted = [...roots].sort((a, b) => (a.n * b.d < b.n * a.d ? -1 : 1));
  for (const r of sorted) {
    const f = [int(-r.n), int(r.d)];
    const last = factors[factors.length - 1];
    if (last && last.p.length === 2 && last.p[0].n === f[0].n && last.p[1].n === f[1].n) last.mult++;
    else factors.push({ p: f, mult: 1 });
  }
  let pieces = pdeg(rest) >= 1 ? [rest] : [];
  if (pdeg(rest) === 4) pieces = splitQuartic(rest) || pieces;
  for (const piece of pieces) {
    const twin = factors.find((f) => f.p.length === piece.length && f.p.every((c, i) => c.n === piece[i].n));
    if (twin) twin.mult++;
    else factors.push({ p: piece, mult: 1 });
  }
  // whatever constant the factors do not account for is the content
  const leads = factors.reduce((acc, f) => nmul(acc, pow(f.p[f.p.length - 1], int(f.mult))), ONE);
  const content = nmul(p[p.length - 1], ninv(leads));
  return { content, factors };
}
