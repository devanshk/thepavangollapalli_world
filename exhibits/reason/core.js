// The algebra core: exact numbers, expression trees, and the constructors that keep every
// expression in a canonical form (flattened, ordered, like terms and like powers combined).
// Everything else in this exhibit is built from add(), mul(), pow() and fn().

export class MathError extends Error {
  constructor(message, pos = null) {
    super(message);
    this.name = 'MathError';
    this.pos = pos;
  }
}

/* ───────── exact rational numbers on BigInt ───────── */

export function gcd(a, b) {
  if (a < 0n) a = -a;
  if (b < 0n) b = -b;
  while (b) [a, b] = [b, a % b];
  return a;
}

export function num(n, d = 1n) {
  n = BigInt(n);
  d = BigInt(d);
  if (d === 0n) throw new MathError('division by zero');
  if (d < 0n) {
    n = -n;
    d = -d;
  }
  const g = gcd(n, d) || 1n;
  return { t: 'num', n: n / g, d: d / g };
}
export const int = (n) => ({ t: 'num', n: BigInt(n), d: 1n });
export const ZERO = int(0);
export const ONE = int(1);
export const NEG = int(-1);
export const TWO = int(2);
export const HALF = num(1n, 2n);

export const isNum = (e) => e.t === 'num';
export const isZero = (e) => e.t === 'num' && e.n === 0n;
export const isOne = (e) => e.t === 'num' && e.n === 1n && e.d === 1n;
export const isInt = (e) => e.t === 'num' && e.d === 1n;
export const nadd = (a, b) => num(a.n * b.d + b.n * a.d, a.d * b.d);
export const nmul = (a, b) => num(a.n * b.n, a.d * b.d);
export const nneg = (a) => ({ t: 'num', n: -a.n, d: a.d });
export const ninv = (a) => num(a.d, a.n);
export const ncmp = (a, b) => {
  const l = a.n * b.d;
  const r = b.n * a.d;
  return l < r ? -1 : l > r ? 1 : 0;
};
export function toNumber(a) {
  const q = Number(a.n) / Number(a.d);
  if (Number.isFinite(q)) return q;
  return Number((a.n * 10n ** 30n) / a.d) / 1e30; // both parts too big for a double on their own
}

function intPow(base, k) {
  if (k < 0n) return intPow(ninv(base), -k);
  if ((base.n.toString(2).length + base.d.toString(2).length) * Number(k) > 300000) throw new MathError('that power is too large to write out exactly');
  return { t: 'num', n: base.n ** k, d: base.d ** k };
}

const floorDiv = (a, b) => {
  const q = a / b;
  return a % b !== 0n && a < 0n ? q - 1n : q;
};

/** Prime factorisation by trial division; a large leftover cofactor is treated as one factor. */
export function factorInt(m) {
  const out = new Map();
  for (let p = 2n; p * p <= m && p < 200000n; p += p === 2n ? 1n : 2n) {
    while (m % p === 0n) {
      out.set(p, (out.get(p) || 0n) + 1n);
      m /= p;
    }
  }
  if (m > 1n) out.set(m, (out.get(m) || 0n) + 1n);
  return out;
}

/* ───────── nodes ───────── */

const symbols = new Map();
export function sym(name) {
  if (!symbols.has(name)) symbols.set(name, { t: 'sym', name });
  return symbols.get(name);
}
export const E = sym('e');
export const PI = sym('pi');
export const I = sym('i');
export const flt = (v) => ({ t: 'flt', v });

/** A structural fingerprint: two expressions are the same exactly when their keys are equal. */
export function key(e) {
  if (e.k !== undefined) return e.k;
  let k;
  switch (e.t) {
    case 'num':
      k = e.d === 1n ? `${e.n}` : `${e.n}/${e.d}`;
      break;
    case 'flt':
      k = `#${e.v}`;
      break;
    case 'sym':
      k = e.name;
      break;
    case 'pow':
      k = `(^ ${key(e.base)} ${key(e.exp)})`;
      break;
    case 'fn':
      k = `(${e.name} ${key(e.arg)})`;
      break;
    default:
      k = `(${e.t === 'add' ? '+' : '*'} ${e.args.map(key).join(' ')})`;
  }
  e.k = k;
  return k;
}
export const same = (a, b) => a === b || key(a) === key(b);

// Canonical order of factors (and terms): numbers, radicals, constants, variables, sums,
// functions, exponentials. It is also the order in which a product is written.
function rank(f) {
  if (f.t === 'num' || f.t === 'flt') return 0;
  const b = f.t === 'pow' ? f.base : f;
  if (b.t === 'num') return 1;
  if (b === E) return f.t === 'pow' ? 7 : 2;
  if (b === PI || b === I) return 2;
  if (b.t === 'sym') return 3;
  if (b.t === 'add') return 4;
  if (b.t === 'fn') return 5;
  return 6;
}
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
export function order(a, b) {
  const ba = a.t === 'pow' ? a.base : a;
  const bb = b.t === 'pow' ? b.base : b;
  return rank(a) - rank(b) || cmp(key(ba), key(bb)) || cmp(key(a), key(b));
}

export function has(e, s) {
  switch (e.t) {
    case 'sym':
      return e === s;
    case 'pow':
      return has(e.base, s) || has(e.exp, s);
    case 'fn':
      return has(e.arg, s);
    case 'add':
    case 'mul':
      return e.args.some((a) => has(a, s));
    default:
      return false;
  }
}

/** Variable names in an expression (not the constants e, pi, i), sorted. */
export function variables(e, out = new Set()) {
  if (e.t === 'sym') {
    if (e !== E && e !== PI && e !== I) out.add(e.name);
  } else if (e.t === 'pow') {
    variables(e.base, out);
    variables(e.exp, out);
  } else if (e.t === 'fn') variables(e.arg, out);
  else if (e.args) e.args.forEach((a) => variables(a, out));
  return [...out].sort();
}

export function size(e) {
  switch (e.t) {
    case 'pow':
      return 1 + size(e.base) + size(e.exp);
    case 'fn':
      return 1 + size(e.arg);
    case 'add':
    case 'mul':
      return e.args.reduce((n, a) => n + size(a), 1);
    case 'num':
      return 1 + (e.d === 1n ? 0 : 1);
    default:
      return 1;
  }
}

/* ───────── sums ───────── */

const splitCoef = (e) => {
  if (e.t === 'mul' && e.args[0].t === 'num') return [e.args[0], e.args.length === 2 ? e.args[1] : { t: 'mul', args: e.args.slice(1) }];
  return [ONE, e];
};
const withCoef = (c, rest) => (isOne(c) ? rest : { t: 'mul', args: rest.t === 'mul' ? [c, ...rest.args] : [c, rest] });

export function add(...args) {
  let constant = ZERO;
  const terms = new Map();
  const push = (e) => {
    if (e.t === 'add') return e.args.forEach(push);
    if (e.t === 'num') {
      constant = nadd(constant, e);
      return undefined;
    }
    const [c, rest] = splitCoef(e);
    const k = key(rest);
    const seen = terms.get(k);
    if (seen) seen.c = nadd(seen.c, c);
    else terms.set(k, { c, rest });
    return undefined;
  };
  args.forEach(push);
  const out = [];
  for (const { c, rest } of terms.values()) if (!isZero(c)) out.push(withCoef(c, rest));
  out.sort(order);
  if (!isZero(constant)) out.unshift(constant);
  if (out.length === 0) return ZERO;
  return out.length === 1 ? out[0] : { t: 'add', args: out };
}

/* ───────── products ───────── */

export function mul(...args) {
  let coef = ONE;
  const powers = new Map(); // base key → { base, exps, whole }
  const push = (e) => {
    if (e.t === 'mul') return e.args.forEach(push);
    if (e.t === 'num') {
      coef = nmul(coef, e);
      return undefined;
    }
    const base = e.t === 'pow' ? e.base : e;
    const k = key(base);
    const seen = powers.get(k);
    if (seen) seen.exps.push(e.t === 'pow' ? e.exp : ONE);
    else powers.set(k, { base, exps: [e.t === 'pow' ? e.exp : ONE], whole: e });
    return undefined;
  };
  args.forEach(push);
  if (isZero(coef)) return ZERO;
  const factors = [];
  for (const { base, exps, whole } of powers.values()) {
    const r = exps.length === 1 ? whole : pow(base, add(...exps));
    if (r.t === 'num') coef = nmul(coef, r);
    else if (r.t === 'mul') {
      // e.g. 2^(3/2) = 2·√2: a number and a radical
      for (const a of r.args) {
        if (a.t === 'num') coef = nmul(coef, a);
        else factors.push(a);
      }
    } else factors.push(r);
  }
  if (isZero(coef)) return ZERO;
  if (factors.length === 0) return coef;
  factors.sort(order);
  if (isOne(coef)) return factors.length === 1 ? factors[0] : { t: 'mul', args: factors };
  // a number times a single sum is multiplied through: 2(x + 1) → 2x + 2
  if (factors.length === 1 && factors[0].t === 'add') return add(...factors[0].args.map((a) => mul(coef, a)));
  return { t: 'mul', args: [coef, ...factors] };
}

/** A product written exactly as given, for results that must stay factored. */
export const product = (coef, factors) => {
  const args = isOne(coef) ? factors : [coef, ...factors];
  return args.length === 1 ? args[0] : { t: 'mul', args };
};

export const neg = (e) => mul(NEG, e);
export const sub = (a, b) => add(a, mul(NEG, b));
export const div = (a, b) => mul(a, pow(b, NEG));

/* ───────── powers ───────── */

function numPow(base, exp) {
  if (exp.d === 1n) return intPow(base, exp.n);
  if (base.n < 0n) {
    const positive = nneg(base);
    if (exp.d === 2n) return mul(pow(I, int(exp.n)), pow(positive, exp)); // √(−a) = i√a
    if (exp.d % 2n === 1n) return mul(exp.n % 2n === 0n ? ONE : NEG, pow(positive, exp)); // the real odd root
    return { t: 'pow', base, exp };
  }
  // Split every prime power into a whole part, which joins the coefficient, and a root.
  let coef = ONE;
  const roots = [];
  const visit = (m, sign) => {
    for (const [prime, count] of factorInt(m)) {
      const e = num(sign * count * exp.n, exp.d);
      const whole = floorDiv(e.n, e.d);
      if (whole !== 0n) coef = nmul(coef, intPow(int(prime), whole));
      if (e.n - whole * e.d !== 0n) roots.push({ t: 'pow', base: int(prime), exp: num(e.n - whole * e.d, e.d) });
    }
  };
  if (base.n > 1n) visit(base.n, 1n);
  if (base.d > 1n) visit(base.d, -1n);
  if (roots.length === 0) return coef;
  roots.sort(order);
  return product(coef, roots);
}

const positiveBase = (b) => b === E || b === PI || (b.t === 'num' && b.n > 0n);

export function pow(base, exp) {
  if (exp.t === 'num') {
    if (exp.n === 0n) return ONE;
    if (isOne(exp)) return base;
  }
  if (base.t === 'num') {
    if (isOne(base)) return ONE;
    if (base.n === 0n) {
      if (exp.t === 'num') {
        if (exp.n > 0n) return ZERO;
        throw new MathError('division by zero');
      }
      return { t: 'pow', base, exp };
    }
    if (exp.t === 'num') return numPow(base, exp);
  }
  if (base === I && isInt(exp)) return [ONE, I, NEG, mul(NEG, I)][Number(((exp.n % 4n) + 4n) % 4n)];
  if (base.t === 'pow' && (isInt(exp) || positiveBase(base.base))) return pow(base.base, mul(base.exp, exp)); // (u^a)^n = u^(an)
  if (base.t === 'mul') {
    if (isInt(exp)) return mul(...base.args.map((a) => pow(a, exp)));
    const c = base.args[0];
    if (c.t === 'num' && c.n > 0n && exp.t === 'num') return mul(pow(c, exp), pow(product(ONE, base.args.slice(1)), exp)); // √(4x) = 2√x
  }
  if (base === E && exp.t === 'fn' && exp.name === 'ln') return exp.arg; // e^ln(u) = u
  if (base === E && exp.t === 'add' && exp.args.some((a) => a.t === 'fn' && a.name === 'ln')) {
    // e^(a + ln u) = u·e^a
    const logs = exp.args.filter((a) => a.t === 'fn' && a.name === 'ln');
    return mul(...logs.map((l) => l.arg), pow(E, add(...exp.args.filter((a) => !logs.includes(a)))));
  }
  if (base === E && exp.t === 'mul' && exp.args.includes(I)) {
    // Euler: e^(iqπ) = cos(qπ) + i·sin(qπ) when both have closed forms
    const q = piMultiple(product(ONE, exp.args.filter((a) => a !== I)));
    const c = q && exactTrig('cos', q);
    const s = q && exactTrig('sin', q);
    if (c && s) return add(c, mul(I, s));
  }
  return { t: 'pow', base, exp };
}

export const sqrt = (e) => pow(e, HALF);
export const exp = (e) => pow(E, e);

/* ───────── functions ───────── */

export const isNegative = (e) =>
  (e.t === 'num' && e.n < 0n) || (e.t === 'mul' && e.args[0].t === 'num' && e.args[0].n < 0n) || (e.t === 'add' && e.args.every(isNegative));

/** q when e = q·π with q rational, else null. */
function piMultiple(e) {
  if (e === PI) return ONE;
  if (isZero(e)) return ZERO;
  if (e.t === 'mul' && e.args.length === 2 && e.args[0].t === 'num' && e.args[1] === PI) return e.args[0];
  return null;
}

// sin(k·π/12) for the angles with a simple closed form (multiples of π/6 and π/4)
function sinTwelfths(k) {
  k = ((k % 24) + 24) % 24;
  if (k > 12) return neg(sinTwelfths(k - 12));
  if (k > 6) return sinTwelfths(12 - k);
  return [ZERO, null, HALF, mul(HALF, sqrt(TWO)), mul(HALF, sqrt(int(3))), null, ONE][k];
}
function exactTrig(name, q) {
  if ((q.n * 12n) % q.d !== 0n) return null;
  const k = Number(((q.n * 12n) / q.d) % 24n);
  if (k % 2 !== 0 && k % 3 !== 0) return null;
  if (name === 'sin') return sinTwelfths(k);
  if (name === 'cos') return sinTwelfths(k + 6);
  const c = sinTwelfths(k + 6);
  if (isZero(c)) throw new MathError('tan is undefined at that angle');
  return div(sinTwelfths(k), c);
}

const ODD = new Set(['sin', 'tan', 'asin', 'atan', 'sinh', 'tanh']);
const EVEN = new Set(['cos', 'cosh', 'abs']);
const AT_ZERO = { sin: ZERO, tan: ZERO, asin: ZERO, atan: ZERO, sinh: ZERO, tanh: ZERO, cos: ONE, cosh: ONE, abs: ZERO };
// inverse trig at the arguments with simple answers: key of the argument → fraction of π
const R2 = '(* 1/2 (^ 2 1/2))';
const R3 = '(* 1/2 (^ 3 1/2))';
const INVERSE = {
  asin: { 1: [1n, 2n], '1/2': [1n, 6n], [R2]: [1n, 4n], [R3]: [1n, 3n] },
  acos: { 0: [1n, 2n], 1: [0n, 1n], '1/2': [1n, 3n], [R2]: [1n, 4n], [R3]: [1n, 6n], '-1': [1n, 1n], '-1/2': [2n, 3n] },
  atan: { 1: [1n, 4n], '(^ 3 1/2)': [1n, 3n], '(* 1/3 (^ 3 1/2))': [1n, 6n] },
};
export const FUNCTIONS = ['sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'sinh', 'cosh', 'tanh', 'ln', 'abs'];

export function fn(name, arg) {
  if (name === 'exp') return exp(arg);
  if (name === 'sqrt') return sqrt(arg);
  if (name === 'log') name = 'ln';
  if (isZero(arg) && AT_ZERO[name]) return AT_ZERO[name];
  if (isNegative(arg)) {
    if (ODD.has(name)) return neg(fn(name, neg(arg)));
    if (EVEN.has(name)) return fn(name, neg(arg));
  }
  if (name === 'sin' || name === 'cos' || name === 'tan') {
    const q = piMultiple(arg);
    const exact = q && exactTrig(name, q);
    if (exact) return exact;
  } else if (name === 'ln') {
    if (isZero(arg)) throw new MathError('ln(0) is undefined');
    if (isOne(arg)) return ZERO;
    if (arg === E) return ONE;
    if (arg.t === 'pow' && arg.base === E) return arg.exp;
    if (arg.t === 'num' && arg.n === 1n) return neg(fn('ln', int(arg.d))); // ln(1/n) = −ln(n)
    if (isInt(arg) && arg.n > 3n) {
      const primes = [...factorInt(arg.n)];
      if (primes.length === 1 && primes[0][1] > 1n) return mul(int(primes[0][1]), fn('ln', int(primes[0][0]))); // ln(32) = 5·ln(2)
    }
  } else if (name === 'abs') {
    if (arg.t === 'num') return arg; // negatives were handled above
    if (arg === PI || arg === E || (arg.t === 'pow' && (arg.base === E || (isInt(arg.exp) && arg.exp.n % 2n === 0n))) || (arg.t === 'fn' && arg.name === 'abs')) return arg;
  } else if (INVERSE[name] && INVERSE[name][key(arg)]) {
    const [n, d] = INVERSE[name][key(arg)];
    return mul(num(n, d), PI);
  }
  return { t: 'fn', name, arg };
}

/* ───────── rebuilding ───────── */

/** Apply f to each child and rebuild through the constructors (so the result is canonical). */
export function map(e, f) {
  switch (e.t) {
    case 'add':
      return add(...e.args.map(f));
    case 'mul':
      return mul(...e.args.map(f));
    case 'pow':
      return pow(f(e.base), f(e.exp));
    case 'fn':
      return fn(e.name, f(e.arg));
    default:
      return e;
  }
}

/** Replace every occurrence of `from` by `to`. */
export function subs(e, from, to) {
  const k = key(from);
  const go = (x) => (key(x) === k ? to : map(x, go));
  return go(e);
}

/* ───────── expansion ───────── */

const TERM_LIMIT = 3000;
const termsOf = (e) => (e.t === 'add' ? e.args : [e]);
function multiplyOut(a, b) {
  const out = [];
  for (const x of termsOf(a)) for (const y of termsOf(b)) out.push(mul(x, y));
  if (out.length > TERM_LIMIT) throw new MathError('that expansion has too many terms to be useful');
  return add(...out);
}

/** Multiply out products and whole-number powers of sums. */
export function expand(e) {
  switch (e.t) {
    case 'add':
      return add(...e.args.map(expand));
    case 'mul':
      return e.args.map(expand).reduce(multiplyOut, ONE);
    case 'pow': {
      const base = expand(e.base);
      const power = expand(e.exp);
      if (base.t === 'add' && isInt(power) && power.n > 1n) {
        if (power.n > 60n) throw new MathError('that power is too high to multiply out');
        let out = base;
        for (let i = 1n; i < power.n; i++) out = multiplyOut(out, base);
        return out;
      }
      return pow(base, power);
    }
    case 'fn':
      return fn(e.name, expand(e.arg));
    default:
      return e;
  }
}
