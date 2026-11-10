// The arithmetic of Sable, defined once. The interpreter and the constant folder both use these
// functions, and the WebAssembly back end emits the instructions they mirror, so all three agree.

export class Trap extends Error {
  constructor(message) {
    super(message);
    this.name = 'Trap';
  }
}

const b = (x) => (x ? 1 : 0);

export const INT_BIN = {
  '+': (x, y) => (x + y) | 0,
  '-': (x, y) => (x - y) | 0,
  '*': Math.imul,
  '/': (x, y) => {
    if (y === 0) throw new Trap('integer division by zero');
    if (x === -2147483648 && y === -1) throw new Trap('integer overflow');
    return (x / y) | 0;
  },
  '%': (x, y) => {
    if (y === 0) throw new Trap('integer division by zero');
    return y === -1 ? 0 : (x % y) | 0;
  },
  '&': (x, y) => x & y,
  '|': (x, y) => x | y,
  '^': (x, y) => x ^ y,
  '<<': (x, y) => x << y,
  '>>': (x, y) => x >> y,
  '==': (x, y) => b(x === y),
  '!=': (x, y) => b(x !== y),
  '<': (x, y) => b(x < y),
  '<=': (x, y) => b(x <= y),
  '>': (x, y) => b(x > y),
  '>=': (x, y) => b(x >= y),
};

export const FLOAT_BIN = {
  '+': (x, y) => x + y,
  '-': (x, y) => x - y,
  '*': (x, y) => x * y,
  '/': (x, y) => x / y,
  '==': (x, y) => b(x === y),
  '!=': (x, y) => b(x !== y),
  '<': (x, y) => b(x < y),
  '<=': (x, y) => b(x <= y),
  '>': (x, y) => b(x > y),
  '>=': (x, y) => b(x >= y),
};

export const binOps = (operand) => (operand === 'float' ? FLOAT_BIN : INT_BIN);

/** float → int, truncating toward zero; traps where i32.trunc_f64_s traps. */
export function truncToInt(x) {
  if (!(x > -2147483649 && x < 2147483648)) throw new Trap('a float is out of range for an int');
  return Math.trunc(x) | 0;
}

export const absInt = (x) => (x < 0 ? (0 - x) | 0 : x);

/** How print() shows a float on every back end. */
export const showFloat = (x) => (Number.isInteger(x) && Math.abs(x) < 1e15 ? x.toFixed(1) : String(x));

/** The host side of the module's imports. `print` receives one finished line of text. */
export function hostImports(print) {
  return {
    env: {
      print_i: (v) => print(String(v)),
      print_f: (v) => print(showFloat(v)),
      print_b: (v) => print(v ? 'true' : 'false'),
      sin: Math.sin,
      cos: Math.cos,
      exp: Math.exp,
      log: Math.log,
      pow: Math.pow,
      atan2: Math.atan2,
    },
  };
}
