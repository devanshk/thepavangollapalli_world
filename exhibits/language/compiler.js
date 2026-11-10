// The whole pipeline: source text → tokens → syntax tree → typed program → optimised program →
// WebAssembly bytes. Every stage is a pure function, so this runs the same in a browser, in a
// worker and in Node.
import { SableError } from './lexer.js';
import { parse } from './parser.js';
import { check } from './types.js';
import { optimise } from './optimise.js';
import { emit } from './wasm.js';

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

function describe(err, source) {
  const { line, col, start, end } = err.span;
  const text = (source.split('\n')[line - 1] || '').replace(/\t/g, ' ');
  const width = Math.max(1, Math.min(end - start, text.length - col + 1));
  return { message: err.message, hint: err.hint, line, col, span: err.span, excerpt: `${text}\n${' '.repeat(col - 1)}${'^'.repeat(width)}` };
}

/**
 * compile(source, { optimise = true }) →
 *   { ok: true, program, bytes, funcNames, ms }                       or
 *   { ok: false, error: { message, hint, line, col, span, excerpt }, ms }
 */
export function compile(source, { optimise: fold = true } = {}) {
  const t0 = now();
  try {
    let program = check(parse(source));
    if (fold) program = optimise(program);
    const { bytes, funcNames } = emit(program);
    return { ok: true, program, bytes, funcNames, ms: now() - t0 };
  } catch (err) {
    if (!(err instanceof SableError)) throw err;
    return { ok: false, error: describe(err, source), ms: now() - t0 };
  }
}
