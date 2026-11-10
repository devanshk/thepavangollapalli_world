// A generator of random, well-typed Sable programs for differential testing. Every program
// defines f(a: int, b: int, x: float, y: float, p: bool) and exercises nested expressions,
// conditionals, both kinds of loop, break and continue, and calls.
import { rng } from '../../assets/js/kit.js';

export function randomProgram(seed) {
  const r = rng(seed);
  const pick = r.pick;
  const intLit = () => String(pick([0, 1, 2, 3, 7, 10, 31, 255, 1000, 65535, 2147483647, -1, -128, r.int(2000) - 1000]));
  const floatLit = () => pick(['0.0', '1.0', '0.5', '2.5', '100.0', '0.001', '3.14159', '1.0e6', '-7.25', (r() * 200 - 100).toFixed(3)]);

  function int(d, v) {
    if (d <= 0 || r() < 0.22) return r() < 0.55 ? pick(v.i) : intLit();
    const x = () => int(d - 1, v);
    switch (r.int(12)) {
      case 0: case 1: case 2: return `(${x()} ${pick(['+', '-', '*', '&', '|', '^'])} ${x()})`;
      case 3: return `(${x()} ${pick(['/', '%'])} ${r() < 0.85 ? pick(['3', '7', '-2', '16', '1000']) : x()})`;
      case 4: return `(${x()} ${pick(['<<', '>>'])} ${r() < 0.7 ? pick(['1', '3', '31']) : x()})`;
      case 5: return `(${pick(['-', '~'])}(${x()}))`;
      case 6: return `int(${float(d - 1, v)})`;
      case 7: return `(if ${bool(d - 1, v)} { ${x()} } else { ${x()} })`;
      case 8: return `helper(${x()}, ${x()})`;
      case 9: return `${pick(['min', 'max'])}(${x()}, ${x()})`;
      case 10: return `abs(${x()})`;
      default: return `int(${bool(d - 1, v)})`;
    }
  }
  function float(d, v) {
    if (d <= 0 || r() < 0.22) return r() < 0.55 ? pick(v.f) : floatLit();
    const x = () => float(d - 1, v);
    switch (r.int(10)) {
      case 0: case 1: case 2: return `(${x()} ${pick(['+', '-', '*', '/'])} ${x()})`;
      case 3: return `(-(${x()}))`;
      case 4: return `float(${int(d - 1, v)})`;
      case 5: return `sqrt(abs(${x()}))`;
      case 6: return `${pick(['floor', 'ceil', 'abs'])}(${x()})`;
      case 7: return `${pick(['min', 'max'])}(${x()}, ${x()})`;
      case 8: return `${pick(['sin', 'cos'])}(${x()})`;
      default: return `(if ${bool(d - 1, v)} { ${x()} } else { ${x()} })`;
    }
  }
  function bool(d, v) {
    if (d <= 0 || r() < 0.2) return r() < 0.6 ? pick(v.b) : pick(['true', 'false']);
    const x = () => bool(d - 1, v);
    const cmp = () => pick(['<', '<=', '>', '>=', '==', '!=']);
    switch (r.int(6)) {
      case 0: case 1: return `(${int(d - 1, v)} ${cmp()} ${int(d - 1, v)})`;
      case 2: return `(${float(d - 1, v)} ${cmp()} ${float(d - 1, v)})`;
      case 3: return `(${x()} ${pick(['&&', '||', '==', '!='])} ${x()})`;
      case 4: return `(!${x()})`;
      default: return `(${x()} && ${x()})`;
    }
  }

  const ret = pick(['int', 'float', 'bool']);
  const v = { i: ['a', 'b', 'i0', 'i1'], f: ['x', 'y', 'f0'], b: ['p', 'q0'] };
  const inLoop = { i: [...v.i, 'k'], f: v.f, b: v.b };
  const value = { int, float, bool }[ret];
  const source = `fn helper(u: int, v: int) -> int {
  return ${int(2, { i: ['u', 'v'], f: ['1.5'], b: ['true'] })};
}
fn f(a: int, b: int, x: float, y: float, p: bool) -> ${ret} {
  var i0 = ${int(2, { i: ['a', 'b'], f: ['x', 'y'], b: ['p'] })};
  var i1 = ${int(1, { i: ['a', 'b', 'i0'], f: ['x', 'y'], b: ['p'] })};
  var f0 = ${float(2, { i: ['a', 'b', 'i0', 'i1'], f: ['x', 'y'], b: ['p'] })};
  var q0 = ${bool(2, { i: ['a', 'b', 'i0', 'i1'], f: ['x', 'y', 'f0'], b: ['p'] })};
  for k in 0..${1 + r.int(6)} {
    i0 = ${int(3, inLoop)};
    if ${bool(2, inLoop)} { f0 = ${float(3, inLoop)}; } else { i1 += ${int(2, inLoop)}; }
    if ${bool(2, inLoop)} { continue; }
    q0 = ${bool(2, inLoop)};
  }
  var n = 0;
  while n < ${r.int(6)} {
    n += 1;
    i1 = ${int(2, { ...v, i: [...v.i, 'n'] })};
    if ${bool(2, v)} { break; }
    f0 *= ${float(1, v)};
  }
  return ${value(3, v)};
}
`;
  const args = [
    pick([0, 1, -1, 7, 100, -2147483648, 2147483647, r.int(100000) - 50000]),
    pick([0, 1, 2, -3, 31, 65536, r.int(1000) - 500]),
    pick([0, 1, -1.5, 0.25, 1e9, -1e-3, r() * 100 - 50]),
    pick([0, 2, -0.5, 3.75, r() * 10]),
    r() < 0.5 ? 1 : 0,
  ];
  return { source, args, ret };
}
