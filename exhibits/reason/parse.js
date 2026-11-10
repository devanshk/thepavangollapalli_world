// Parser for ordinary mathematical notation: implicit multiplication (2x, x(x + 1), 2 sin(x)),
// ^ for powers, unary minus that binds looser than ^, factorials, |x|, and a single = for
// equations. It produces a small syntax tree; build() turns the mathematical part of that tree
// into a canonical expression.
import { MathError, num, int, sym, add, mul, pow, fn, neg, sub, div, isInt, E, PI, I } from './core.js';

export const COMMANDS = ['integrate', 'simplify', 'numeric', 'factor', 'expand', 'series', 'taylor', 'approx', 'solve', 'diff', 'int', 'N'];
const FUNCS = ['arcsin', 'arccos', 'arctan', 'asin', 'acos', 'atan', 'sinh', 'cosh', 'tanh', 'sqrt', 'sin', 'cos', 'tan', 'exp', 'log', 'abs', 'ln'];
const ALIAS = { arcsin: 'asin', arccos: 'acos', arctan: 'atan' };
const WORDS = [...COMMANDS, ...FUNCS, 'pi'].sort((a, b) => b.length - a.length);
const SUPERSCRIPT = { '²': '2', '³': '3', '⁴': '4', '⁵': '5', '⁶': '6', '⁷': '7', '⁸': '8', '⁹': '9' };

function tokenize(text) {
  const out = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (/[0-9.]/.test(c)) {
      const m = /^(\d+\.?\d*|\.\d+)/.exec(text.slice(i));
      if (!m) throw new MathError('a lone "." is not a number', i);
      i += m[0].length;
      if (text[i] === '.' || (m[0].endsWith('.') && /\d/.test(text[i] || ''))) throw new MathError('that number has two decimal points', i);
      out.push({ type: 'num', text: m[0], pos: i - m[0].length });
      continue;
    }
    if (/[A-Za-z]/.test(c)) {
      // a known word if one starts here, otherwise a one-letter variable: "xy" means x·y
      const rest = text.slice(i);
      const word = WORDS.find((w) => rest.startsWith(w) && (w.length > 1 || !/^[A-Za-z]/.test(rest[1] || '')));
      const name = word || c;
      out.push({ type: 'name', text: name, pos: i });
      i += name.length;
      continue;
    }
    if (SUPERSCRIPT[c]) {
      out.push({ type: 'op', text: '^', pos: i }, { type: 'num', text: SUPERSCRIPT[c], pos: i });
      i++;
      continue;
    }
    const mapped = { '−': '-', '–': '-', '·': '*', '×': '*', '÷': '/', π: 'pi', '√': 'sqrt' }[c];
    if (mapped === 'pi' || mapped === 'sqrt') out.push({ type: 'name', text: mapped, pos: i });
    else if ('+-*/^()=,!|'.includes(mapped || c)) out.push({ type: 'op', text: mapped || c, pos: i });
    else throw new MathError(`I do not know what "${c}" means here`, i);
    i++;
  }
  out.push({ type: 'end', text: '', pos: text.length });
  return out;
}

/** parse(text) → syntax tree: { s: 'num' | 'sym' | 'add' | 'sub' | 'mul' | 'div' | 'pow' | 'neg' | 'fact' | 'call' | 'eq', … } */
export function parse(text) {
  const toks = tokenize(text);
  let p = 0;
  let bars = 0; // depth of open |…| pairs, so a closing bar is not read as an opening one
  const peek = () => toks[p];
  const isOp = (t) => toks[p].type === 'op' && toks[p].text === t;
  const expectOp = (t) => {
    if (!isOp(t)) throw new MathError(peek().type === 'end' ? `the expression ends before a "${t}"` : `I expected "${t}" here, not "${peek().text}"`, peek().pos);
    p++;
  };
  const startsFactor = () => {
    const t = peek();
    return t.type === 'num' || t.type === 'name' || (t.type === 'op' && (t.text === '(' || (t.text === '|' && bars === 0)));
  };

  function equation() {
    const left = sum();
    if (!isOp('=')) return left;
    p++;
    return { s: 'eq', a: left, b: sum() };
  }
  function sum() {
    let left = term();
    while (isOp('+') || isOp('-')) {
      const s = toks[p++].text === '+' ? 'add' : 'sub';
      left = { s, a: left, b: term() };
    }
    return left;
  }
  function term() {
    let left = unary();
    for (;;) {
      if (isOp('*') || isOp('/')) {
        const s = toks[p++].text === '*' ? 'mul' : 'div';
        left = { s, a: left, b: unary() };
      } else if (startsFactor()) left = { s: 'mul', a: left, b: power() }; // implicit multiplication
      else return left;
    }
  }
  function unary() {
    if (isOp('-')) {
      p++;
      return { s: 'neg', a: unary() };
    }
    if (isOp('+')) {
      p++;
      return unary();
    }
    return power();
  }
  function power() {
    let base = primary();
    while (isOp('!')) {
      p++;
      base = { s: 'fact', a: base };
    }
    if (isOp('^')) {
      p++;
      return { s: 'pow', a: base, b: unary() }; // right-associative, and 2^-x is allowed
    }
    return base;
  }
  function primary() {
    const t = toks[p++];
    if (t.type === 'num') return { s: 'num', text: t.text };
    if (t.type === 'op' && t.text === '(') {
      const saved = bars;
      bars = 0;
      const inner = equation();
      expectOp(')');
      bars = saved;
      return inner;
    }
    if (t.type === 'op' && t.text === '|') {
      bars++;
      const inner = sum();
      expectOp('|');
      bars--;
      return { s: 'call', name: 'abs', args: [inner] };
    }
    if (t.type === 'name') {
      const name = ALIAS[t.text] || t.text;
      if (COMMANDS.includes(name) || FUNCS.includes(t.text)) {
        if (isOp('(')) {
          p++;
          const args = [];
          if (!isOp(')')) {
            do args.push(equation());
            while (isOp(',') && ++p);
          }
          expectOp(')');
          return { s: 'call', name, args, pos: t.pos };
        }
        if (COMMANDS.includes(name)) throw new MathError(`"${name}" needs its arguments in brackets, as in ${name}(…)`, t.pos);
        return { s: 'call', name, args: [power()], pos: t.pos }; // "sin x"
      }
      return { s: 'sym', name };
    }
    throw new MathError(t.type === 'end' ? 'the expression ends too soon' : `I did not expect "${t.text}" here`, t.pos);
  }

  const tree = equation();
  if (peek().type !== 'end') throw new MathError(`I did not expect "${peek().text}" here`, peek().pos);
  return tree;
}

function factorial(e) {
  if (!isInt(e) || e.n < 0n) throw new MathError('a factorial needs a whole number that is not negative');
  if (e.n > 2000n) throw new MathError('that factorial is too large to write out');
  let out = 1n;
  for (let k = 2n; k <= e.n; k++) out *= k;
  return int(out);
}

/** Turn a syntax tree (without commands or =) into a canonical expression. */
export function build(t) {
  switch (t.s) {
    case 'num': {
      const [whole, frac = ''] = t.text.split('.');
      return num(BigInt((whole || '0') + frac), 10n ** BigInt(frac.length)); // decimals are exact: 0.25 is 1/4
    }
    case 'sym':
      return t.name === 'e' ? E : t.name === 'pi' ? PI : t.name === 'i' ? I : sym(t.name);
    case 'add':
      return add(build(t.a), build(t.b));
    case 'sub':
      return sub(build(t.a), build(t.b));
    case 'mul':
      return mul(build(t.a), build(t.b));
    case 'div':
      return div(build(t.a), build(t.b));
    case 'pow':
      return pow(build(t.a), build(t.b));
    case 'neg':
      return neg(build(t.a));
    case 'fact':
      return factorial(build(t.a));
    case 'call':
      if (COMMANDS.includes(t.name)) throw new MathError(`"${t.name}" can only be used on its own, not inside another expression`, t.pos);
      if (t.args.length !== 1) throw new MathError(`${t.name} takes one argument`, t.pos);
      return fn(t.name, build(t.args[0]));
    default:
      throw new MathError('an equation can only be used with solve');
  }
}
