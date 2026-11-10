// Calculus on canonical expressions: differentiation with a recorded derivation, a transparent
// heuristic integrator, Taylor series, and the simplifier that tidies their results.
import { MathError, ZERO, ONE, NEG, TWO, HALF, E, int, num, sym, isNum, isInt, isZero, isOne, nadd, nmul, nneg, ninv, add, mul, pow, fn, neg, sub, div, sqrt, has, same, key, size, subs, map, expand, variables } from './core.js';
import { coeffs, ratCoeffs, pdivmod, pgcd, pderiv, peval, pexpr, pmul, padd, pscale, pzero, pdeg, rationalRoots } from './poly.js';

/* ───────── differentiation ───────── */

const DERIVATIVE = {
  sin: (u) => fn('cos', u),
  cos: (u) => neg(fn('sin', u)),
  tan: (u) => pow(fn('cos', u), int(-2)),
  asin: (u) => pow(sub(ONE, pow(u, TWO)), num(-1n, 2n)),
  acos: (u) => neg(pow(sub(ONE, pow(u, TWO)), num(-1n, 2n))),
  atan: (u) => pow(add(ONE, pow(u, TWO)), NEG),
  sinh: (u) => fn('cosh', u),
  cosh: (u) => fn('sinh', u),
  tanh: (u) => pow(fn('cosh', u), int(-2)),
  ln: (u) => pow(u, NEG),
  abs: (u) => mul(u, pow(fn('abs', u), NEG)),
};

/**
 * diff(e, x, steps?) → de/dx. If `steps` is an array, each rule applied is recorded in it as
 * { rule, expr, result }, outermost first.
 */
export function diff(e, x, steps = null) {
  const rule = (name, expr, compute) => {
    if (!steps) return compute();
    const at = steps.length;
    const result = compute();
    steps.splice(at, 0, { rule: name, expr, result, v: x.name });
    return result;
  };
  const d = (u) => {
    if (!has(u, x)) return ZERO;
    if (u === x) return ONE;
    switch (u.t) {
      case 'add':
        return rule('Sum rule: differentiate each term', u, () => add(...u.args.map(d)));
      case 'mul': {
        const fixed = u.args.filter((a) => !has(a, x));
        const moving = u.args.filter((a) => has(a, x));
        if (fixed.length) return rule('Constant factor: (c·u)′ = c·u′', u, () => mul(...fixed, d(mul(...moving))));
        const below = moving.filter((f) => f.t === 'pow' && isNum(f.exp) && f.exp.n < 0n);
        if (below.length && below.length < moving.length) {
          const top = mul(...moving.filter((f) => !below.includes(f)));
          const bottom = mul(...below.map((f) => pow(f, NEG)));
          return rule('Quotient rule: (u/v)′ = (u′v − uv′)/v²', u, () => mul(sub(mul(d(top), bottom), mul(top, d(bottom))), pow(bottom, int(-2))));
        }
        return rule('Product rule: (uv)′ = u′v + uv′', u, () => add(...moving.map((f, i) => mul(d(f), ...moving.filter((_, j) => j !== i)))));
      }
      case 'pow': {
        const { base, exp } = u;
        if (!has(exp, x))
          return rule(base === x ? 'Power rule: (xⁿ)′ = n·xⁿ⁻¹' : 'Power rule with the chain rule: (uⁿ)′ = n·uⁿ⁻¹·u′', u, () => mul(exp, pow(base, add(exp, NEG)), d(base)));
        if (!has(base, x))
          return rule(base === E ? 'Exponential: (eᵘ)′ = eᵘ·u′' : 'Exponential: (aᵘ)′ = aᵘ·ln(a)·u′', u, () => mul(u, fn('ln', base), d(exp)));
        return rule('Logarithmic differentiation: (uᵛ)′ = uᵛ·(v′·ln u + v·u′/u)', u, () => mul(u, add(mul(d(exp), fn('ln', base)), mul(exp, d(base), pow(base, NEG)))));
      }
      default: {
        if (!DERIVATIVE[u.name]) throw new MathError(`I do not know the derivative of ${u.name}`);
        return rule(u.arg === x ? `Derivative of ${u.name}` : `Chain rule: differentiate ${u.name}, then multiply by the derivative of its inside`, u, () => mul(DERIVATIVE[u.name](u.arg), d(u.arg)));
      }
    }
  };
  return d(e);
}

/* ───────── simplification ───────── */

/** sin²u + cos²u = 1, wherever the two appear with the same cofactor. */
function pythagoras(e) {
  e = map(e, pythagoras);
  if (e.t !== 'add') return e;
  for (let i = 0; i < e.args.length; i++) {
    const fs = e.args[i].t === 'mul' ? e.args[i].args : [e.args[i]];
    const s = fs.find((f) => f.t === 'pow' && f.base.t === 'fn' && f.base.name === 'sin' && isInt(f.exp) && f.exp.n === 2n);
    if (!s) continue;
    const rest = mul(...fs.filter((f) => f !== s));
    const partner = mul(rest, pow(fn('cos', s.base.arg), TWO));
    const j = e.args.findIndex((t, at) => at !== i && same(t, partner));
    if (j >= 0) return pythagoras(add(rest, ...e.args.filter((_, at) => at !== i && at !== j)));
  }
  return e;
}

/** e as a quotient of two polynomials in x with rational coefficients, or null. */
function asQuotient(e, x) {
  const constant = (c) => ({ n: [c], d: [ONE] });
  switch (e.t) {
    case 'num':
      return constant(e);
    case 'sym':
      return e === x ? { n: [ZERO, ONE], d: [ONE] } : null;
    case 'add':
    case 'mul': {
      let acc = constant(e.t === 'add' ? ZERO : ONE);
      for (const a of e.args) {
        const q = asQuotient(a, x);
        if (!q) return null;
        acc = e.t === 'mul' ? { n: pmul(acc.n, q.n), d: pmul(acc.d, q.d) } : { n: padd(pmul(acc.n, q.d), pmul(q.n, acc.d)), d: pmul(acc.d, q.d) };
        if (acc.n.length + acc.d.length > 120) return null;
      }
      return acc;
    }
    case 'pow': {
      if (!isInt(e.exp) || e.exp.n > 40n || e.exp.n < -40n) return null;
      const q = asQuotient(e.base, x);
      if (!q) return null;
      const k = Number(e.exp.n < 0n ? -e.exp.n : e.exp.n);
      let n = [ONE];
      let dd = [ONE];
      for (let i = 0; i < k; i++) {
        n = pmul(n, q.n);
        dd = pmul(dd, q.d);
      }
      if (e.exp.n < 0n && pzero(n)) throw new MathError('division by zero');
      return e.exp.n < 0n ? { n: dd, d: n } : { n, d: dd };
    }
    default:
      return null;
  }
}

/** Put a one-variable rational expression over a common denominator and cancel common factors. */
export function cancel(e) {
  const names = variables(e);
  if (names.length !== 1) return null;
  const x = sym(names[0]);
  const q = asQuotient(e, x);
  if (!q || pdeg(q.d) === 0) return null;
  const g = pgcd(q.n, q.d);
  if (pdeg(g) === 0 && e.t === 'mul') {
    // nothing cancels: keep the denominator as it was written and only tidy the numerator
    const below = mul(...e.args.filter((f) => f.t === 'pow' && isInt(f.exp) && f.exp.n < 0n).map((f) => pow(f, NEG)));
    const written = ratCoeffs(below, x);
    if (written && written.length === q.d.length) return div(pexpr(pscale(q.n, nmul(written[written.length - 1], ninv(q.d[q.d.length - 1]))), x), below);
  }
  let n = pdivmod(q.n, g)[0];
  let dd = pdivmod(q.d, g)[0];
  const lead = ninv(dd[dd.length - 1]);
  n = pscale(n, lead);
  dd = pscale(dd, lead);
  return div(pexpr(n, x), pexpr(dd, x));
}

/** The smallest of: the expression itself, its expansion, and what the identities above give. */
export function simplify(e) {
  let best = e;
  const offer = (make) => {
    try {
      const c = make();
      if (c && size(c) < size(best)) best = c;
    } catch (err) {
      if (!(err instanceof MathError)) throw err;
    }
  };
  offer(() => pythagoras(e));
  offer(() => cancel(e));
  offer(() => pythagoras(expand(e)));
  // a pure number is better multiplied out: (1 + √2)² → 3 + 2√2
  if (variables(best).length === 0) {
    try {
      const wide = expand(best);
      if (size(wide) <= size(best) + 4) best = wide;
    } catch (err) {
      if (!(err instanceof MathError)) throw err;
    }
  }
  return best;
}

/* ───────── integration ───────── */

const isMinusOne = (n) => isNum(n) && n.n === -1n && n.d === 1n;

/**
 * integrate(e, x, steps?) → an antiderivative, or null when none of the methods applies:
 * linearity, standard forms (also with a linear inside), integration by parts, partial fractions,
 * substitution, and multiplying out. Steps are recorded like diff()'s.
 */
export function integrate(e, x, steps = null, depth = 0) {
  if (depth > 7) return null;
  const rule = (name, expr, compute, extra) => {
    const at = steps ? steps.length : 0;
    const result = compute();
    if (!steps) return result;
    if (!result) {
      steps.length = at; // forget the steps of an attempt that failed
      return null;
    }
    steps.splice(at, 0, { rule: name, expr, result, v: x.name, ...extra });
    return result;
  };
  const go = (u) => integrate(u, x, steps, depth + 1);
  /** [b, a] when u = a·x + b with a ≠ 0 and a, b free of x */
  const linear = (u) => {
    const c = coeffs(u, x);
    return c && c.length === 2 ? c : null;
  };

  if (!has(e, x)) return mul(e, x);
  if (e.t === 'add')
    return rule('Integrate each term', e, () => {
      const parts = [];
      for (const a of e.args) {
        const r = go(a);
        if (!r) return null;
        parts.push(r);
      }
      return add(...parts);
    });
  if (e.t === 'mul') {
    const fixed = e.args.filter((a) => !has(a, x));
    if (fixed.length)
      return rule('Move the constant factor outside', e, () => {
        const r = go(mul(...e.args.filter((a) => has(a, x))));
        return r && mul(...fixed, r);
      });
  }

  function table() {
    if (e === x) return rule('Power rule: ∫ xⁿ dx = xⁿ⁺¹/(n + 1)', e, () => mul(HALF, pow(x, TWO)));
    if (e.t === 'pow') {
      const { base, exp: n } = e;
      if (!has(n, x)) {
        const lin = linear(base);
        if (lin) {
          if (isMinusOne(n)) return rule('∫ 1/u du = ln|u|', e, () => div(fn('ln', fn('abs', base)), lin[1]));
          return rule(base === x ? 'Power rule: ∫ xⁿ dx = xⁿ⁺¹/(n + 1)' : 'Power rule with a linear inside', e, () => div(pow(base, add(n, ONE)), mul(add(n, ONE), lin[1])));
        }
        const q = ratCoeffs(base, x);
        if (q && q.length === 3 && isNum(n)) {
          const [c, b, a] = q;
          const disc = nadd(nmul(b, b), nmul(int(-4), nmul(a, c)));
          if (isMinusOne(n) && disc.n < 0n)
            return rule('Complete the square: ∫ 1/(u² + k²) du = atan(u/k)/k', e, () => {
              const k = sqrt(nneg(disc));
              return mul(TWO, pow(k, NEG), fn('atan', mul(add(mul(TWO, a, x), b), pow(k, NEG))));
            });
          if (n.n === -1n && n.d === 2n && isZero(b) && isOne(c) && isMinusOne(a)) return rule('∫ 1/√(1 − x²) dx = asin(x)', e, () => fn('asin', x));
        }
        if (base.t === 'fn' && isInt(n) && linear(base.arg)) {
          const u = base.arg;
          const a = linear(u)[1];
          const k = `${base.name}${n.n}`;
          if (k === 'sin2') return rule('Half-angle identity: sin²u = (1 − cos 2u)/2', e, () => sub(mul(HALF, x), div(fn('sin', mul(TWO, u)), mul(int(4), a))));
          if (k === 'cos2') return rule('Half-angle identity: cos²u = (1 + cos 2u)/2', e, () => add(mul(HALF, x), div(fn('sin', mul(TWO, u)), mul(int(4), a))));
          if (k === 'cos-2') return rule('∫ 1/cos²u du = tan u', e, () => div(fn('tan', u), a));
          if (k === 'sin-2') return rule('∫ 1/sin²u du = −cos u / sin u', e, () => neg(div(fn('cos', u), mul(a, fn('sin', u)))));
        }
      } else if (!has(base, x) && linear(n)) {
        const a = linear(n)[1];
        return rule(base === E ? '∫ eᵘ du = eᵘ' : '∫ aᵘ du = aᵘ/ln(a)', e, () => div(e, base === E ? a : mul(a, fn('ln', base))));
      }
      return null;
    }
    if (e.t === 'fn' && linear(e.arg)) {
      const u = e.arg;
      const standard = {
        sin: () => neg(fn('cos', u)),
        cos: () => fn('sin', u),
        tan: () => neg(fn('ln', fn('abs', fn('cos', u)))),
        sinh: () => fn('cosh', u),
        cosh: () => fn('sinh', u),
        tanh: () => fn('ln', fn('cosh', u)),
        ln: () => sub(mul(u, fn('ln', u)), u),
        atan: () => sub(mul(u, fn('atan', u)), mul(HALF, fn('ln', add(ONE, pow(u, TWO))))),
        asin: () => add(mul(u, fn('asin', u)), sqrt(sub(ONE, pow(u, TWO)))),
      }[e.name];
      if (standard) return rule(`Standard integral of ${e.name}`, e, () => div(standard(), linear(u)[1]));
    }
    return null;
  }

  function byParts() {
    if (e.t !== 'mul') return null;
    const fs = e.args;
    const isExp = (f) => f.t === 'pow' && f.base === E && linear(f.exp);
    const isWave = (f) => f.t === 'fn' && (f.name === 'sin' || f.name === 'cos') && linear(f.arg);
    if (fs.length === 2 && fs.some(isExp) && fs.some(isWave)) {
      // e^(ax)·sin(bx): two rounds of parts return to the start; solve for the integral
      const ex = fs.find(isExp);
      const wave = fs.find(isWave);
      const a = linear(ex.exp)[1];
      const b = linear(wave.arg)[1];
      const s = fn('sin', wave.arg);
      const c = fn('cos', wave.arg);
      return rule('Integrate by parts twice, then solve for the integral', e, () => div(mul(ex, wave.name === 'sin' ? sub(mul(a, s), mul(b, c)) : add(mul(a, c), mul(b, s))), add(pow(a, TWO), pow(b, TWO))));
    }
    const powers = fs.filter((f) => f === x || (f.t === 'pow' && f.base === x && isInt(f.exp) && f.exp.n > 0n));
    const others = fs.filter((f) => !powers.includes(f));
    if (!powers.length || others.length !== 1) return null;
    const p = mul(...powers);
    const g = others[0];
    if (g.t === 'fn' && g.name === 'ln' && linear(g.arg))
      return rule('Integration by parts with u = ln, dv = the power of x', e, () => {
        const P = go(p);
        const rest = P && go(mul(P, diff(g, x)));
        return rest && sub(mul(P, g), rest);
      });
    if (!isExp(g) && !(g.t === 'fn' && ['sin', 'cos', 'sinh', 'cosh'].includes(g.name) && linear(g.arg))) return null;
    return rule('Integration by parts: ∫ u dv = uv − ∫ v du, with u the power of x', e, () => {
      const G = go(g);
      const rest = G && go(mul(diff(p, x), G));
      return rest && sub(mul(p, G), rest);
    });
  }

  function partialFractions() {
    let top = ONE;
    let bottom = ONE;
    for (const f of e.t === 'mul' ? e.args : [e]) {
      if (f.t === 'pow' && isInt(f.exp) && f.exp.n < 0n) bottom = mul(bottom, pow(f.base, nneg(f.exp)));
      else top = mul(top, f);
    }
    const N = ratCoeffs(top, x);
    const D = !isOne(bottom) && ratCoeffs(bottom, x);
    if (!N || !D || D.length < 2) return null;
    return rule('Divide, then split into partial fractions', e, () => {
      const [Q, R] = pdivmod(N, D);
      let out = add(...Q.map((c, i) => mul(c, num(1n, BigInt(i + 1)), pow(x, int(i + 1)))));
      if (pzero(R)) return out;
      const { roots, rest } = rationalRoots(D);
      if (pdeg(rest) === 0 && new Set(roots.map(key)).size === roots.length) {
        // distinct linear factors: the coefficient of 1/(x − r) is R(r)/D′(r)
        const dD = pderiv(D);
        for (const r of roots) out = add(out, mul(nmul(peval(R, r), ninv(peval(dD, r))), fn('ln', fn('abs', sub(x, r)))));
        return out;
      }
      if (roots.length === 0 && D.length === 3) {
        // irreducible quadratic: a multiple of D′/D gives a log, the remainder an arctangent
        const [c, b, a] = D;
        const disc = nadd(nmul(b, b), nmul(int(-4), nmul(a, c)));
        if (disc.n >= 0n) return null;
        const alpha = nmul(R[1] || ZERO, ninv(nmul(TWO, a)));
        const beta = nadd(R[0], nneg(nmul(alpha, b)));
        const k = sqrt(nneg(disc));
        return add(out, mul(alpha, fn('ln', fn('abs', pexpr(D, x)))), mul(beta, TWO, pow(k, NEG), fn('atan', mul(add(mul(TWO, a, x), b), pow(k, NEG)))));
      }
      return null;
    });
  }

  function substitution() {
    if (depth > 3) return null;
    const U = sym(x.name === 'u' ? 'w' : 'u');
    const seen = new Set();
    const candidates = [];
    const consider = (n) => {
      if (n !== x && has(n, x) && n.t !== 'mul' && !seen.has(key(n))) {
        seen.add(key(n));
        candidates.push(n);
      }
    };
    const visit = (n) => {
      if (n.t === 'fn') {
        consider(n);
        consider(n.arg);
        visit(n.arg);
      } else if (n.t === 'pow') {
        consider(n.base);
        consider(n.exp);
        visit(n.base);
        visit(n.exp);
      } else if (n.args) n.args.forEach(visit);
    };
    visit(e);
    for (const u of candidates) {
      let inU;
      try {
        inU = subs(mul(e, pow(diff(u, x), NEG)), u, U);
      } catch (err) {
        if (!(err instanceof MathError)) throw err;
        continue;
      }
      if (has(inU, x)) continue;
      const found = rule('Substitution', e, () => {
        const r = integrate(inU, U, steps, depth + 2);
        return r && subs(r, U, u);
      }, { u, name: U.name });
      if (found) return found;
    }
    return null;
  }

  return (
    table() ||
    byParts() ||
    partialFractions() ||
    substitution() ||
    (() => {
      const wide = expand(e);
      return same(wide, e) ? null : rule('Multiply out first', e, () => go(wide));
    })()
  );
}

/* ───────── Taylor series ───────── */

/** The Taylor polynomial of e in x about 0, up to and including xⁿ. */
export function series(e, x, n) {
  const terms = [];
  let derivative = e;
  let factorial = 1n;
  for (let k = 0; k <= n; k++) {
    if (k > 0) {
      derivative = diff(derivative, x);
      factorial *= BigInt(k);
      if (size(derivative) > 6000) throw new MathError('the derivatives grow too large; try a lower order');
    }
    let c;
    try {
      c = subs(derivative, x, ZERO);
    } catch (err) {
      if (!(err instanceof MathError)) throw err;
      throw new MathError('this function has no Taylor series about 0');
    }
    terms.push(mul(num(1n, factorial), c, pow(x, int(k))));
  }
  return add(...terms);
}
