// The notebook's engine: one line of input in, one finished card out. It reads the command,
// runs the algebra, checks the answer numerically, and prepares everything the page shows.
import { MathError, ZERO, I, sym, int, flt, isNum, isInt, sub, has, same, size, subs, variables, expand, product, pow } from './core.js';
import { parse, build, COMMANDS } from './parse.js';
import { toDisplay, toText, toLatex, D } from './display.js';
import { diff, integrate, series, simplify } from './calculus.js';
import { ratCoeffs, factorPoly, pexpr } from './poly.js';
import { solve } from './solve.js';
import { evalC, evalReal, agree, checkDerivative, quadrature } from './numeric.js';

const ALIAS = { int: 'integrate', taylor: 'series', N: 'numeric', approx: 'numeric' };
const TITLE = { diff: 'Derivative', integrate: 'Integral', factor: 'Factorisation', expand: 'Expansion', simplify: 'Simplification', series: 'Taylor series', solve: 'Solution', numeric: 'Decimal value', value: 'Value' };
const disp = toDisplay;

const verdict = (r, what) => {
  if (r.ok === true) return { state: 'ok', text: `${what} at ${r.points} random point${r.points === 1 ? '' : 's'}.` };
  if (r.ok === false) return { state: 'bad', text: 'A numerical check disagrees with this answer. Do not trust it.' };
  return { state: 'none', text: 'Not checked numerically: there were too few points where both sides are defined.' };
};

function variableFrom(tree, e) {
  if (tree) {
    if (tree.s !== 'sym' || ['e', 'pi', 'i'].includes(tree.name)) throw new MathError('the variable should be a single letter such as x');
    return sym(tree.name);
  }
  const names = variables(e);
  return sym(names.includes('x') || names.length === 0 ? 'x' : names[0]);
}

/** A plot of real functions of one variable, or null if these are not that. */
function plotOf(v, curves, extra = {}) {
  const usable = curves.filter((c) => c.e && variables(c.e).every((n) => n === v.name) && !has(c.e, I));
  if (!usable.length || !variables(usable[0].e).length) return null;
  return { v: v.name, curves: usable, marks: [], range: null, ...extra };
}

const decimal = (e) => {
  if (variables(e).length || isInt(e) || e.t === 'flt') return null;
  const [re, im] = evalC(e);
  if (!Number.isFinite(re) || !Number.isFinite(im)) return null;
  const tiny = 1e-12 * (1 + Math.abs(re) + Math.abs(im));
  if (Math.abs(im) < tiny) return disp(flt(re));
  const imaginary = { neg: im < 0, node: Math.abs(im) === 1 ? D.sym('i') : { d: 'mul', factors: [disp(flt(Math.abs(im))), D.sym('i')] } };
  return { d: 'add', terms: Math.abs(re) < tiny ? [imaginary] : [{ neg: re < 0, node: disp(flt(Math.abs(re))) }, imaginary] };
};

const stepsFor = (list, kind) =>
  list
    .filter((s) => size(s.expr) <= 48 && size(s.result) <= 90)
    .slice(0, 14)
    .map((s) => ({
      rule: s.rule,
      sub: s.u ? D.eq(D.sym(s.name), disp(s.u)) : null,
      lhs: kind === 'diff' ? D.deriv(s.v, disp(s.expr)) : D.integral(s.v, disp(s.expr)),
      rhs: disp(s.result),
    }));

const COMMAND = {
  diff(args) {
    if (args.length < 1 || args.length > 2) throw new MathError('use diff(f, x)');
    const f = build(args[0]);
    const x = variableFrom(args[1], f);
    const steps = [];
    const raw = diff(f, x, steps);
    const result = simplify(raw);
    const out = stepsFor(steps, 'diff');
    if (!same(raw, result)) out.push({ rule: 'Tidy up', sub: null, lhs: disp(raw), rhs: disp(result) });
    return {
      question: D.deriv(x.name, disp(f)),
      answer: disp(result),
      steps: out,
      check: verdict(checkDerivative(f, result, x.name), 'Matches a finite-difference slope of the original'),
      plot: plotOf(x, [{ e: f, label: 'f' }, { e: result, label: 'f′' }]),
    };
  },

  integrate(args) {
    if (![1, 2, 4].includes(args.length)) throw new MathError('use integrate(f, x) or integrate(f, x, a, b)');
    const f = build(args[0]);
    const x = variableFrom(args[1], f);
    const steps = [];
    const found = integrate(f, x, steps);
    const F = found && simplify(found);
    if (args.length < 4) {
      if (!F)
        return {
          question: D.integral(x.name, disp(f)),
          message: 'No antiderivative found. The methods tried were linearity, standard forms, integration by parts, partial fractions, substitution and multiplying out. For a number instead, give limits: integrate(f, x, a, b).',
          plot: plotOf(x, [{ e: f, label: 'f' }]),
        };
      return {
        question: D.integral(x.name, disp(f)),
        answer: D.row([disp(F), D.text('+ C')]),
        steps: stepsFor(steps, 'integrate'),
        check: verdict(agree(diff(F, x), f), 'Differentiating the answer gives back the integrand'),
        plot: plotOf(x, [{ e: f, label: 'f' }, { e: F, label: '∫f' }]),
      };
    }
    const a = build(args[2]);
    const b = build(args[3]);
    const lo = evalReal(a);
    const hi = evalReal(b);
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) throw new MathError('the limits of integration must be numbers');
    const q = quadrature((t) => evalReal(f, { [x.name]: t }), lo, hi);
    const question = D.integral(x.name, disp(f), disp(a), disp(b));
    const plot = plotOf(x, [{ e: f, label: 'f' }], { range: [Math.min(lo, hi), Math.max(lo, hi)], shade: true });
    let exact = null;
    if (F) {
      try {
        exact = simplify(sub(subs(F, x, b), subs(F, x, a)));
      } catch (err) {
        if (!(err instanceof MathError)) throw err;
      }
    }
    if (!q.ok) {
      return { question, message: 'This integral did not converge numerically. The integrand is probably unbounded between the limits.', plot };
    }
    const numeric = disp(flt(q.value));
    if (exact && Math.abs(evalReal(exact) - q.value) <= 1e-6 * (1 + Math.abs(q.value)))
      return { question, answer: disp(exact), extra: isNum(exact) && isInt(exact) ? null : decimal(exact), steps: stepsFor(steps, 'integrate'), check: { state: 'ok', text: `Agrees with numerical integration (adaptive Simpson): ${toText(numeric)}.` }, plot };
    return {
      question,
      answer: D.row([D.text('≈'), numeric]),
      check: { state: 'none', text: exact ? 'The antiderivative jumps inside this interval, so only the numerical value is shown.' : 'Numerical value by adaptive Simpson quadrature; no antiderivative was found.' },
      plot,
    };
  },

  factor(args) {
    if (args.length !== 1) throw new MathError('use factor(f)');
    const f = build(args[0]);
    const names = variables(f);
    const x = sym(names[0] || 'x');
    const p = names.length === 1 ? ratCoeffs(f, x) : null;
    if (!p) {
      if (isInt(f) && f.n > 1n) return { question: disp(f), message: 'Factoring whole numbers into primes is not something this notebook does; factor() is for polynomials in one variable.' };
      return { question: disp(f), message: 'I can factor polynomials in one variable with rational coefficients. This is not one.' };
    }
    const { content, factors } = factorPoly(p);
    const result = product(content, factors.map((g) => pow(pexpr(g.p, x), int(g.mult))));
    const unchanged = factors.length === 1 && factors[0].mult === 1;
    return {
      question: disp(f),
      answer: disp(result),
      check: verdict(agree(f, result), 'Multiplies back to the original'),
      notes: unchanged ? [p.length <= 4 ? 'It has no rational roots, so it does not factor over the rationals.' : 'No factor was found; that is not a proof that none exists.'] : [],
      plot: plotOf(x, [{ e: f, label: 'f' }]),
    };
  },

  expand(args) {
    if (args.length !== 1) throw new MathError('use expand(f)');
    const f = build(args[0]);
    const result = expand(f);
    return { question: disp(f), answer: disp(result), check: verdict(agree(f, result), 'Equal to the original'), plot: plotOf(variableFrom(null, f), [{ e: f, label: 'f' }]) };
  },

  simplify(args) {
    if (args.length !== 1) throw new MathError('use simplify(f)');
    return evaluate(build(args[0]), 'simplify');
  },

  series(args) {
    if (args.length < 1 || args.length > 3) throw new MathError('use series(f, x, n)');
    const f = build(args[0]);
    const x = variableFrom(args.length === 3 ? args[1] : null, f);
    const order = args.length > 1 ? build(args[args.length - 1]) : int(6);
    if (!isInt(order) || order.n < 0n || order.n > 16n) throw new MathError('the order of a series should be a whole number from 0 to 16');
    const n = Number(order.n);
    const poly = series(f, x, n);
    // a truncated series must match the function near 0, with an error that shrinks like x^(n+1)
    let ok = variables(f).length === 1 ? true : null;
    for (const h of [0.2, 0.1, 0.05]) {
      const err = Math.abs(evalReal(f, { [x.name]: h }) - evalReal(poly, { [x.name]: h }));
      if (ok && !(err <= 200 * h ** (n + 1) + 1e-12)) ok = false;
    }
    return {
      question: D.call('series', [disp(f), D.sym(x.name), D.num(n)]),
      // a series reads from the constant term upward
      answer: D.row([disp(poly.t === 'add' ? { ...poly, k: undefined, ascending: true, args: [...poly.args].sort((p, q) => evalReal(p, { [x.name]: 1e-3 }) ** 2 - evalReal(q, { [x.name]: 1e-3 }) ** 2).reverse() } : poly), D.text('+ ⋯')]),
      check: ok === null ? null : ok ? { state: 'ok', text: `Tracks the function near 0 with an error that shrinks like ${x.name}^${n + 1}.` } : { state: 'bad', text: 'A numerical check disagrees with this series. Do not trust it.' },
      plot: plotOf(x, [{ e: f, label: 'f' }, { e: poly, label: 'series' }], { range: [-4, 4] }),
    };
  },

  solve(args) {
    if (args.length < 1 || args.length > 2) throw new MathError('use solve(equation, x)');
    const eq = args[0];
    const lhs = build(eq.s === 'eq' ? eq.a : eq);
    const rhs = eq.s === 'eq' ? build(eq.b) : ZERO;
    const f = sub(lhs, rhs);
    const x = variableFrom(args[1], f);
    const question = D.eq(disp(lhs), disp(rhs));
    const s = solve(lhs, rhs, x);
    if (s.all) return { question, message: `True for every value of ${x.name}.` };
    if (s.none || (!s.exact.length && !s.approx.length)) return { question, message: s.none ? 'No solution: the two sides are never equal.' : 'No real solution was found.' , notes: s.notes };
    const items = [...s.exact.map((r) => D.eq(D.sym(x.name), disp(r))), ...s.approx.map((r) => D.approx(D.sym(x.name), disp(flt(r))))];
    const residuals = [...s.exact.map((r) => evalC(subs(f, x, r))), ...s.approx.map((r) => evalC(f, { [x.name]: r }))].map(([re, im]) => Math.hypot(re, im));
    const numeric = residuals.every((r) => Number.isFinite(r));
    const fine = residuals.every((r) => r < 1e-6);
    const reals = [...s.exact.map((r) => evalReal(r)), ...s.approx].filter(Number.isFinite);
    const decimals = s.exact.filter((r) => !isNum(r) && !variables(r).length).map((r) => decimal(r)).filter(Boolean);
    return {
      question,
      answer: D.list(items),
      extra: decimals.length ? D.list(decimals) : null,
      check: !numeric ? null : fine ? { state: 'ok', text: `Substituting ${items.length === 1 ? 'it' : 'each one'} back gives zero to within rounding.` } : { state: 'bad', text: 'Substituting back does not give zero. Do not trust this answer.' },
      notes: s.notes,
      plot: plotOf(x, [{ e: f, label: 'left − right' }], { marks: reals }),
    };
  },

  numeric(args) {
    if (args.length !== 1) throw new MathError('use N(expression)');
    const f = build(args[0]);
    if (variables(f).length) throw new MathError(`a decimal value needs a number, but this still contains ${variables(f).join(', ')}`);
    const value = decimal(f) || disp(f);
    return { question: disp(f), answer: D.row([D.text('≈'), value]) };
  },
};

function evaluate(f, kind) {
  const result = simplify(f);
  const changed = !same(f, result);
  return {
    kind,
    question: changed ? disp(f) : null,
    answer: disp(result),
    extra: decimal(result),
    check: changed && variables(f).length ? verdict(agree(f, result), 'Equal to the original') : null,
    plot: plotOf(variableFrom(null, result), [{ e: result, label: 'f' }]),
  };
}

function compute(input) {
  if (!input) throw new MathError('type an expression first');
  let kind;
  let args;
  const d = /^d\s*\/\s*d([a-zA-Z])\s+(.+)$/s.exec(input) || /^d\s*\/\s*d([a-zA-Z])\s*([([].+)$/s.exec(input);
  const integral = /^∫\s*(.+?)\s*d([a-zA-Z])$/s.exec(input);
  if (d) {
    kind = 'diff';
    args = [parse(d[2]), { s: 'sym', name: d[1] }];
  } else if (integral) {
    kind = 'integrate';
    args = [parse(integral[1]), { s: 'sym', name: integral[2] }];
  } else {
    const tree = parse(input);
    if (tree.s === 'call' && COMMANDS.includes(tree.name)) {
      kind = ALIAS[tree.name] || tree.name;
      args = tree.args;
    } else if (tree.s === 'eq') {
      kind = 'solve';
      args = [tree];
    } else return { kind: 'value', ...evaluate(build(tree), 'value') };
  }
  return { kind, ...COMMAND[kind](args) };
}

/**
 * run(input) → { ok: true, kind, title, input, question, answer, extra, message, steps, check,
 *                notes, plot, latex, text }   or   { ok: false, input, message, pos }
 * question / answer / extra are display trees (see display.js); text is the answer as plain text.
 */
export function run(input) {
  input = String(input).trim();
  try {
    const r = compute(input);
    const out = { ok: true, input, title: TITLE[r.kind], question: null, answer: null, extra: null, message: null, steps: [], check: null, notes: [], plot: null, ...r };
    out.text = out.answer ? toText(out.answer) : out.message;
    out.latex = out.answer ? `${out.question ? `${toLatex(out.question)} = ` : ''}${toLatex(out.answer)}` : '';
    return out;
  } catch (err) {
    if (err instanceof MathError) return { ok: false, input, message: err.message, pos: err.pos };
    if (err instanceof RangeError) return { ok: false, input, message: 'that calculation grew too large to finish', pos: null };
    throw err;
  }
}
