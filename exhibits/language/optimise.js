// Optimiser: constant folding and dead-code removal on the typed tree. Folding uses the same
// arithmetic as the interpreter (ops.js), and never folds an operation that would trap, so an
// optimised program behaves exactly like the unoptimised one.
import { binOps, truncToInt, absInt, Trap } from './ops.js';

const lit = (type, v) => ({ k: type, v, type });
const isLit = (e) => e.k === 'int' || e.k === 'float' || e.k === 'bool';

const PURE = {
  sqrt: Math.sqrt,
  floor: Math.floor,
  ceil: Math.ceil,
  abs_f: Math.abs,
  abs_i: absInt,
  min_f: Math.min,
  max_f: Math.max,
  min_i: (x, y) => (x < y ? x : y),
  max_i: (x, y) => (x > y ? x : y),
};

export function foldExpr(e) {
  switch (e.k) {
    case 'unary': {
      const x = foldExpr(e.e);
      if (isLit(x)) {
        if (e.op === '!') return lit('bool', x.v ? 0 : 1);
        if (e.op === '~') return lit('int', ~x.v);
        return lit(x.type, x.type === 'int' ? (0 - x.v) | 0 : -x.v);
      }
      return { ...e, e: x };
    }
    case 'bin': {
      const l = foldExpr(e.l);
      const r = foldExpr(e.r);
      if (isLit(l) && isLit(r)) {
        try {
          return lit(e.type, binOps(e.operand)[e.op](l.v, r.v));
        } catch (err) {
          if (!(err instanceof Trap)) throw err; // a division by zero stays in the program and traps when it runs
        }
      }
      return { ...e, l, r };
    }
    case 'and':
    case 'or': {
      const l = foldExpr(e.l);
      const r = foldExpr(e.r);
      if (isLit(l)) {
        if (e.k === 'and') return l.v ? r : lit('bool', 0);
        return l.v ? lit('bool', 1) : r;
      }
      return { ...e, l, r };
    }
    case 'ifx': {
      const c = foldExpr(e.c);
      const x = foldExpr(e.a);
      const y = foldExpr(e.b);
      if (isLit(c)) return c.v ? x : y;
      return { ...e, c, a: x, b: y };
    }
    case 'conv': {
      const x = foldExpr(e.e);
      if (isLit(x)) {
        if (e.op === 'i2f') return lit('float', x.v);
        if (e.op === 'b2i') return lit('int', x.v);
        try {
          return lit('int', truncToInt(x.v));
        } catch (err) {
          if (!(err instanceof Trap)) throw err;
        }
      }
      return { ...e, e: x };
    }
    case 'builtin': {
      const args = e.args.map(foldExpr);
      if (PURE[e.name] && args.every(isLit)) return lit(e.type, PURE[e.name](...args.map((x) => x.v)));
      return { ...e, args };
    }
    case 'call':
      return { ...e, args: e.args.map(foldExpr) };
    case 'index':
      return { ...e, idx: foldExpr(e.idx) };
    default:
      return e;
  }
}

function foldBlock(stmts) {
  const out = [];
  for (const s of stmts) {
    const t = foldStatement(s);
    if (!t) continue;
    out.push(t);
    if (t.k === 'return' || t.k === 'break' || t.k === 'continue') break; // nothing after this can run
  }
  return out;
}

function foldStatement(s) {
  switch (s.k) {
    case 'let':
      return { ...s, e: foldExpr(s.e) };
    case 'assign':
      return { ...s, target: s.target.k === 'index' ? foldExpr(s.target) : s.target, e: foldExpr(s.e) };
    case 'if': {
      const c = foldExpr(s.c);
      const then = foldBlock(s.then);
      const otherwise = s.else ? foldBlock(s.else) : null;
      if (isLit(c)) {
        const taken = c.v ? then : otherwise || [];
        return taken.length ? { k: 'block', body: taken } : null;
      }
      return { k: 'if', c, then, else: otherwise && otherwise.length ? otherwise : null };
    }
    case 'while': {
      const c = foldExpr(s.c);
      if (isLit(c) && !c.v) return null;
      return { k: 'while', c, body: foldBlock(s.body) };
    }
    case 'for':
      return { ...s, from: foldExpr(s.from), to: foldExpr(s.to), body: foldBlock(s.body) };
    case 'return':
      return { k: 'return', e: s.e ? foldExpr(s.e) : null };
    case 'block': {
      const body = foldBlock(s.body);
      return body.length ? { k: 'block', body } : null;
    }
    case 'expr': {
      const e = foldExpr(s.e);
      return isLit(e) ? null : { k: 'expr', e };
    }
    default:
      return s;
  }
}

/** optimise(program) → a new program; the input is left untouched. */
export function optimise(program) {
  return { ...program, fns: program.fns.map((f) => ({ ...f, body: foldBlock(f.body) })) };
}
