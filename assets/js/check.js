// check.js — a test micro-framework that runs unchanged in Node and in the browser.
// Every exhibit ships `tests.js` exporting an array of { name, fn, browser? } built on these.

export class AssertionError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AssertionError';
  }
}

const show = (v) => {
  if (typeof v === 'string') return JSON.stringify(v);
  if (typeof v === 'bigint') return `${v}n`;
  if (typeof v === 'number' || v == null || typeof v === 'boolean') return String(v);
  try {
    const s = JSON.stringify(v, (_, x) => (typeof x === 'bigint' ? `${x}n` : ArrayBuffer.isView(x) ? Array.from(x) : x));
    return s.length > 240 ? s.slice(0, 240) + '…' : s;
  } catch {
    return String(v);
  }
};

export function deepEqual(a, b) {
  if (Object.is(a, b)) return true;
  if (typeof a !== typeof b || a == null || b == null) return false;
  if (typeof a !== 'object') return false;
  if (ArrayBuffer.isView(a) || ArrayBuffer.isView(b) || Array.isArray(a) || Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i])) return false;
    return true;
  }
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) if (!Object.prototype.hasOwnProperty.call(b, k) || !deepEqual(a[k], b[k])) return false;
  return true;
}

/** assert(condition, message) */
export function assert(cond, message = 'assertion failed') {
  if (!cond) throw new AssertionError(message);
}

/** equal(actual, expected, message?) — deep structural equality (arrays, typed arrays, plain objects). */
export function equal(actual, expected, message) {
  if (!deepEqual(actual, expected))
    throw new AssertionError(`${message ? message + ': ' : ''}expected ${show(expected)}, got ${show(actual)}`);
}

/** near(actual, expected, eps = 1e-9, message?) — |actual − expected| ≤ eps */
export function near(actual, expected, eps = 1e-9, message) {
  if (!(Math.abs(actual - expected) <= eps))
    throw new AssertionError(
      `${message ? message + ': ' : ''}expected ${expected} ± ${eps}, got ${actual} (off by ${Math.abs(actual - expected)})`,
    );
}

/** throws(fn, /pattern/?, message?) — fn must throw (and the error message must match, if given). */
export function throws(fn, pattern, message) {
  let threw = false;
  try {
    fn();
  } catch (err) {
    threw = true;
    if (pattern && !pattern.test(String(err && err.message)))
      throw new AssertionError(`${message ? message + ': ' : ''}threw "${err && err.message}", expected to match ${pattern}`);
  }
  if (!threw) throw new AssertionError(`${message ? message + ': ' : ''}expected the function to throw`);
}

/**
 * Run a suite. tests: [{ name, fn, browser? }]. Tests flagged `browser: true` are skipped
 * unless opts.browser is true. onResult(result, index) fires after each test.
 * → { passed, failed, skipped, ms, results: [{ name, ok, skipped, ms, error }] }
 */
export async function runSuite(tests, { browser = false, onResult } = {}) {
  const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
  const results = [];
  const t0 = now();
  for (let i = 0; i < tests.length; i++) {
    const t = tests[i];
    const r = { name: t.name, ok: true, skipped: false, ms: 0, error: null };
    if (t.browser && !browser) r.skipped = true;
    else {
      const s = now();
      try {
        await t.fn();
      } catch (err) {
        r.ok = false;
        r.error = String((err && err.message) || err);
      }
      r.ms = now() - s;
    }
    results.push(r);
    if (onResult) onResult(r, i);
  }
  return {
    passed: results.filter((r) => r.ok && !r.skipped).length,
    failed: results.filter((r) => !r.ok).length,
    skipped: results.filter((r) => r.skipped).length,
    ms: now() - t0,
    results,
  };
}
