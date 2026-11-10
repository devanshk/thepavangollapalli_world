// Disassembler: reads a WebAssembly binary back into WebAssembly text. It knows nothing about
// the compiler that produced the bytes, which is the point: if it can decode them, they are a
// well-formed module.

const SECTION_NAMES = { 0: 'custom', 1: 'type', 2: 'import', 3: 'function', 4: 'table', 5: 'memory', 6: 'global', 7: 'export', 8: 'start', 9: 'element', 10: 'code', 11: 'data' };
const VAL = { 0x7f: 'i32', 0x7e: 'i64', 0x7d: 'f32', 0x7c: 'f64' };

// opcode → [mnemonic, immediate kind]
const OPS = {
  0x00: ['unreachable'], 0x01: ['nop'], 0x02: ['block', 'block'], 0x03: ['loop', 'block'], 0x04: ['if', 'block'], 0x05: ['else'], 0x0b: ['end'],
  0x0c: ['br', 'u'], 0x0d: ['br_if', 'u'], 0x0f: ['return'], 0x10: ['call', 'fn'], 0x1a: ['drop'], 0x1b: ['select'],
  0x20: ['local.get', 'u'], 0x21: ['local.set', 'u'], 0x22: ['local.tee', 'u'], 0x23: ['global.get', 'u'], 0x24: ['global.set', 'u'],
  0x28: ['i32.load', 'mem'], 0x2b: ['f64.load', 'mem'], 0x36: ['i32.store', 'mem'], 0x39: ['f64.store', 'mem'], 0x3a: ['i32.store8', 'mem'],
  0x41: ['i32.const', 's'], 0x44: ['f64.const', 'f'],
  0x45: ['i32.eqz'], 0x46: ['i32.eq'], 0x47: ['i32.ne'], 0x48: ['i32.lt_s'], 0x49: ['i32.lt_u'], 0x4a: ['i32.gt_s'], 0x4b: ['i32.gt_u'],
  0x4c: ['i32.le_s'], 0x4d: ['i32.le_u'], 0x4e: ['i32.ge_s'], 0x4f: ['i32.ge_u'],
  0x61: ['f64.eq'], 0x62: ['f64.ne'], 0x63: ['f64.lt'], 0x64: ['f64.gt'], 0x65: ['f64.le'], 0x66: ['f64.ge'],
  0x6a: ['i32.add'], 0x6b: ['i32.sub'], 0x6c: ['i32.mul'], 0x6d: ['i32.div_s'], 0x6e: ['i32.div_u'], 0x6f: ['i32.rem_s'], 0x70: ['i32.rem_u'],
  0x71: ['i32.and'], 0x72: ['i32.or'], 0x73: ['i32.xor'], 0x74: ['i32.shl'], 0x75: ['i32.shr_s'], 0x76: ['i32.shr_u'],
  0x99: ['f64.abs'], 0x9a: ['f64.neg'], 0x9b: ['f64.ceil'], 0x9c: ['f64.floor'], 0x9d: ['f64.trunc'], 0x9e: ['f64.nearest'], 0x9f: ['f64.sqrt'],
  0xa0: ['f64.add'], 0xa1: ['f64.sub'], 0xa2: ['f64.mul'], 0xa3: ['f64.div'], 0xa4: ['f64.min'], 0xa5: ['f64.max'],
  0xaa: ['i32.trunc_f64_s'], 0xb7: ['f64.convert_i32_s'],
};

function reader(bytes) {
  const r = {
    pos: 0,
    u8() {
      if (r.pos >= bytes.length) throw new Error('unexpected end of module');
      return bytes[r.pos++];
    },
    u32() {
      let result = 0;
      let shift = 0;
      for (;;) {
        const byte = r.u8();
        result += (byte & 0x7f) * 2 ** shift;
        shift += 7;
        if (!(byte & 0x80)) return result;
        if (shift > 35) throw new Error('LEB128 number is too long');
      }
    },
    s32() {
      let result = 0;
      let shift = 0;
      for (;;) {
        const byte = r.u8();
        result |= (byte & 0x7f) << shift;
        shift += 7;
        if (!(byte & 0x80)) return shift < 32 && byte & 0x40 ? result | (-1 << shift) : result;
        if (shift > 35) throw new Error('LEB128 number is too long');
      }
    },
    f64() {
      const view = new DataView(bytes.buffer, bytes.byteOffset + r.pos, 8);
      r.pos += 8;
      return view.getFloat64(0, true);
    },
    name() {
      const n = r.u32();
      let s = '';
      for (let i = 0; i < n; i++) s += String.fromCharCode(r.u8());
      return decodeURIComponent(escape(s));
    },
    val() {
      const b = r.u8();
      if (!VAL[b]) throw new Error(`unknown value type 0x${b.toString(16)}`);
      return VAL[b];
    },
  };
  return r;
}

export const readUleb = (bytes, pos = 0) => {
  const r = reader(bytes);
  r.pos = pos;
  return r.u32();
};
export const readSleb = (bytes, pos = 0) => {
  const r = reader(bytes);
  r.pos = pos;
  return r.s32();
};

const showF64 = (x) => (Number.isNaN(x) ? 'nan' : x === Infinity ? 'inf' : x === -Infinity ? '-inf' : Object.is(x, -0) ? '-0' : String(x));

/**
 * disassemble(bytes, funcNames?) → { text, sections: [{ id, name, offset, size }], instructions }
 * sections covers every byte of the file, starting with the 8-byte header.
 */
export function disassemble(bytes, funcNames = []) {
  const r = reader(bytes);
  if (bytes.length < 8 || r.u8() !== 0x00 || r.u8() !== 0x61 || r.u8() !== 0x73 || r.u8() !== 0x6d) throw new Error('this is not a WebAssembly module');
  r.pos = 8;
  const sections = [{ id: -1, name: 'header', offset: 0, size: 8 }];
  const m = { types: [], imports: [], funcs: [], memory: null, globals: [], exports: [], bodies: [] };
  let instructions = 0;

  const constExpr = () => {
    const op = r.u8();
    const text = op === 0x41 ? `i32.const ${r.s32()}` : op === 0x44 ? `f64.const ${showF64(r.f64())}` : null;
    if (!text || r.u8() !== 0x0b) throw new Error('unsupported constant expression');
    return text;
  };

  while (r.pos < bytes.length) {
    const offset = r.pos;
    const id = r.u8();
    const size = r.u32();
    const end = r.pos + size;
    if (end > bytes.length) throw new Error(`section ${id} runs past the end of the module`);
    sections.push({ id, name: SECTION_NAMES[id] || `section ${id}`, offset, size: end - offset });
    const count = id === 0 || id === 8 ? 0 : r.u32();
    for (let i = 0; i < count; i++) {
      if (id === 1) {
        if (r.u8() !== 0x60) throw new Error('expected a function type');
        const params = Array.from({ length: r.u32() }, () => r.val());
        const results = Array.from({ length: r.u32() }, () => r.val());
        m.types.push({ params, results });
      } else if (id === 2) {
        const module = r.name();
        const field = r.name();
        if (r.u8() !== 0x00) throw new Error('only function imports are supported');
        m.imports.push({ module, field, type: r.u32() });
      } else if (id === 3) m.funcs.push(r.u32());
      else if (id === 5) {
        const flags = r.u8();
        m.memory = { min: r.u32(), max: flags & 1 ? r.u32() : null };
      } else if (id === 6) {
        const type = r.val();
        const mutable = r.u8() === 1;
        m.globals.push({ type, mutable, init: constExpr() });
      } else if (id === 7) m.exports.push({ name: r.name(), kind: r.u8(), index: r.u32() });
      else if (id === 10) {
        const bodyEnd = r.u32() + r.pos;
        const locals = [];
        for (let g = r.u32(); g > 0; g--) {
          const n = r.u32();
          const t = r.val();
          for (let j = 0; j < n; j++) locals.push(t);
        }
        m.bodies.push({ locals, start: r.pos, end: bodyEnd });
        r.pos = bodyEnd;
      } else throw new Error(`unsupported section ${id}`);
    }
    if (id === 0 || id === 8) r.pos = end;
    if (r.pos !== end) throw new Error(`the ${SECTION_NAMES[id] || id} section has the wrong length`);
  }

  const nImports = m.imports.length;
  const exported = new Map(m.exports.filter((e) => e.kind === 0).map((e) => [e.index, e.name]));
  const fname = (i) => `$${funcNames[i] || exported.get(i) || (i < nImports ? m.imports[i].field : `f${i}`)}`;
  const sig = (t) => `${t.params.length ? ` (param ${t.params.join(' ')})` : ''}${t.results.length ? ` (result ${t.results.join(' ')})` : ''}`;

  const out = ['(module'];
  m.types.forEach((t, i) => out.push(`  (type ${i} (func${sig(t)}))`));
  m.imports.forEach((imp, i) => out.push(`  (import "${imp.module}" "${imp.field}" (func ${fname(i)}${sig(m.types[imp.type])}))`));
  if (m.memory) out.push(`  (memory ${m.memory.min}${m.memory.max == null ? '' : ` ${m.memory.max}`})  ;; ${m.memory.min * 64} KiB`);
  m.globals.forEach((g, i) => out.push(`  (global ${i} ${g.mutable ? `(mut ${g.type})` : g.type} (${g.init}))`));
  for (const e of m.exports) out.push(`  (export "${e.name}" (${e.kind === 0 ? `func ${fname(e.index)}` : `memory ${e.index}`}))`);

  m.bodies.forEach((b, i) => {
    const type = m.types[m.funcs[i]];
    out.push(`  (func ${fname(nImports + i)}${sig(type)}${b.locals.length ? ` (local ${b.locals.join(' ')})` : ''}`);
    r.pos = b.start;
    let depth = 0;
    while (r.pos < b.end) {
      const opcode = r.u8();
      const op = OPS[opcode];
      if (!op) throw new Error(`unknown opcode 0x${opcode.toString(16)} in ${fname(nImports + i)}`);
      const [mnemonic, kind] = op;
      if (mnemonic === 'end') {
        if (depth === 0) break; // the end of the function body
        depth--;
      }
      if (mnemonic === 'else') depth--;
      let text = mnemonic;
      if (kind === 'block') {
        const bt = r.u8();
        if (bt !== 0x40) text += ` (result ${VAL[bt] || '?'})`;
      } else if (kind === 'u') text += ` ${r.u32()}`;
      else if (kind === 's') text += ` ${r.s32()}`;
      else if (kind === 'f') text += ` ${showF64(r.f64())}`;
      else if (kind === 'fn') text += ` ${fname(r.u32())}`;
      else if (kind === 'mem') {
        r.u32(); // alignment
        const offset = r.u32();
        if (offset) text += ` offset=${offset}`;
      }
      out.push(`${'  '.repeat(depth + 2)}${text}`);
      instructions++;
      if (kind === 'block' || mnemonic === 'else') depth++;
    }
    if (r.pos !== b.end) throw new Error(`the body of ${fname(nImports + i)} has the wrong length`);
    out.push('  )');
  });
  out.push(')');
  return { text: out.join('\n'), sections, instructions };
}
