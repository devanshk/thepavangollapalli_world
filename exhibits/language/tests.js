import { assert, equal } from '../../assets/js/check.js';
import { lex } from './lexer.js';
import { compile } from './compiler.js';
import { createInterpreter } from './interp.js';
import { disassemble, readUleb, readSleb } from './disasm.js';
import { uleb, sleb } from './wasm.js';
import { hostImports, Trap } from './ops.js';
import { EXAMPLES } from './examples.js';
import { randomProgram } from './fuzz.js';

// WebAssembly can be blocked by a sandbox policy; then there is nothing to compare against.
let wasmState = null;
async function wasmAvailable() {
  if (wasmState === null) {
    try {
      await WebAssembly.instantiate(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
      wasmState = true;
    } catch {
      wasmState = false;
    }
  }
  return wasmState;
}

function build(source, options) {
  const r = compile(source, options);
  if (!r.ok) throw new Error(`does not compile, ${r.error.line}:${r.error.col}: ${r.error.message}`);
  return r;
}

/** Run one function on both back ends → [{ value } | { trap }, same, printed lines × 2, compile result]. */
async function runBoth(source, name, args = [], options) {
  const r = build(source, options);
  const outI = [];
  const outW = [];
  let i;
  try {
    i = { value: createInterpreter(r.program, { print: (s) => outI.push(s) }, { fuel: 2e8 }).call(name, ...args) };
  } catch (err) {
    if (!(err instanceof Trap)) throw err;
    i = { trap: err.message };
  }
  if (!(await wasmAvailable())) return { i, w: i, outI, outW: outI, r };
  const { instance } = await WebAssembly.instantiate(r.bytes, hostImports((s) => outW.push(s)));
  let w;
  try {
    w = { value: instance.exports[name](...args) };
  } catch (err) {
    w = { trap: String(err.message) };
  }
  return { i, w, outI, outW, r, instance };
}

const agree = (x, y) => (x.trap || y.trap ? !!x.trap === !!y.trap : Object.is(Number(x.value), Number(y.value)));

/** Both back ends must return `expected` for the expression (or statements ending in a return). */
async function evaluates(type, bodyOrExpr, expected) {
  const body = bodyOrExpr.includes('return') ? bodyOrExpr : `return ${bodyOrExpr};`;
  const { i, w } = await runBoth(`fn f() -> ${type} { ${body} }`, 'f');
  assert(!i.trap, `interpreter trapped on ${bodyOrExpr}: ${i.trap}`);
  equal(Number(i.value), expected, `interpreter, ${bodyOrExpr}`);
  equal(Number(w.value), expected, `WebAssembly, ${bodyOrExpr}`);
}

async function traps(source, name = 'f', args = []) {
  const { i, w } = await runBoth(source, name, args);
  assert(i.trap, 'the interpreter should trap');
  assert(w.trap, 'WebAssembly should trap');
}

function rejects(source, pattern, line, col, hint) {
  const r = compile(source);
  assert(!r.ok, `should not compile: ${source}`);
  assert(pattern.test(r.error.message), `message "${r.error.message}" should match ${pattern}`);
  if (line) equal([r.error.line, r.error.col], [line, col], `position of "${r.error.message}"`);
  if (hint) assert(hint.test(r.error.hint || ''), `hint "${r.error.hint}" should match ${hint}`);
}

export default [
  {
    name: 'the lexer tells a range from a decimal point',
    fn() {
      equal(lex('for i in 0..n').map((t) => t.text), ['for', 'i', 'in', '0', '..', 'n', '']);
      equal(lex('1.5e3 0x1F 7').map((t) => [t.type, t.value]), [['float', 1500], ['int', 31], ['int', 7], ['eof', undefined]]);
      equal(lex('a >>= b // note\n!x').map((t) => t.text), ['a', '>>', '=', 'b', '!', 'x', '']);
      const t = lex('fn\n  main')[1];
      equal([t.span.line, t.span.col], [2, 3]);
    },
  },
  {
    name: 'operators follow the usual precedence and associate to the left',
    async fn() {
      await evaluates('int', '1 + 2 * 3', 7);
      await evaluates('int', '(1 + 2) * 3', 9);
      await evaluates('int', '10 - 4 - 3', 3);
      await evaluates('int', '100 / 10 / 5', 2);
      await evaluates('int', '1 << 2 + 1', 8);
      await evaluates('int', '6 | 1 & 3', 7);
      await evaluates('int', '-2 * 3 + 1', -5);
      await evaluates('int', '~5 & 255', 250);
      await evaluates('int', '17 % 5', 2);
      await evaluates('int', '-17 % 5', -2);
      await evaluates('int', '-17 / 5', -3);
      await evaluates('bool', '1 + 1 == 2 && 3 < 4 || false', 1);
      await evaluates('bool', '!(1 > 2) && !false', 1);
      await evaluates('float', '1.5 + 2.0 * 4.0', 9.5);
      await evaluates('float', '-(2.0 - 5.0) / 2.0', 1.5);
    },
  },
  {
    name: 'type errors are reported in plain words at the right place',
    fn() {
      rejects('fn f() -> int { return 1.5; }', /returns an int, but this value is a float/, 1, 24, /float\(…\) or int\(…\)/);
      rejects('fn f() -> int {\n  let x = 1 + 2.0;\n  return x;\n}', /cannot apply "\+" to an int and a float/, 2, 11);
      rejects('fn f() { let x = 1; x = 2; }', /declared with let/, 1, 21, /var/);
      rejects('fn f(n: int) { n = 2; }', /is a parameter/);
      rejects('fn f() { if 1 { } }', /condition must be a bool/, 1, 13, /!= 0/);
      rejects('fn f() -> int { if true { return 1; } }', /must return an int on every path/, 1, 4);
      rejects('fn f() { break; }', /inside a loop/);
      rejects('fn f() { let x = 1 }', /expected ";"/, 1, 19);
      rejects('fn f() { let a = 1.0 % 2.0; }', /cannot apply "%"/, 0, 0, /ints only/);
      rejects('fn f() { let a = 4000000000; }', /does not fit in an int/);
      rejects('fn g() {} fn f() { let a = g(); }', /returns nothing/);
      rejects('fn g(a: int) {} fn f() { g(1, 2); }', /takes 1 argument but was given 2/);
      rejects('array a: int[0];', /between 1 and/);
      rejects('const N = 3; fn f() { N = 4; }', /a constant/);
      rejects('let x = 1;', /expected a declaration/, 1, 1);
      rejects('fn memory() {} fn main() { memory(); }', /module's own memory/, 1, 4);
      rejects('fn f() { let s = "hi"; }', /unexpected character/, 1, 18);
    },
  },
  {
    name: 'a misspelled name gets a suggestion',
    fn() {
      rejects('fn f() { prnt(1); }', /unknown function "prnt"/, 1, 10, /did you mean "print"\?/);
      rejects('fn f() -> int { let total = 1; return totl; }', /unknown name "totl"/, 0, 0, /"total"/);
      rejects('fn f() -> float { return sqroot(2.0); }', /unknown function/, 0, 0, /"sqrt"/);
    },
  },
  {
    name: 'recursion, mutual recursion and loops compute the right answers',
    async fn() {
      const src = `
        fn fib(n: int) -> int { if n < 2 { return n; } return fib(n - 1) + fib(n - 2); }
        fn even(n: int) -> bool { if n == 0 { return true; } return odd(n - 1); }
        fn odd(n: int) -> bool { if n == 0 { return false; } return even(n - 1); }
        fn collatz(start: int) -> int { var n = start; var steps = 0; while n != 1 { if n % 2 == 0 { n /= 2; } else { n = 3 * n + 1; } steps += 1; } return steps; }
        fn odds(limit: int) -> int { var s = 0; for i in 0..limit { if i % 2 == 0 { continue; } if i > 50 { break; } s += i; } return s; }
        fn f() -> int { var k = 0; if even(10) { k += 1; } if odd(7) { k += 10; } return fib(20) + collatz(27) * 100000 + odds(1000) * 1000 + k; }`;
      const { i, w } = await runBoth(src, 'f');
      equal(i.value, 6765 + 111 * 100000 + 625 * 1000 + 11);
      equal(w.value, i.value);
    },
  },
  {
    name: 'if works as a value, and && and || skip what they do not need',
    async fn() {
      const src = `
        var calls: int = 0;
        fn touch(v: bool) -> bool { calls += 1; return v; }
        fn f() -> int {
          let a = if 2 > 1 { 10 } else { 20 };
          let b = if a == 20 { 1 } else if a == 10 { 2 } else { 3 };
          let c = false && touch(true);
          let d = true || touch(true);
          let e = true && touch(false);
          let g = false || touch(true);
          return a * 1000 + b * 100 + calls * 10 + int(c) + int(d) + int(e) + int(g);
        }`;
      const { i, w } = await runBoth(src, 'f');
      equal(i.value, 10000 + 200 + 20 + 2);
      equal(w.value, i.value);
    },
  },
  {
    name: 'arrays live in linear memory and globals keep their values between calls',
    async fn() {
      const src = `
        const N = 1000;
        array crossed: int[N];
        array samples: float[8];
        var runs: int = 0;
        fn primes() -> int { var count = 0; for n in 2..N { if crossed[n] == 0 { count += 1; var m = n * 2; while m < N { crossed[m] = 1; m += n; } } } return count; }
        fn f() -> float { runs += 1; for i in 0..len(samples) { samples[i] = float(i) * 0.5; } samples[3] *= 4.0; return samples[3] + samples[7] + float(primes()) + float(runs) * 1000.0; }`;
      const { i, w, instance } = await runBoth(src, 'f');
      equal(i.value, 6 + 3.5 + 168 + 1000);
      equal(w.value, i.value);
      if (instance) equal(instance.exports.f(), 6 + 3.5 + 168 + 2000, 'second call sees the sieve already done, and runs = 2');
    },
  },
  {
    name: 'a[i] += x evaluates i exactly once',
    async fn() {
      const src = `
        array a: int[4];
        var n: int = 0;
        fn next() -> int { n += 1; return n; }
        fn f() -> int { a[next()] += 5; a[next()] += 7; return a[1] * 100 + a[2] * 10 + n; }`;
      const { i, w } = await runBoth(src, 'f');
      equal(i.value, 572);
      equal(w.value, 572);
    },
  },
  {
    name: 'integer arithmetic wraps at 32 bits on both back ends',
    async fn() {
      await evaluates('int', '2147483647 + 1', -2147483648);
      await evaluates('int', '-2147483648 - 1', 2147483647);
      await evaluates('int', '65536 * 65536', 0);
      await evaluates('int', '123456789 * 987654321', -67153019);
      await evaluates('int', '1 << 31', -2147483648);
      await evaluates('int', '1 << 33', 2);
      await evaluates('int', '-8 >> 1', -4);
      await evaluates('int', 'abs(-2147483648)', -2147483648);
      await evaluates('int', '0xFFFFFFFF', -1);
      await evaluates('int', 'int(-7.9) + int(7.9)', 0);
      await evaluates('int', 'min(3, -4) * max(3, -4)', -12);
    },
  },
  {
    name: 'division by zero, overflowing division and bad conversions trap on both',
    async fn() {
      await traps('fn f(a: int) -> int { return 10 / a; }', 'f', [0]);
      await traps('fn f(a: int) -> int { return 10 % a; }', 'f', [0]);
      await traps('fn f(a: int) -> int { return -2147483648 / a; }', 'f', [-1]);
      await traps('fn f(x: float) -> int { return int(x); }', 'f', [1e10]);
      await traps('fn f(x: float) -> int { return int(x / x); }', 'f', [0]);
      await evaluates('int', '-2147483648 % -1', 0);
      await evaluates('float', '1.0 / 0.0', Infinity);
    },
  },
  {
    name: 'reading or writing outside an array traps on both',
    async fn() {
      await traps('array a: int[4]; fn f(i: int) -> int { return a[i]; }', 'f', [4]);
      await traps('array a: int[4]; fn f(i: int) -> int { return a[i]; }', 'f', [-1]);
      await traps('array a: float[4]; fn f(i: int) -> int { a[i] = 1.0; return 0; }', 'f', [1000000]);
      const { i, w } = await runBoth('array a: int[4]; fn f(i: int) -> int { a[i] = 9; return a[3]; }', 'f', [3]);
      equal([i.value, w.value], [9, 9]);
    },
  },
  {
    name: 'a runaway loop is stopped by the interpreter’s step budget',
    fn() {
      const r = build('fn f() -> int { var n = 0; while true { n += 1; } return n; }');
      let message = '';
      try {
        createInterpreter(r.program, {}, { fuel: 10000 }).call('f');
      } catch (err) {
        message = err.message;
      }
      assert(/step budget/.test(message), `expected a budget trap, got "${message}"`);
    },
  },
  {
    name: 'LEB128 numbers round-trip, including the edge values',
    fn() {
      for (const n of [0, 1, 127, 128, 255, 16383, 16384, 2097151, 2097152, 268435455, 268435456, 4294967295])
        equal(readUleb(Uint8Array.from(uleb(n))), n, `unsigned ${n}`);
      for (const n of [0, 1, -1, 63, 64, -64, -65, 8191, 8192, -8192, -8193, 2147483647, -2147483648])
        equal(readSleb(Uint8Array.from(sleb(n))), n, `signed ${n}`);
      equal(uleb(624485), [0xe5, 0x8e, 0x26]);
      equal(sleb(-123456), [0xc0, 0xbb, 0x78]);
    },
  },
  {
    name: 'every example compiles to a module the engine accepts as valid',
    async fn() {
      for (const ex of EXAMPLES) {
        const r = build(ex.source);
        equal([...r.bytes.slice(0, 8)], [0, 97, 115, 109, 1, 0, 0, 0], `${ex.name}: magic number and version`);
        if (await wasmAvailable()) assert(WebAssembly.validate(r.bytes), `${ex.name} should validate`);
      }
    },
  },
  {
    name: 'the disassembler decodes every example, and its sections cover every byte',
    fn() {
      for (const ex of EXAMPLES) {
        const r = build(ex.source);
        const d = disassemble(r.bytes, r.funcNames);
        equal(d.sections.reduce((n, s) => n + s.size, 0), r.bytes.length, `${ex.name}: section sizes`);
        assert(d.instructions > 20 && d.text.startsWith('(module') && d.text.endsWith(')'), `${ex.name}: text`);
        for (const f of r.program.fns) assert(d.text.includes(`(func $${f.name}`), `${ex.name}: function ${f.name} is listed`);
      }
    },
  },
  {
    name: 'the prime sieve and the queens search print the known answers on both',
    async fn() {
      const sieve = EXAMPLES.find((e) => e.id === 'primes').source.replace('1000000', '100000');
      const a = await runBoth(sieve, 'main');
      equal(a.outI, ['9592', '99991']);
      equal(a.outW, a.outI);
      const queens = EXAMPLES.find((e) => e.id === 'queens').source.replace('N = 11', 'N = 8');
      const b = await runBoth(queens, 'main');
      equal(b.outI, ['92']);
      equal(b.outW, ['92']);
    },
  },
  {
    name: 'compiled and interpreted frames of the picture examples match pixel for pixel',
    async fn() {
      if (!(await wasmAvailable())) return;
      for (const id of ['plasma', 'raytracer', 'life']) {
        const r = build(EXAMPLES.find((e) => e.id === id).source);
        const machine = createInterpreter(r.program, {}, { fuel: 2e8 });
        const { instance } = await WebAssembly.instantiate(r.bytes, hostImports(() => {}));
        machine.call('frame', 1.25);
        instance.exports.frame(1.25);
        const compiled = new Uint8Array(instance.exports.memory.buffer, 0, machine.pixels.length);
        let lit = 0;
        for (let i = 0; i < compiled.length; i++) {
          if (compiled[i] !== machine.pixels[i]) throw new Error(`${id}: byte ${i} differs (${compiled[i]} vs ${machine.pixels[i]})`);
          if (i % 4 !== 3 && compiled[i] > 40) lit++;
        }
        assert(lit > 5000, `${id}: the frame should not be blank`);
      }
    },
  },
  {
    name: '300 random programs give identical results interpreted and compiled',
    async fn() {
      let trapped = 0;
      for (let seed = 1; seed <= 300; seed++) {
        const { source, args } = randomProgram(seed);
        const { i, w } = await runBoth(source, 'f', args);
        if (i.trap) trapped++;
        if (!agree(i, w)) throw new Error(`seed ${seed}: interpreter ${JSON.stringify(i)} but WebAssembly ${JSON.stringify(w)}`);
      }
      assert(trapped < 150, `${trapped} of 300 trapped; most should run to completion`);
    },
  },
  {
    name: 'optimised and unoptimised builds of 150 random programs agree',
    fn() {
      for (let seed = 1000; seed < 1150; seed++) {
        const { source, args } = randomProgram(seed);
        const run = (optimise) => {
          try {
            return { value: createInterpreter(build(source, { optimise }).program).call('f', ...args) };
          } catch (err) {
            if (!(err instanceof Trap)) throw err;
            return { trap: err.message };
          }
        };
        const plain = run(false);
        const folded = run(true);
        if (!agree(plain, folded)) throw new Error(`seed ${seed}: ${JSON.stringify(plain)} unoptimised but ${JSON.stringify(folded)} optimised`);
      }
    },
  },
  {
    name: 'constants fold and dead branches disappear from the binary',
    fn() {
      const src = 'const DEBUG = false; fn f(a: int) -> int { if DEBUG { print(a); } return a + 2 * 3 + (10 - 4); }';
      const folded = build(src);
      const plain = build(src, { optimise: false });
      assert(folded.bytes.length < plain.bytes.length, 'the optimised binary is smaller');
      const text = disassemble(folded.bytes, folded.funcNames).text;
      assert(text.includes('i32.const 12') || text.includes('i32.const 6'), 'the arithmetic on literals is done at compile time');
      assert(!/\bif\b/.test(text), 'the dead branch is gone');
      // a division by zero must stay in the program so that it still traps at run time
      const div = disassemble(build('fn f() -> int { return 1 / 0; }').bytes).text;
      assert(div.includes('i32.div_s'), 'a trapping operation is not folded away');
    },
  },
];
