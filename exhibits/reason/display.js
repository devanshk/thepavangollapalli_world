// From a canonical expression to something a person would write. toDisplay() turns the tree
// into a "display tree" that makes the writer's choices explicit (subtraction instead of adding
// a negative, fractions instead of negative powers, √ instead of ^(1/2), terms in descending
// degree); three small printers turn that into plain text, LaTeX, and HTML.
import { ONE, HALF, I, isNum, isInt, nneg, ncmp, toNumber, pow, order, variables, isNegative, has } from './core.js';

/* ───────── display tree ───────── */

const N = (s) => ({ d: 'num', s: String(s) });
const NAMES = { pi: 'π' };

/** [total degree, then the exponent of each variable in name order]: the sort key of a term */
function degrees(term, names) {
  const out = names.map(() => 0);
  const visit = (f) => {
    if (f.t === 'sym') {
      const i = names.indexOf(f.name);
      if (i >= 0) out[i] += 1;
    } else if (f.t === 'pow' && f.base.t === 'sym' && isNum(f.exp)) {
      const i = names.indexOf(f.base.name);
      if (i >= 0) out[i] += toNumber(f.exp);
    } else if (f.t === 'mul') f.args.forEach(visit);
  };
  visit(term);
  return [out.reduce((n, d) => n + d, 0), ...out];
}

/** Terms as a person orders them: highest degree first, then positive before negative, numbers before radicals. */
function writtenOrder(args) {
  const names = [...new Set(args.flatMap((t) => variables(t)))].sort();
  const keyed = args.map((t) => ({ t, v: degrees(t, names) }));
  keyed.sort((a, b) => {
    for (let i = 0; i < a.v.length; i++) if (a.v[i] !== b.v[i]) return b.v[i] - a.v[i];
    if (has(a.t, I) !== has(b.t, I)) return has(a.t, I) ? 1 : -1; // real part before imaginary part
    if (isNegative(a.t) !== isNegative(b.t)) return isNegative(a.t) ? 1 : -1;
    if (isNum(a.t) !== isNum(b.t)) return isNum(a.t) ? -1 : 1;
    return order(a.t, b.t);
  });
  return keyed.map((k) => k.t);
}

const trimFloat = (v) => {
  if (!Number.isFinite(v)) return String(v);
  const s = Math.abs(v) >= 1e15 || (Math.abs(v) < 1e-6 && v !== 0) ? v.toExponential(9) : v.toPrecision(12);
  return s.includes('e') ? s.replace(/\.?0+e/, 'e').replace('e+', 'e') : s.includes('.') ? s.replace(/\.?0+$/, '') : s;
};

function product(list) {
  if (list.length === 0) return N(1);
  return list.length === 1 ? list[0] : { d: 'mul', factors: list };
}

export function toDisplay(e) {
  switch (e.t) {
    case 'num': {
      const a = e.n < 0n ? nneg(e) : e;
      const body = a.d === 1n ? N(a.n) : { d: 'frac', num: N(a.n), den: N(a.d) };
      return e.n < 0n ? { d: 'neg', arg: body } : body;
    }
    case 'flt':
      return e.v < 0 ? { d: 'neg', arg: N(trimFloat(-e.v)) } : N(trimFloat(e.v));
    case 'sym':
      return { d: 'sym', name: NAMES[e.name] || e.name };
    case 'add': {
      const terms = (e.ascending ? e.args : writtenOrder(e.args)).map(toDisplay);
      return { d: 'add', terms: terms.map((t) => (t.d === 'neg' ? { neg: true, node: t.arg } : { neg: false, node: t })) };
    }
    case 'mul': {
      const coef = isNum(e.args[0]) ? e.args[0] : ONE;
      const c = coef.n < 0n ? nneg(coef) : coef;
      const numer = [];
      const denom = [];
      let radicand = 1n;
      for (const f of isNum(e.args[0]) ? e.args.slice(1) : e.args) {
        if (f.t === 'pow' && isInt(f.base) && isNum(f.exp) && ncmp(f.exp, HALF) === 0) radicand *= f.base.n; // √2·√3 is written √6
        else if (f.t === 'pow' && isNum(f.exp) && f.exp.n < 0n) denom.push(toDisplay(pow(f.base, nneg(f.exp))));
        else numer.push(toDisplay(f));
      }
      if (radicand !== 1n) numer.unshift({ d: 'sqrt', arg: N(radicand) });
      if (c.n !== 1n || (numer.length === 0 && denom.length === 0)) numer.unshift(N(c.n));
      if (c.d !== 1n) denom.unshift(N(c.d));
      const body = denom.length ? { d: 'frac', num: product(numer), den: product(denom) } : product(numer);
      return coef.n < 0n ? { d: 'neg', arg: body } : body;
    }
    case 'pow': {
      if (isNum(e.exp)) {
        if (ncmp(e.exp, HALF) === 0) return { d: 'sqrt', arg: toDisplay(e.base) };
        if (e.exp.n < 0n) return { d: 'frac', num: N(1), den: toDisplay(pow(e.base, nneg(e.exp))) };
      }
      return { d: 'pow', base: toDisplay(e.base), exp: toDisplay(e.exp) };
    }
    case 'fn':
      return e.name === 'abs' ? { d: 'abs', arg: toDisplay(e.arg) } : { d: 'fn', name: e.name, arg: toDisplay(e.arg) };
    default:
      throw new Error(`cannot display ${e.t}`);
  }
}

/* extra display nodes used for questions and answers */
export const D = {
  deriv: (v, arg) => ({ d: 'deriv', v, arg }),
  integral: (v, arg, lo = null, hi = null) => ({ d: 'integral', v, arg, lo, hi }),
  call: (name, args) => ({ d: 'call', name, args }),
  eq: (a, b) => ({ d: 'eq', a, b }),
  approx: (a, b) => ({ d: 'approx', a, b }),
  list: (items) => ({ d: 'list', items }),
  text: (s) => ({ d: 'text', s }),
  row: (items) => ({ d: 'row', items }),
  sym: (name) => ({ d: 'sym', name }),
  num: N,
};

/* ───────── shared helpers ───────── */

const LOOSE = new Set(['add', 'neg', 'eq', 'approx', 'list', 'row', 'deriv', 'integral']); // need brackets inside a product
const ATOM = new Set(['num', 'sym', 'fn', 'sqrt', 'abs', 'call']);
const startsWithDigit = (d) => d.d === 'num' || (d.d === 'pow' && d.base.d === 'num');
const isMulti = (d) => d.d === 'num' && /^\d{2,}$/.test(d.s);

/* ───────── plain text ───────── */

export function toText(d) {
  const paren = (x, when) => (when ? `(${toText(x)})` : toText(x));
  switch (d.d) {
    case 'num':
      return d.s;
    case 'sym':
      return d.name === 'π' ? 'pi' : d.name;
    case 'text':
      return d.s;
    case 'neg':
      return `-${paren(d.arg, d.arg.d === 'add')}`;
    case 'add':
      return d.terms.map((t, i) => `${i === 0 ? (t.neg ? '-' : '') : t.neg ? ' - ' : ' + '}${paren(t.node, t.node.d === 'add')}`).join('');
    case 'mul':
      return d.factors.map((f, i) => `${i === 0 ? '' : d.factors[i - 1].d === 'num' && !startsWithDigit(f) ? '' : '*'}${paren(f, LOOSE.has(f.d) || f.d === 'frac')}`).join('');
    case 'frac':
      return `${paren(d.num, LOOSE.has(d.num.d))}/${paren(d.den, !ATOM.has(d.den.d) && d.den.d !== 'pow')}`;
    case 'pow':
      return `${paren(d.base, !ATOM.has(d.base.d) || (d.base.d === 'num' && d.base.s.startsWith('-')))}^${paren(d.exp, !(d.exp.d === 'num' || d.exp.d === 'sym'))}`;
    case 'sqrt':
      return `sqrt(${toText(d.arg)})`;
    case 'abs':
      return `|${toText(d.arg)}|`;
    case 'fn':
      return `${d.name}(${toText(d.arg)})`;
    case 'deriv':
      return `d/d${d.v} ${paren(d.arg, true)}`;
    case 'integral':
      return d.lo ? `integral from ${toText(d.lo)} to ${toText(d.hi)} of ${toText(d.arg)} d${d.v}` : `integral of ${toText(d.arg)} d${d.v}`;
    case 'call':
      return `${d.name}(${d.args.map(toText).join(', ')})`;
    case 'eq':
      return `${toText(d.a)} = ${toText(d.b)}`;
    case 'approx':
      return `${toText(d.a)} ≈ ${toText(d.b)}`;
    case 'list':
      return d.items.map(toText).join(', ');
    default:
      return d.items.map(toText).join(' ');
  }
}

/* ───────── LaTeX ───────── */

export function toLatex(d) {
  const L = toLatex;
  const paren = (x, when) => (when ? `\\left(${L(x)}\\right)` : L(x));
  switch (d.d) {
    case 'num':
      return d.s;
    case 'sym':
      return d.name === 'π' ? '\\pi' : d.name;
    case 'text':
      return `\\text{${d.s}}`;
    case 'neg':
      return `-${paren(d.arg, d.arg.d === 'add')}`;
    case 'add':
      return d.terms.map((t, i) => `${i === 0 ? (t.neg ? '-' : '') : t.neg ? ' - ' : ' + '}${paren(t.node, t.node.d === 'add')}`).join('');
    case 'mul':
      return d.factors.map((f, i) => `${i === 0 ? '' : startsWithDigit(f) ? ' \\cdot ' : ' '}${paren(f, LOOSE.has(f.d))}`).join('');
    case 'frac':
      return `\\frac{${L(d.num)}}{${L(d.den)}}`;
    case 'pow':
      if (d.base.d === 'fn' && d.exp.d === 'num') return `\\${d.base.name}^{${d.exp.s}}\\left(${L(d.base.arg)}\\right)`;
      return `${paren(d.base, !ATOM.has(d.base.d) || d.base.d === 'fn')}^{${L(d.exp)}}`;
    case 'sqrt':
      return `\\sqrt{${L(d.arg)}}`;
    case 'abs':
      return `\\left|${L(d.arg)}\\right|`;
    case 'fn':
      return `\\${['asin', 'acos', 'atan'].includes(d.name) ? `arc${d.name.slice(1)}` : d.name}\\left(${L(d.arg)}\\right)`;
    case 'deriv':
      return `\\frac{d}{d${d.v}}\\left[${L(d.arg)}\\right]`;
    case 'integral':
      return `\\int${d.lo ? `_{${L(d.lo)}}^{${L(d.hi)}}` : ''} ${paren(d.arg, d.arg.d === 'add')} \\, d${d.v}`;
    case 'call':
      return `\\operatorname{${d.name}}\\left(${d.args.map(L).join(', ')}\\right)`;
    case 'eq':
      return `${L(d.a)} = ${L(d.b)}`;
    case 'approx':
      return `${L(d.a)} \\approx ${L(d.b)}`;
    case 'list':
      return d.items.map(L).join(',\\quad ');
    default:
      return d.items.map(L).join(' ');
  }
}

/* ───────── HTML ───────── */

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const PAREN_L = '<svg class="reason-m-paren" viewBox="0 0 6 20" preserveAspectRatio="none" aria-hidden="true"><path d="M5 .5Q.8 10 5 19.5" fill="none" stroke="currentColor" stroke-width="1.15" vector-effect="non-scaling-stroke"/></svg>';
const PAREN_R = '<svg class="reason-m-paren" viewBox="0 0 6 20" preserveAspectRatio="none" aria-hidden="true"><path d="M1 .5Q5.2 10 1 19.5" fill="none" stroke="currentColor" stroke-width="1.15" vector-effect="non-scaling-stroke"/></svg>';
const RADICAL = '<svg class="reason-m-radical" viewBox="0 0 10 20" preserveAspectRatio="none" aria-hidden="true"><path d="M.5 12.5L3 11.5 5.6 19 9.6 .6" fill="none" stroke="currentColor" stroke-width="1.15" stroke-linejoin="round" vector-effect="non-scaling-stroke"/></svg>';
const op = (s) => `<span class="reason-m-op">${s}</span>`;
const THIN = '<span class="reason-m-thin"></span>';

/** → { h: html, tall: whether it contains something taller than a line (a fraction) } */
function H(d) {
  const fence = (x, when) => {
    const r = H(x);
    if (!when) return r;
    return r.tall ? { h: `<span class="reason-m-fence">${PAREN_L}<span>${r.h}</span>${PAREN_R}</span>`, tall: true } : { h: `(${r.h})`, tall: false };
  };
  const seq = (parts) => ({ h: parts.map((x) => x.h).join(''), tall: parts.some((x) => x.tall) });
  const raw = (h) => ({ h, tall: false });
  switch (d.d) {
    case 'num':
      return raw(`<span class="reason-m-n">${esc(d.s)}</span>`);
    case 'sym':
      return raw(d.name === 'π' || d.name.length > 1 ? `<span class="reason-m-c">${esc(d.name)}</span>` : `<i class="reason-m-v">${esc(d.name)}</i>`);
    case 'text':
      return raw(`<span class="reason-m-t">${esc(d.s)}</span>`);
    case 'neg':
      return seq([raw('<span class="reason-m-neg">−</span>'), fence(d.arg, d.arg.d === 'add')]);
    case 'add':
      return seq(d.terms.flatMap((t, i) => [raw(i === 0 ? (t.neg ? '<span class="reason-m-neg">−</span>' : '') : op(t.neg ? '−' : '+')), fence(t.node, t.node.d === 'add')]));
    case 'mul':
      return seq(
        d.factors.flatMap((f, i) => {
          const prev = d.factors[i - 1];
          let glue = '';
          if (i > 0) {
            if (startsWithDigit(f)) glue = op('·');
            else if (prev.d === 'num' && (f.d === 'sym' || f.d === 'pow' || LOOSE.has(f.d) || f.d === 'sqrt')) glue = isMulti(prev) && f.d === 'sqrt' ? THIN : '';
            else if (prev.d === 'sym' && f.d === 'sym') glue = '';
            else glue = THIN;
          }
          return [raw(glue), fence(f, LOOSE.has(f.d))];
        }),
      );
    case 'frac':
      return { h: `<span class="reason-m-frac"><span class="reason-m-num">${H(d.num).h}</span><span class="reason-m-den">${H(d.den).h}</span></span>`, tall: true };
    case 'pow': {
      const e = `<span class="reason-m-sup">${H(d.exp).h}</span>`;
      if (d.base.d === 'fn' && d.exp.d === 'num') {
        const arg = fence(d.base.arg, true); // sin²(x)
        return { h: `<span class="reason-m-pow"><span class="reason-m-f">${d.base.name}</span>${e}</span>${arg.h}`, tall: arg.tall };
      }
      const base = fence(d.base, !ATOM.has(d.base.d) || d.base.d === 'fn');
      return { h: `<span class="reason-m-pow"><span>${base.h}</span>${e}</span>`, tall: base.tall };
    }
    case 'sqrt': {
      const r = H(d.arg);
      return { h: `<span class="reason-m-sqrt">${RADICAL}<span class="reason-m-radicand">${r.h}</span></span>`, tall: r.tall };
    }
    case 'abs': {
      const r = H(d.arg);
      return { h: `<span class="reason-m-abs">${r.h}</span>`, tall: r.tall };
    }
    case 'fn': {
      const arg = d.arg.d === 'abs' ? H(d.arg) : fence(d.arg, true);
      return { h: `<span class="reason-m-f">${d.name}</span>${arg.h}`, tall: arg.tall };
    }
    case 'deriv': {
      const arg = fence(d.arg, !ATOM.has(d.arg.d) || d.arg.d === 'num');
      return { h: `<span class="reason-m-frac reason-m-dd"><span class="reason-m-num"><span class="reason-m-c">d</span></span><span class="reason-m-den"><span class="reason-m-c">d</span><i class="reason-m-v">${esc(d.v)}</i></span></span>${THIN}${arg.h}`, tall: true };
    }
    case 'integral': {
      const arg = fence(d.arg, d.arg.d === 'add' || d.arg.d === 'neg');
      const limits = d.lo ? `<span class="reason-m-lim"><span>${H(d.hi).h}</span><span>${H(d.lo).h}</span></span>` : '';
      return { h: `<span class="reason-m-int">∫</span>${limits}${THIN}${arg.h}${THIN}<span class="reason-m-c">d</span><i class="reason-m-v">${esc(d.v)}</i>`, tall: true };
    }
    case 'call':
      return seq([raw(`<span class="reason-m-f">${esc(d.name)}</span>`), ...d.args.map((x, i) => seq([raw(i === 0 ? '(' : ', '), H(x)])), raw(')')]);
    case 'eq':
      return seq([H(d.a), raw(op('=')), H(d.b)]);
    case 'approx':
      return seq([H(d.a), raw(op('≈')), H(d.b)]);
    case 'list':
      return seq(d.items.flatMap((x, i) => (i === 0 ? [H(x)] : [raw('<span class="reason-m-sep">,</span>'), H(x)])));
    default:
      return seq(d.items.flatMap((x, i) => (i === 0 ? [H(x)] : [raw(THIN), H(x)])));
  }
}

export const toHTML = (d) => `<span class="reason-math">${H(d).h}</span>`;

/** Convenience: canonical expression → text. */
export const show = (e) => toText(toDisplay(e));
