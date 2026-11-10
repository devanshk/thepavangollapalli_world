// A machine runs one compiled program on one of the two back ends. The same code serves the
// worker (WebAssembly, with the interpreter as a fallback) and the page itself when no worker
// can be created (interpreter only, with a small step budget so the page never freezes).
import { compile } from './compiler.js';
import { createInterpreter } from './interp.js';
import { hostImports, Trap } from './ops.js';

const now = () => performance.now();

/** Engine trap messages differ between browsers; say the same thing everywhere. */
function explain(err) {
  if (err instanceof Trap) return err.message;
  const m = String((err && err.message) || err);
  if (/unreachable/i.test(m)) return 'array index out of bounds';
  if (/divi(de|sion) by zero|remainder by zero/i.test(m)) return 'integer division by zero';
  if (/unrepresentable in integer|trunc/i.test(m)) return 'a float is out of range for an int';
  if (/integer overflow|result unrepresentable/i.test(m)) return 'integer overflow';
  if (/call stack|recursion|stack overflow/i.test(m)) return 'the call stack overflowed (recursion too deep)';
  return m;
}

export async function createMachine(source, { backend = 'wasm', optimise = true, fuel = 4e8 } = {}) {
  const result = compile(source, { optimise });
  if (!result.ok) throw new Error(result.error.message);
  const { program } = result;
  const names = new Set(program.fns.map((f) => f.name));
  const size = program.fbWidth * program.fbHeight * 4;
  let prints = [];
  const print = (line) => {
    if (prints.length < 400) prints.push(line);
  };
  const common = {
    has: (name) => names.has(name),
    takePrints() {
      const out = prints;
      prints = [];
      return out;
    },
  };

  let note = null;
  if (backend === 'wasm') {
    try {
      const { instance } = await WebAssembly.instantiate(result.bytes, hostImports(print));
      return {
        ...common,
        backend: 'wasm',
        note,
        call: (name, ...args) => instance.exports[name](...args),
        pixels: () => new Uint8ClampedArray(instance.exports.memory.buffer, 0, size).slice(),
      };
    } catch (err) {
      note = 'WebAssembly is blocked here, so the interpreter is running the program instead.';
    }
  }
  const interp = createInterpreter(program, { print }, { fuel });
  return {
    ...common,
    backend: 'interp',
    note,
    call(name, ...args) {
      interp.refuel(fuel);
      return interp.call(name, ...args);
    },
    pixels: () => interp.pixels.slice(),
  };
}

/** A message handler: { id, type: 'load' | 'frame' | 'bench', … } → reply. Never throws. */
export function createHost({ interpretOnly = false, fuel = 4e8 } = {}) {
  let machine = null;
  const timed = (fn) => {
    const t0 = now();
    fn();
    return now() - t0;
  };

  return async function handle(m) {
    try {
      if (m.type === 'load') {
        machine = null;
        machine = await createMachine(m.source, { optimise: m.optimise, backend: interpretOnly ? 'interp' : 'wasm', fuel });
        const reply = { id: m.id, ok: true, backend: machine.backend, note: machine.note, hasMain: machine.has('main'), hasFrame: machine.has('frame'), mainMs: null, frameMs: null };
        if (reply.hasMain) reply.mainMs = timed(() => machine.call('main'));
        if (reply.hasFrame) reply.frameMs = timed(() => machine.call('frame', m.t || 0));
        return { ...reply, prints: machine.takePrints(), pixels: machine.pixels().buffer };
      }
      if (m.type === 'frame') {
        if (!machine) throw new Error('no program is loaded');
        const frameMs = timed(() => machine.call('frame', m.t));
        return { id: m.id, ok: true, frameMs, prints: machine.takePrints(), pixels: machine.pixels().buffer };
      }
      if (m.type === 'bench') {
        const compiled = await createMachine(m.source, { optimise: m.optimise, backend: 'wasm' });
        const name = compiled.has('main') ? 'main' : 'frame';
        const args = name === 'frame' ? [1] : [];
        let wasmMs = null;
        if (compiled.backend === 'wasm') {
          compiled.call(name, ...args); // once to warm up, then keep the best of three
          wasmMs = Math.min(...[0, 1, 2].map(() => timed(() => compiled.call(name, ...args))));
        }
        const slow = await createMachine(m.source, { optimise: m.optimise, backend: 'interp', fuel: 4e9 });
        const interpMs = timed(() => slow.call(name, ...args));
        return { id: m.id, ok: true, name, wasmMs, interpMs };
      }
      throw new Error(`unknown request "${m.type}"`);
    } catch (err) {
      return { id: m.id, ok: false, error: explain(err), prints: machine ? machine.takePrints() : [] };
    }
  };
}
