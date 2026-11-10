// Reference interpreter: walks the typed tree directly. It is deliberately simple, because it is
// the oracle the compiler is tested against, and it is the fallback when WebAssembly is blocked.
import { binOps, truncToInt, absInt, showFloat, Trap } from './ops.js';

const NORMAL = 0;
const BREAK = 1;
const CONTINUE = 2;
const RETURN = 3;

/**
 * createInterpreter(program, { print }, { fuel }) →
 *   call(name, ...args)   run an exported function; throws Trap on a runtime error
 *   pixels                Uint8ClampedArray framebuffer (RGBA)
 *   refuel(n)             reset the step budget (one step per loop iteration and per call)
 */
export function createInterpreter(program, host = {}, { fuel = 50e6 } = {}) {
  const W = program.fbWidth;
  const H = program.fbHeight;
  const pixels = new Uint8ClampedArray(W * H * 4);
  const globals = program.globals.map((g) => g.init);
  const arrays = program.arrays.map((arr) => (arr.elem === 'float' ? new Float64Array(arr.length) : new Int32Array(arr.length)));
  const print = host.print || (() => {});
  let steps = fuel;
  let result = 0;

  const burn = () => {
    if (--steps < 0) throw new Trap('the step budget ran out (is there an endless loop?)');
  };

  function element(e, L) {
    const i = ev(e.idx, L);
    const arr = arrays[e.arr];
    if (i >>> 0 >= arr.length) throw new Trap('array index out of bounds');
    return i;
  }

  function builtin(e, L) {
    const x = ev(e.args[0], L);
    switch (e.name) {
      case 'sqrt':
        return Math.sqrt(x);
      case 'floor':
        return Math.floor(x);
      case 'ceil':
        return Math.ceil(x);
      case 'abs_f':
        return Math.abs(x);
      case 'abs_i':
        return absInt(x);
      case 'sin':
        return Math.sin(x);
      case 'cos':
        return Math.cos(x);
      case 'exp':
        return Math.exp(x);
      case 'log':
        return Math.log(x);
      case 'print_i':
        return print(String(x));
      case 'print_f':
        return print(showFloat(x));
      case 'print_b':
        return print(x ? 'true' : 'false');
      default:
    }
    const y = ev(e.args[1], L);
    switch (e.name) {
      case 'min_f':
        return Math.min(x, y);
      case 'max_f':
        return Math.max(x, y);
      case 'min_i':
        return x < y ? x : y;
      case 'max_i':
        return x > y ? x : y;
      case 'pow':
        return Math.pow(x, y);
      case 'atan2':
        return Math.atan2(x, y);
      default: {
        // pixel(x, y, r, g, b): silently ignores positions off the screen, clamps colours
        const r = ev(e.args[2], L);
        const g = ev(e.args[3], L);
        const b = ev(e.args[4], L);
        if (x >>> 0 < W && y >>> 0 < H) {
          const at = (y * W + x) * 4;
          pixels[at] = r;
          pixels[at + 1] = g;
          pixels[at + 2] = b;
          pixels[at + 3] = 255;
        }
        return 0;
      }
    }
  }

  function ev(e, L) {
    switch (e.k) {
      case 'int':
      case 'float':
      case 'bool':
        return e.v;
      case 'local':
        return L[e.slot];
      case 'global':
        return globals[e.index];
      case 'bin': {
        const l = ev(e.l, L);
        return binOps(e.operand)[e.op](l, ev(e.r, L));
      }
      case 'unary': {
        const x = ev(e.e, L);
        if (e.op === '!') return x ? 0 : 1;
        if (e.op === '~') return ~x;
        return e.type === 'int' ? (0 - x) | 0 : -x;
      }
      case 'and':
        return ev(e.l, L) ? ev(e.r, L) : 0;
      case 'or':
        return ev(e.l, L) ? 1 : ev(e.r, L);
      case 'ifx':
        return ev(e.c, L) ? ev(e.a, L) : ev(e.b, L);
      case 'index':
        return arrays[e.arr][element(e, L)];
      case 'conv': {
        const x = ev(e.e, L);
        return e.op === 'f2i' ? truncToInt(x) : x;
      }
      case 'call': {
        const args = new Array(e.args.length);
        for (let i = 0; i < args.length; i++) args[i] = ev(e.args[i], L);
        return invoke(program.fns[e.fn], args);
      }
      default:
        return builtin(e, L);
    }
  }

  function run(stmts, L) {
    for (let i = 0; i < stmts.length; i++) {
      const signal = exec(stmts[i], L);
      if (signal !== NORMAL) return signal;
    }
    return NORMAL;
  }

  function exec(s, L) {
    switch (s.k) {
      case 'let':
        L[s.slot] = ev(s.e, L);
        return NORMAL;
      case 'assign': {
        const t = s.target;
        if (t.k === 'local') L[t.slot] = ev(s.e, L);
        else if (t.k === 'global') globals[t.index] = ev(s.e, L);
        else {
          const i = element(t, L); // index is evaluated and checked before the value, as in the compiled code
          arrays[t.arr][i] = ev(s.e, L);
        }
        return NORMAL;
      }
      case 'expr':
        ev(s.e, L);
        return NORMAL;
      case 'if':
        if (ev(s.c, L)) return run(s.then, L);
        return s.else ? run(s.else, L) : NORMAL;
      case 'while':
        while (ev(s.c, L)) {
          burn();
          const signal = run(s.body, L);
          if (signal === BREAK) break;
          if (signal === RETURN) return RETURN;
        }
        return NORMAL;
      case 'for': {
        let i = ev(s.from, L);
        const end = ev(s.to, L);
        L[s.endSlot] = end;
        while (i < end) {
          burn();
          L[s.slot] = i;
          const signal = run(s.body, L);
          if (signal === BREAK) break;
          if (signal === RETURN) return RETURN;
          i = (i + 1) | 0;
        }
        return NORMAL;
      }
      case 'block':
        return run(s.body, L);
      case 'break':
        return BREAK;
      case 'continue':
        return CONTINUE;
      default:
        result = s.e ? ev(s.e, L) : 0;
        return RETURN;
    }
  }

  function invoke(fn, args) {
    burn();
    const L = new Array(fn.localTypes.length).fill(0);
    for (let i = 0; i < args.length; i++) L[i] = args[i];
    result = 0;
    run(fn.body, L);
    return result;
  }

  return {
    pixels,
    refuel(n = fuel) {
      steps = n;
    },
    call(name, ...args) {
      const fn = program.fns.find((f) => f.name === name);
      if (!fn) throw new Error(`there is no function called "${name}"`);
      try {
        const value = invoke(fn, args);
        return fn.ret === 'void' ? undefined : value;
      } catch (err) {
        if (err instanceof RangeError) throw new Trap('the call stack overflowed (recursion too deep)');
        throw err;
      }
    },
  };
}
