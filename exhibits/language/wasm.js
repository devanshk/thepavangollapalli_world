// Code generator: typed program → a WebAssembly binary, written out byte by byte.
// Only MVP features are used. Layout of linear memory: the framebuffer (RGBA, width × height)
// starts at address 0 and the program's arrays follow it.
import { IMPORTS } from './types.js';

const I32 = 0x7f;
const F64 = 0x7c;
const EMPTY = 0x40;
const valType = (t) => (t === 'float' ? F64 : I32);

/** Unsigned LEB128 */
export function uleb(n, out = []) {
  n >>>= 0;
  do {
    let byte = n & 0x7f;
    n >>>= 7;
    if (n !== 0) byte |= 0x80;
    out.push(byte);
  } while (n !== 0);
  return out;
}

/** Signed LEB128 of a 32-bit integer */
export function sleb(n, out = []) {
  n |= 0;
  for (;;) {
    const byte = n & 0x7f;
    n >>= 7;
    if ((n === 0 && (byte & 0x40) === 0) || (n === -1 && (byte & 0x40) !== 0)) {
      out.push(byte);
      return out;
    }
    out.push(byte | 0x80);
  }
}

function f64Bytes(x) {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, x, true);
  return [...new Uint8Array(view.buffer)];
}

function utf8(text) {
  const out = [];
  for (const ch of unescape(encodeURIComponent(text))) out.push(ch.charCodeAt(0));
  return out;
}
const str = (text) => {
  const bytes = utf8(text);
  return [...uleb(bytes.length), ...bytes];
};
const vec = (items) => [...uleb(items.length), ...items.flat()];
const section = (id, content) => [id, ...uleb(content.length), ...content];

const INT_OP = { '+': 0x6a, '-': 0x6b, '*': 0x6c, '/': 0x6d, '%': 0x6f, '&': 0x71, '|': 0x72, '^': 0x73, '<<': 0x74, '>>': 0x75, '==': 0x46, '!=': 0x47, '<': 0x48, '>': 0x4a, '<=': 0x4c, '>=': 0x4e };
const FLOAT_OP = { '+': 0xa0, '-': 0xa1, '*': 0xa2, '/': 0xa3, '==': 0x61, '!=': 0x62, '<': 0x63, '>': 0x64, '<=': 0x65, '>=': 0x66 };
const FLOAT_UNARY = { sqrt: 0x9f, floor: 0x9c, ceil: 0x9b, abs_f: 0x99 };

/** emit(program) → { bytes: Uint8Array, funcNames: string[] } (funcNames indexes the function space) */
export function emit(program) {
  const nImports = program.imports.length;
  const pixelIndex = nImports + program.fns.length;

  const types = [];
  const typeIds = new Map();
  const typeOf = (params, ret) => {
    const key = `${params.map(valType).join(',')}>${ret === 'void' ? '' : valType(ret)}`; // bool and int share a signature
    if (!typeIds.has(key)) {
      typeIds.set(key, types.length);
      types.push([0x60, ...vec(params.map((p) => [valType(p)])), ...(ret === 'void' ? [0] : [1, valType(ret)])]);
    }
    return typeIds.get(key);
  };
  const importTypes = program.imports.map((name) => typeOf(IMPORTS[name].params, IMPORTS[name].ret));
  const fnTypes = program.fns.map((f) => typeOf(f.params, f.ret));
  if (program.usesPixel) fnTypes.push(typeOf(['int', 'int', 'int', 'int', 'int'], 'void'));

  function body(fn) {
    const c = [];
    const scratchBase = fn.localTypes.length;
    let scratchUsed = 0;
    const scratch = (i) => {
      scratchUsed = Math.max(scratchUsed, i + 1);
      return scratchBase + i;
    };
    // enclosing blocks, innermost last; a branch names its target by how many blocks out it is
    const ctrl = [];
    const open = (opcode, role, blockType = EMPTY) => {
      c.push(opcode, blockType);
      ctrl.push(role);
    };
    const close = () => {
      c.push(0x0b);
      ctrl.pop();
    };
    const branch = (opcode, role) => {
      c.push(opcode);
      uleb(ctrl.length - 1 - ctrl.lastIndexOf(role), c);
    };
    const i32 = (v) => {
      c.push(0x41);
      sleb(v, c);
    };
    const local = (opcode, slot) => {
      c.push(opcode);
      uleb(slot, c);
    };

    /** Leaves the byte address of arr[idx] on the stack (minus the array's base, which the load adds). */
    function address(e) {
      const arr = program.arrays[e.arr];
      expr(e.idx);
      local(0x22, scratch(0)); // tee
      i32(arr.length);
      c.push(0x4f, 0x04, EMPTY, 0x00, 0x0b); // i32.ge_u; if; unreachable; end  — the bounds check
      local(0x20, scratch(0));
      i32(arr.elem === 'float' ? 3 : 2);
      c.push(0x74); // shl
      return arr;
    }
    const memory = (opcode, arr) => {
      c.push(opcode);
      uleb(arr.elem === 'float' ? 3 : 2, c);
      uleb(arr.offset, c);
    };

    function expr(e) {
      switch (e.k) {
        case 'int':
        case 'bool':
          return i32(e.v);
        case 'float':
          return c.push(0x44, ...f64Bytes(e.v));
        case 'local':
          return local(0x20, e.slot);
        case 'global':
          return local(0x23, e.index);
        case 'bin':
          expr(e.l);
          expr(e.r);
          return c.push((e.operand === 'float' ? FLOAT_OP : INT_OP)[e.op]);
        case 'unary':
          if (e.op === '!') {
            expr(e.e);
            return c.push(0x45);
          }
          if (e.op === '~') {
            expr(e.e);
            i32(-1);
            return c.push(0x73);
          }
          if (e.type === 'float') {
            expr(e.e);
            return c.push(0x9a);
          }
          i32(0);
          expr(e.e);
          return c.push(0x6b);
        case 'and': // l ? r : false, evaluating r only when needed
          expr(e.l);
          open(0x04, null, I32);
          expr(e.r);
          c.push(0x05);
          i32(0);
          return close();
        case 'or':
          expr(e.l);
          open(0x04, null, I32);
          i32(1);
          c.push(0x05);
          expr(e.r);
          return close();
        case 'ifx':
          expr(e.c);
          open(0x04, null, valType(e.type));
          expr(e.a);
          c.push(0x05);
          expr(e.b);
          return close();
        case 'index':
          return memory(e.type === 'float' ? 0x2b : 0x28, address(e));
        case 'conv':
          expr(e.e);
          if (e.op === 'i2f') c.push(0xb7);
          else if (e.op === 'f2i') c.push(0xaa);
          return undefined;
        case 'call':
          e.args.forEach(expr);
          c.push(0x10);
          return uleb(nImports + e.fn, c);
        default:
          return builtin(e);
      }
    }

    function builtin(e) {
      if (e.name === 'abs_i') {
        expr(e.args[0]);
        local(0x21, scratch(0));
        i32(0);
        local(0x20, scratch(0));
        c.push(0x6b); // 0 - x
        local(0x20, scratch(0));
        local(0x20, scratch(0));
        i32(0);
        return c.push(0x48, 0x1b); // x < 0 ? -x : x
      }
      if (e.name === 'min_i' || e.name === 'max_i') {
        // both arguments are stored before either is read back, so nested uses cannot disturb them
        expr(e.args[0]);
        expr(e.args[1]);
        local(0x21, scratch(1));
        local(0x21, scratch(0));
        local(0x20, scratch(0));
        local(0x20, scratch(1));
        local(0x20, scratch(0));
        local(0x20, scratch(1));
        return c.push(e.name === 'min_i' ? 0x48 : 0x4a, 0x1b);
      }
      e.args.forEach(expr);
      if (FLOAT_UNARY[e.name]) return c.push(FLOAT_UNARY[e.name]);
      if (e.name === 'min_f') return c.push(0xa4);
      if (e.name === 'max_f') return c.push(0xa5);
      c.push(0x10);
      return uleb(e.name === 'pixel' ? pixelIndex : program.imports.indexOf(e.name), c);
    }

    function statement(s) {
      switch (s.k) {
        case 'let':
          expr(s.e);
          return local(0x21, s.slot);
        case 'assign': {
          const t = s.target;
          if (t.k === 'index') {
            const arr = address(t);
            expr(s.e);
            return memory(arr.elem === 'float' ? 0x39 : 0x36, arr);
          }
          expr(s.e);
          return local(t.k === 'local' ? 0x21 : 0x24, t.k === 'local' ? t.slot : t.index);
        }
        case 'expr':
          expr(s.e);
          if (s.e.type !== 'void') c.push(0x1a); // drop
          return undefined;
        case 'if':
          expr(s.c);
          open(0x04, null);
          s.then.forEach(statement);
          if (s.else) {
            c.push(0x05);
            s.else.forEach(statement);
          }
          return close();
        case 'while':
          open(0x02, 'break');
          open(0x03, 'continue'); // branching to a loop jumps back to its top, where the condition is re-tested
          expr(s.c);
          c.push(0x45, 0x0d, 1); // i32.eqz; br_if 1
          s.body.forEach(statement);
          c.push(0x0c, 0); // br 0
          close();
          return close();
        case 'for':
          expr(s.from);
          local(0x21, s.slot);
          expr(s.to);
          local(0x21, s.endSlot);
          open(0x02, 'break');
          open(0x03, null);
          local(0x20, s.slot);
          local(0x20, s.endSlot);
          c.push(0x4e, 0x0d, 1); // i32.ge_s; br_if 1
          open(0x02, 'continue'); // "continue" leaves this inner block and lands on the increment
          s.body.forEach(statement);
          close();
          local(0x20, s.slot);
          i32(1);
          c.push(0x6a);
          local(0x21, s.slot);
          c.push(0x0c, 0);
          close();
          return close();
        case 'block':
          return s.body.forEach(statement);
        case 'break':
          return branch(0x0c, 'break');
        case 'continue':
          return branch(0x0c, 'continue');
        default:
          if (s.e) expr(s.e);
          return c.push(0x0f);
      }
    }

    fn.body.forEach(statement);
    // The checker has proved every path returns; this tells the validator the end is never reached.
    if (fn.ret !== 'void') c.push(0x00);
    c.push(0x0b);

    const locals = [...fn.localTypes.slice(fn.params.length).map(valType), ...Array(scratchUsed).fill(I32)];
    const groups = [];
    for (const t of locals) {
      const last = groups[groups.length - 1];
      if (last && last[1] === t) last[0]++;
      else groups.push([1, t]);
    }
    return [...vec(groups.map(([n, t]) => [...uleb(n), t])), ...c];
  }

  /** pixel(x, y, r, g, b): one bounds test, then three clamped byte stores and an opaque alpha. */
  function pixelBody() {
    const W = program.fbWidth;
    const H = program.fbHeight;
    const c = [1, 1, I32]; // one extra local: the pixel's address
    const get = (i) => c.push(0x20, i);
    const k = (v) => {
      c.push(0x41);
      sleb(v, c);
    };
    get(0);
    k(W);
    c.push(0x49); // x <u W  (unsigned, so negatives fail too)
    get(1);
    k(H);
    c.push(0x49, 0x71, 0x04, EMPTY);
    get(1);
    k(W);
    c.push(0x6c);
    get(0);
    c.push(0x6a);
    k(2);
    c.push(0x74, 0x21, 5);
    for (let ch = 0; ch < 3; ch++) {
      get(5);
      k(0);
      k(255);
      get(2 + ch);
      get(2 + ch);
      k(255);
      c.push(0x4a, 0x1b); // v > 255 ? 255 : v
      get(2 + ch);
      k(0);
      c.push(0x48, 0x1b); // v < 0 ? 0 : …
      c.push(0x3a, 0, ch); // i32.store8 offset=ch
    }
    get(5);
    k(255);
    c.push(0x3a, 0, 3, 0x0b, 0x0b);
    return c;
  }

  const bodies = program.fns.map(body);
  if (program.usesPixel) bodies.push(pixelBody());

  const pages = Math.max(1, Math.ceil(program.memoryBytes / 65536));
  const out = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];
  out.push(...section(1, vec(types)));
  if (nImports) out.push(...section(2, vec(program.imports.map((name, i) => [...str('env'), ...str(name), 0x00, ...uleb(importTypes[i])]))));
  out.push(...section(3, vec(fnTypes.map((t) => uleb(t)))));
  out.push(...section(5, [1, 0x00, ...uleb(pages)]));
  if (program.globals.length)
    out.push(...section(6, vec(program.globals.map((g) => [valType(g.type), 0x01, ...(g.type === 'float' ? [0x44, ...f64Bytes(g.init)] : [0x41, ...sleb(g.init)]), 0x0b]))));
  out.push(...section(7, vec([[...str('memory'), 0x02, 0x00], ...program.fns.map((f, i) => [...str(f.name), 0x00, ...uleb(nImports + i)])])));
  out.push(...section(10, vec(bodies.map((b) => [...uleb(b.length), ...b]))));

  return { bytes: Uint8Array.from(out), funcNames: [...program.imports, ...program.fns.map((f) => f.name), ...(program.usesPixel ? ['pixel'] : [])] };
}
