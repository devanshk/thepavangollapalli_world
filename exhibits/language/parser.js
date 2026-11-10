// Parser: tokens → syntax tree. Recursive descent for declarations and statements,
// precedence climbing (Pratt) for expressions.
import { lex, SableError } from './lexer.js';

// binding power of each binary operator, loosest first; all are left-associative
const BINARY = { '||': 1, '&&': 2, '|': 3, '^': 4, '&': 5, '==': 6, '!=': 6, '<': 7, '<=': 7, '>': 7, '>=': 7, '<<': 8, '>>': 8, '+': 9, '-': 9, '*': 10, '/': 10, '%': 10 };
const ASSIGN = ['=', '+=', '-=', '*=', '/=', '%='];

export function parse(source) {
  const toks = lex(source);
  let p = 0;
  const peek = () => toks[p];
  const next = () => toks[p++];
  const is = (type, text) => toks[p].type === type && (text === undefined || toks[p].text === text);
  const join = (a, b) => ({ start: a.start, end: b.end, line: a.line, col: a.col });
  const show = (t) => (t.type === 'eof' ? 'the end of the file' : `"${t.text}"`);
  const fail = (message, span, hint) => {
    throw new SableError(message, span, hint);
  };
  // the position just after the previous token: where a missing ";" or "}" belongs
  const afterPrev = () => {
    const s = toks[Math.max(0, p - 1)].span;
    return { start: s.end, end: s.end + 1, line: s.line, col: s.col + (s.end - s.start) };
  };
  const expect = (type, text, what) => {
    if (is(type, text)) return next();
    const here = text === ';' || text === ')' || text === ']' ? afterPrev() : peek().span;
    return fail(`expected ${what || `"${text}"`} but found ${show(peek())}`, here);
  };
  const op = (text, what) => expect('op', text, what);
  const name = (what) => expect('name', undefined, what);
  const type = () => expect('type', undefined, 'a type (int, float or bool)').text;

  function program() {
    const items = [];
    while (!is('eof')) {
      if (is('kw', 'fn')) items.push(fn());
      else if (is('kw', 'const') || is('kw', 'var')) items.push(globalValue());
      else if (is('kw', 'array')) items.push(array());
      else fail(`expected a declaration (fn, const, var or array) but found ${show(peek())}`, peek().span, 'statements belong inside a function');
    }
    return { items };
  }

  function fn() {
    const kw = next();
    const id = name('a function name');
    op('(');
    const params = [];
    while (!is('op', ')')) {
      const pn = name('a parameter name');
      op(':', `":" and a type after the parameter "${pn.text}"`);
      params.push({ name: pn.text, type: type(), span: pn.span });
      if (!is('op', ')')) op(',', '"," or ")"');
    }
    op(')');
    let ret = 'void';
    if (is('op', '->')) {
      next();
      ret = type();
    }
    const body = block();
    return { k: 'fn', name: id.text, nameSpan: id.span, params, ret, body, span: join(kw.span, id.span) };
  }

  function globalValue() {
    const kw = next();
    const id = name('a name');
    let declared = null;
    if (is('op', ':')) {
      next();
      declared = type();
    }
    op('=', `"=" and a value for "${id.text}"`);
    const init = expr();
    op(';');
    return { k: kw.text === 'const' ? 'const' : 'gvar', name: id.text, nameSpan: id.span, type: declared, init, span: join(kw.span, init.span) };
  }

  function array() {
    const kw = next();
    const id = name('an array name');
    op(':', '":" and an element type, as in "array grid: int[64];"');
    const elemTok = peek();
    const elem = type();
    if (elem === 'bool') fail('arrays hold int or float elements', elemTok.span);
    op('[', '"[" and the number of elements');
    const length = expr();
    op(']');
    op(';');
    return { k: 'array', name: id.text, nameSpan: id.span, elem, length, span: join(kw.span, id.span) };
  }

  function block() {
    op('{');
    const body = [];
    while (!is('op', '}')) {
      if (is('eof')) fail('this block is never closed with "}"', afterPrev());
      body.push(statement());
    }
    next();
    return body;
  }

  function statement() {
    const t = peek();
    if (t.type === 'kw') {
      switch (t.text) {
        case 'let':
        case 'var': {
          next();
          const id = name('a variable name');
          let declared = null;
          if (is('op', ':')) {
            next();
            declared = type();
          }
          op('=', `"=" and a value for "${id.text}"`);
          const init = expr();
          op(';');
          return { k: 'let', mutable: t.text === 'var', name: id.text, nameSpan: id.span, type: declared, init, span: join(t.span, init.span) };
        }
        case 'if':
          return ifStatement();
        case 'while': {
          next();
          const cond = expr();
          return { k: 'while', cond, body: block(), span: t.span };
        }
        case 'for': {
          next();
          const id = name('a loop variable');
          expect('kw', 'in', '"in", as in "for i in 0..10"');
          const from = expr();
          op('..', '".." between the two ends of the range');
          const to = expr();
          return { k: 'for', name: id.text, nameSpan: id.span, from, to, body: block(), span: t.span };
        }
        case 'break':
        case 'continue':
          next();
          op(';');
          return { k: t.text, span: t.span };
        case 'return': {
          next();
          const value = is('op', ';') ? null : expr();
          op(';');
          return { k: 'return', value, span: t.span };
        }
        case 'fn':
          return fail('functions cannot be declared inside other functions', t.span);
        default:
      }
    }
    if (is('op', '{')) return { k: 'block', body: block(), span: t.span };
    const e = expr();
    if (peek().type === 'op' && ASSIGN.includes(peek().text)) {
      const assign = next();
      if (e.k !== 'name' && e.k !== 'index') fail('only a variable or an array element can be assigned to', e.span);
      const value = expr();
      op(';');
      return { k: 'assign', target: e, op: assign.text, value, span: join(e.span, value.span) };
    }
    op(';');
    return { k: 'expr', e, span: e.span };
  }

  function ifStatement() {
    const kw = next();
    const cond = expr();
    const then = block();
    let otherwise = null;
    if (is('kw', 'else')) {
      next();
      otherwise = is('kw', 'if') ? [ifStatement()] : block();
    }
    return { k: 'if', cond, then, else: otherwise, span: kw.span };
  }

  function expr(minPower = 1) {
    let left = unary();
    for (;;) {
      const t = peek();
      const power = t.type === 'op' ? BINARY[t.text] : undefined;
      if (!power || power < minPower) return left;
      next();
      const right = expr(power + 1);
      left = { k: 'bin', op: t.text, l: left, r: right, span: join(left.span, right.span) };
    }
  }

  function unary() {
    const t = peek();
    if (t.type === 'op' && (t.text === '-' || t.text === '!' || t.text === '~')) {
      next();
      const e = unary();
      const span = join(t.span, e.span);
      // "-5" is a literal, so that -2147483648 can be written
      if (t.text === '-' && (e.k === 'int' || e.k === 'float') && !e.negated) return { ...e, v: -e.v, negated: true, span };
      return { k: 'unary', op: t.text, e, span };
    }
    return primary();
  }

  function ifExpression() {
    const kw = next();
    const c = expr();
    op('{');
    const a = expr();
    op('}', '"}" (an if used as a value holds one expression per branch)');
    expect('kw', 'else', '"else" (an if used as a value needs both branches)');
    let b;
    if (is('kw', 'if')) b = ifExpression();
    else {
      op('{');
      b = expr();
      op('}');
    }
    return { k: 'ifx', c, a, b, span: join(kw.span, b.span) };
  }

  function primary() {
    const t = peek();
    if (t.type === 'int') {
      next();
      return { k: 'int', v: t.value, hex: t.hex, span: t.span };
    }
    if (t.type === 'float') {
      next();
      return { k: 'float', v: t.value, span: t.span };
    }
    if (t.type === 'kw' && (t.text === 'true' || t.text === 'false')) {
      next();
      return { k: 'bool', v: t.text === 'true', span: t.span };
    }
    if (t.type === 'kw' && t.text === 'if') return ifExpression();
    if (t.type === 'op' && t.text === '(') {
      next();
      const e = expr();
      op(')');
      return e;
    }
    if (t.type === 'name' || t.type === 'type') {
      next();
      if (is('op', '(')) {
        next();
        const args = [];
        while (!is('op', ')')) {
          args.push(expr());
          if (!is('op', ')')) op(',', '"," or ")"');
        }
        const close = next();
        return { k: 'call', name: t.text, nameSpan: t.span, args, span: join(t.span, close.span) };
      }
      if (t.type === 'type') fail(`"${t.text}" is a type; to convert a value write ${t.text}(…)`, t.span);
      if (is('op', '[')) {
        next();
        const idx = expr();
        const close = op(']');
        return { k: 'index', name: t.text, nameSpan: t.span, idx, span: join(t.span, close.span) };
      }
      return { k: 'name', name: t.text, span: t.span };
    }
    return fail(`expected a value but found ${show(t)}`, t.span);
  }

  return program();
}
