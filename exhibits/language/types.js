// Type checker: syntax tree → typed program. Resolves every name to a local slot, a global, a
// constant or an array, checks every operation, and produces the tree that the optimiser, the
// interpreter and the WebAssembly emitter all consume.
import { SableError } from './lexer.js';
import { foldExpr } from './optimise.js';

export const FB_WIDTH = 240;
export const FB_HEIGHT = 160;
const MAX_MEMORY = 16 * 1024 * 1024;
const MAX_ARRAY = 4000000;

/** Functions the module imports from its host, in the order they are imported when used. */
export const IMPORTS = {
  print_i: { params: ['int'], ret: 'void' },
  print_f: { params: ['float'], ret: 'void' },
  print_b: { params: ['bool'], ret: 'void' },
  sin: { params: ['float'], ret: 'float' },
  cos: { params: ['float'], ret: 'float' },
  exp: { params: ['float'], ret: 'float' },
  log: { params: ['float'], ret: 'float' },
  pow: { params: ['float', 'float'], ret: 'float' },
  atan2: { params: ['float', 'float'], ret: 'float' },
};
export const BUILTINS = ['int', 'float', 'sqrt', 'floor', 'ceil', 'abs', 'min', 'max', 'sin', 'cos', 'exp', 'log', 'pow', 'atan2', 'print', 'pixel', 'width', 'height', 'len'];

const lit = (type, v) => ({ k: type, v, type });
const isLit = (e) => e.k === 'int' || e.k === 'float' || e.k === 'bool';
const a = (type) => (type === 'int' ? 'an int' : `a ${type}`);

function editDistance(s, t) {
  const row = Array.from({ length: t.length + 1 }, (_, j) => j);
  for (let i = 1; i <= s.length; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= t.length; j++) {
      const keep = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (s[i - 1] === t[j - 1] ? 0 : 1));
      prev = keep;
    }
  }
  return row[t.length];
}

function suggest(name, candidates) {
  let best = null;
  let bestDistance = Math.max(1, Math.floor(name.length / 3)) + 1;
  for (const c of candidates) {
    const d = editDistance(name.toLowerCase(), c.toLowerCase());
    if (d < bestDistance) {
      best = c;
      bestDistance = d;
    }
  }
  return best ? `did you mean "${best}"?` : null;
}

const mixHint = (x, y) =>
  (x === 'int' && y === 'float') || (x === 'float' && y === 'int') ? 'ints and floats do not mix; convert one side with float(…) or int(…)' : null;

export function check(ast) {
  const program = { fns: [], globals: [], arrays: [], imports: [], usesPixel: false, fbWidth: FB_WIDTH, fbHeight: FB_HEIGHT, memoryBytes: 0 };
  const globals = new Map(); // name → { kind: 'fn' | 'const' | 'global' | 'array', … }
  const usedImports = new Set();
  let fn = null;
  let fnRet = 'void';
  let scopes = [];
  let loopDepth = 0;

  const fail = (message, span, hint) => {
    throw new SableError(message, span, hint);
  };
  const declareGlobal = (name, span, entry) => {
    if (BUILTINS.includes(name)) fail(`"${name}" is built in and cannot be redefined`, span);
    if (globals.has(name)) fail(`"${name}" is already defined`, span);
    globals.set(name, entry);
  };
  const newSlot = (type) => fn.localTypes.push(type) - 1;
  const findLocal = (name) => {
    for (let i = scopes.length - 1; i >= 0; i--) if (scopes[i].has(name)) return scopes[i].get(name);
    return null;
  };
  const unknown = (name, span, what = 'name') =>
    fail(`unknown ${what} "${name}"`, span, suggest(name, [...scopes.flatMap((s) => [...s.keys()]), ...globals.keys(), ...BUILTINS]));
  const arrayOf = (name, span) => {
    const g = globals.get(name);
    if (!g || g.kind !== 'array') {
      if (g || findLocal(name)) fail(`"${name}" is not an array`, span);
      unknown(name, span, 'array');
    }
    return g.index;
  };

  /* ── expressions ── */

  function binary(op, l, r, span) {
    const both = (t) => l.type === t && r.type === t;
    const mismatch = (hint) => fail(`cannot apply "${op}" to ${a(l.type)} and ${a(r.type)}`, span, hint || mixHint(l.type, r.type));
    if (op === '&&' || op === '||') {
      if (!both('bool')) mismatch(`"${op}" joins two bools`);
      return { k: op === '&&' ? 'and' : 'or', l, r, type: 'bool' };
    }
    if (op === '+' || op === '-' || op === '*' || op === '/') {
      if (!both('int') && !both('float')) mismatch();
      return { k: 'bin', op, l, r, type: l.type, operand: l.type };
    }
    if (op === '==' || op === '!=') {
      if (l.type !== r.type) mismatch();
      return { k: 'bin', op, l, r, type: 'bool', operand: l.type };
    }
    if (op === '<' || op === '<=' || op === '>' || op === '>=') {
      if (!both('int') && !both('float')) mismatch();
      return { k: 'bin', op, l, r, type: 'bool', operand: l.type };
    }
    if (!both('int')) mismatch(both('float') ? `"${op}" works on ints only` : null);
    return { k: 'bin', op, l, r, type: 'int', operand: 'int' };
  }

  function call(n) {
    const arity = (k) => {
      if (n.args.length !== k) fail(`"${n.name}" takes ${k} argument${k === 1 ? '' : 's'} but was given ${n.args.length}`, n.span);
    };
    const args = () => n.args.map(value);
    const want = (e, type, i) => {
      if (e.type !== type) fail(`argument ${i + 1} of "${n.name}" should be ${a(type)} but is ${a(e.type)}`, n.args[i].span, mixHint(type, e.type));
    };
    const numeric = (e, i) => {
      if (e.type !== 'int' && e.type !== 'float') fail(`argument ${i + 1} of "${n.name}" should be a number but is ${a(e.type)}`, n.args[i].span);
    };
    switch (n.name) {
      case 'int': {
        arity(1);
        const [e] = args();
        if (e.type === 'int') return e;
        return { k: 'conv', op: e.type === 'float' ? 'f2i' : 'b2i', e, type: 'int' };
      }
      case 'float': {
        arity(1);
        const [e] = args();
        if (e.type === 'float') return e;
        if (e.type !== 'int') fail('float() converts an int', n.args[0].span);
        return { k: 'conv', op: 'i2f', e, type: 'float' };
      }
      case 'sqrt':
      case 'floor':
      case 'ceil': {
        arity(1);
        const [e] = args();
        want(e, 'float', 0);
        return { k: 'builtin', name: n.name, args: [e], type: 'float' };
      }
      case 'abs': {
        arity(1);
        const [e] = args();
        numeric(e, 0);
        return { k: 'builtin', name: e.type === 'int' ? 'abs_i' : 'abs_f', args: [e], type: e.type };
      }
      case 'min':
      case 'max': {
        arity(2);
        const [x, y] = args();
        numeric(x, 0);
        want(y, x.type, 1);
        return { k: 'builtin', name: `${n.name}_${x.type === 'int' ? 'i' : 'f'}`, args: [x, y], type: x.type };
      }
      case 'sin':
      case 'cos':
      case 'exp':
      case 'log':
      case 'pow':
      case 'atan2': {
        const sig = IMPORTS[n.name];
        arity(sig.params.length);
        const list = args();
        list.forEach((e, i) => want(e, 'float', i));
        usedImports.add(n.name);
        return { k: 'builtin', name: n.name, args: list, type: 'float' };
      }
      case 'print': {
        arity(1);
        const [e] = args();
        const name = e.type === 'int' ? 'print_i' : e.type === 'float' ? 'print_f' : 'print_b';
        usedImports.add(name);
        return { k: 'builtin', name, args: [e], type: 'void' };
      }
      case 'pixel': {
        arity(5);
        const list = args();
        list.forEach((e, i) => want(e, 'int', i));
        program.usesPixel = true;
        return { k: 'builtin', name: 'pixel', args: list, type: 'void' };
      }
      case 'width':
        arity(0);
        return lit('int', FB_WIDTH);
      case 'height':
        arity(0);
        return lit('int', FB_HEIGHT);
      case 'len': {
        arity(1);
        if (n.args[0].k !== 'name') fail('len() takes the name of an array', n.args[0].span);
        return lit('int', program.arrays[arrayOf(n.args[0].name, n.args[0].span)].length);
      }
      default:
    }
    const f = globals.get(n.name);
    if (!f || f.kind !== 'fn') {
      if (f || findLocal(n.name)) fail(`"${n.name}" is not a function`, n.nameSpan);
      unknown(n.name, n.nameSpan, 'function');
    }
    if (n.args.length !== f.params.length) fail(`"${n.name}" takes ${f.params.length} argument${f.params.length === 1 ? '' : 's'} but was given ${n.args.length}`, n.span);
    const list = args();
    list.forEach((e, i) => want(e, f.params[i], i));
    return { k: 'call', fn: f.index, args: list, type: f.ret };
  }

  function expr(n) {
    switch (n.k) {
      case 'int': {
        if (n.hex) {
          if (n.v > 0xffffffff) fail('this literal does not fit in 32 bits', n.span);
          return lit('int', n.v | 0);
        }
        if (n.v < -2147483648 || n.v > 2147483647) fail('this literal does not fit in an int, which is 32 bits', n.span, `for a float, write ${n.v}.0`);
        return lit('int', n.v);
      }
      case 'float':
        if (!Number.isFinite(n.v)) fail('this literal is too large for a float', n.span);
        return lit('float', n.v);
      case 'bool':
        return lit('bool', n.v ? 1 : 0);
      case 'name': {
        const local = findLocal(n.name);
        if (local) return { k: 'local', slot: local.slot, type: local.type };
        const g = globals.get(n.name);
        if (!g) unknown(n.name, n.span);
        if (g.kind === 'const') return lit(g.type, g.value);
        if (g.kind === 'global') return { k: 'global', index: g.index, type: g.type };
        if (g.kind === 'array') fail(`"${n.name}" is an array; read an element with ${n.name}[i]`, n.span);
        return fail(`"${n.name}" is a function; call it with ${n.name}(…)`, n.span);
      }
      case 'unary': {
        const e = value(n.e);
        if (n.op === '-' && e.type !== 'int' && e.type !== 'float') fail(`cannot negate ${a(e.type)}`, n.span);
        if (n.op === '!' && e.type !== 'bool') fail(`"!" inverts a bool, but this is ${a(e.type)}`, n.span, e.type === 'int' ? 'for bitwise not, use "~"' : null);
        if (n.op === '~' && e.type !== 'int') fail(`"~" flips the bits of an int, but this is ${a(e.type)}`, n.span);
        return { k: 'unary', op: n.op, e, type: e.type };
      }
      case 'bin':
        return binary(n.op, value(n.l), value(n.r), n.span);
      case 'ifx': {
        const c = condition(n.c);
        const x = value(n.a);
        const y = value(n.b);
        if (x.type !== y.type) fail(`both branches of this if must have the same type, but they are ${a(x.type)} and ${a(y.type)}`, n.span, mixHint(x.type, y.type));
        return { k: 'ifx', c, a: x, b: y, type: x.type };
      }
      case 'index': {
        const arr = arrayOf(n.name, n.nameSpan);
        const idx = value(n.idx);
        if (idx.type !== 'int') fail(`an array index must be an int, but this is ${a(idx.type)}`, n.idx.span);
        return { k: 'index', arr, idx, type: program.arrays[arr].elem };
      }
      default:
        return call(n);
    }
  }

  /** An expression used for its value: must not be a call that returns nothing. */
  function value(n) {
    const e = expr(n);
    if (e.type === 'void') fail('this call returns nothing, so it cannot be used as a value', n.span);
    return e;
  }

  function condition(n) {
    const c = value(n);
    if (c.type !== 'bool') fail(`a condition must be a bool, but this is ${a(c.type)}`, n.span, c.type === 'int' ? 'compare it with something, for example "x != 0"' : null);
    return c;
  }

  /* ── statements ── */

  function block(stmts) {
    scopes.push(new Map());
    const out = stmts.map(statement);
    scopes.pop();
    return out;
  }

  function statement(s) {
    switch (s.k) {
      case 'let': {
        const e = value(s.init);
        if (s.type && s.type !== e.type) fail(`"${s.name}" is declared as ${a(s.type)} but its value is ${a(e.type)}`, s.init.span, mixHint(s.type, e.type));
        const scope = scopes[scopes.length - 1];
        if (scope.has(s.name)) fail(`"${s.name}" is already defined in this block`, s.nameSpan);
        const slot = newSlot(e.type);
        scope.set(s.name, { slot, type: e.type, fixed: s.mutable ? null : 'was declared with let' });
        return { k: 'let', slot, e };
      }
      case 'assign': {
        const binop = s.op === '=' ? null : s.op.slice(0, -1);
        if (s.target.k === 'index') {
          const arr = arrayOf(s.target.name, s.target.nameSpan);
          const elem = program.arrays[arr].elem;
          const idx = value(s.target.idx);
          if (idx.type !== 'int') fail(`an array index must be an int, but this is ${a(idx.type)}`, s.target.idx.span);
          const e = value(s.value);
          if (!binop) {
            if (e.type !== elem) fail(`"${s.target.name}" holds ${elem}s, so ${a(e.type)} cannot be stored in it`, s.value.span, mixHint(elem, e.type));
            return { k: 'assign', target: { k: 'index', arr, idx, type: elem }, e };
          }
          // a[i] += e evaluates i once: keep it in a hidden local
          const tmp = newSlot('int');
          const at = { k: 'index', arr, idx: { k: 'local', slot: tmp, type: 'int' }, type: elem };
          return { k: 'block', body: [{ k: 'let', slot: tmp, e: idx }, { k: 'assign', target: at, e: binary(binop, at, e, s.span) }] };
        }
        const name = s.target.name;
        const local = findLocal(name);
        let ref;
        if (local) {
          if (local.fixed) fail(`"${name}" ${local.fixed}, so it cannot be changed`, s.target.span, 'declare it with var to make it changeable');
          ref = { k: 'local', slot: local.slot, type: local.type };
        } else {
          const g = globals.get(name);
          if (!g) unknown(name, s.target.span);
          if (g.kind !== 'global') fail(`"${name}" is ${g.kind === 'const' ? 'a constant' : g.kind === 'fn' ? 'a function' : 'an array'}, so it cannot be assigned to`, s.target.span);
          ref = { k: 'global', index: g.index, type: g.type };
        }
        let e = value(s.value);
        if (binop) e = binary(binop, ref, e, s.span);
        else if (e.type !== ref.type) fail(`"${name}" is ${a(ref.type)}, so ${a(e.type)} cannot be assigned to it`, s.value.span, mixHint(ref.type, e.type));
        return { k: 'assign', target: ref, e };
      }
      case 'if':
        return { k: 'if', c: condition(s.cond), then: block(s.then), else: s.else ? block(s.else) : null };
      case 'while': {
        const c = condition(s.cond);
        loopDepth++;
        const body = block(s.body);
        loopDepth--;
        return { k: 'while', c, body };
      }
      case 'for': {
        const from = value(s.from);
        const to = value(s.to);
        if (from.type !== 'int') fail(`a range starts at an int, but this is ${a(from.type)}`, s.from.span);
        if (to.type !== 'int') fail(`a range ends at an int, but this is ${a(to.type)}`, s.to.span);
        const slot = newSlot('int');
        const endSlot = newSlot('int');
        scopes.push(new Map([[s.name, { slot, type: 'int', fixed: 'is a loop counter' }]]));
        loopDepth++;
        const body = block(s.body);
        loopDepth--;
        scopes.pop();
        return { k: 'for', slot, endSlot, from, to, body };
      }
      case 'break':
      case 'continue':
        if (!loopDepth) fail(`"${s.k}" only makes sense inside a loop`, s.span);
        return { k: s.k };
      case 'return': {
        if (!s.value) {
          if (fnRet !== 'void') fail(`this function must return ${a(fnRet)}`, s.span);
          return { k: 'return', e: null };
        }
        if (fnRet === 'void') fail('this function returns nothing', s.value.span, 'declare a return type, for example "fn f() -> int"');
        const e = value(s.value);
        if (e.type !== fnRet) fail(`this function returns ${a(fnRet)}, but this value is ${a(e.type)}`, s.value.span, mixHint(fnRet, e.type));
        return { k: 'return', e };
      }
      case 'block':
        return { k: 'block', body: block(s.body) };
      default:
        return { k: 'expr', e: expr(s.e) };
    }
  }

  /** Does control always leave through a return? */
  const returns = (stmts) => {
    const last = stmts[stmts.length - 1];
    if (!last) return false;
    if (last.k === 'return') return true;
    if (last.k === 'block') return returns(last.body);
    return last.k === 'if' && !!last.else && returns(last.then) && returns(last.else);
  };

  /* ── top level ── */

  // signatures first, so functions may call each other in any order
  for (const item of ast.items) {
    if (item.k !== 'fn') continue;
    if (item.name === 'memory') fail('"memory" is the name of the module\'s own memory, so a function cannot be called that', item.nameSpan);
    declareGlobal(item.name, item.nameSpan, { kind: 'fn', index: program.fns.length, params: item.params.map((p) => p.type), ret: item.ret });
    program.fns.push({ name: item.name, params: item.params.map((p) => p.type), ret: item.ret, localTypes: [], body: [] });
  }

  const constant = (node, what) => {
    const e = foldExpr(value(node));
    if (!isLit(e)) fail(`${what} must be computable when the program is compiled`, node.span, 'use literals and other constants only');
    return e;
  };
  let offset = FB_WIDTH * FB_HEIGHT * 4;
  for (const item of ast.items) {
    if (item.k === 'const' || item.k === 'gvar') {
      const e = constant(item.init, item.k === 'const' ? 'a constant' : 'the starting value of a global');
      if (item.type && item.type !== e.type) fail(`"${item.name}" is declared as ${a(item.type)} but its value is ${a(e.type)}`, item.init.span, mixHint(item.type, e.type));
      if (item.k === 'const') declareGlobal(item.name, item.nameSpan, { kind: 'const', type: e.type, value: e.v });
      else {
        declareGlobal(item.name, item.nameSpan, { kind: 'global', index: program.globals.length, type: e.type });
        program.globals.push({ name: item.name, type: e.type, init: e.v });
      }
    } else if (item.k === 'array') {
      const n = constant(item.length, 'an array length');
      if (n.type !== 'int' || n.v < 1 || n.v > MAX_ARRAY) fail('an array length must be an int between 1 and 4,000,000', item.length.span);
      offset = (offset + 7) & ~7;
      declareGlobal(item.name, item.nameSpan, { kind: 'array', index: program.arrays.length });
      program.arrays.push({ name: item.name, elem: item.elem, length: n.v, offset });
      offset += n.v * (item.elem === 'float' ? 8 : 4);
      if (offset > MAX_MEMORY) fail('these arrays need more than 16 MB of memory', item.span);
    }
  }
  program.memoryBytes = offset;

  for (const item of ast.items) {
    if (item.k !== 'fn') continue;
    fn = program.fns[globals.get(item.name).index];
    fnRet = item.ret;
    loopDepth = 0;
    scopes = [new Map()];
    for (const p of item.params) {
      if (scopes[0].has(p.name)) fail(`two parameters are both called "${p.name}"`, p.span);
      scopes[0].set(p.name, { slot: newSlot(p.type), type: p.type, fixed: 'is a parameter' });
    }
    fn.body = block(item.body);
    if (item.ret !== 'void' && !returns(fn.body)) fail(`"${item.name}" must return ${a(item.ret)} on every path`, item.nameSpan);
  }
  program.imports = Object.keys(IMPORTS).filter((n) => usedImports.has(n));
  return program;
}
