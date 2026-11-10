// Node test runner: `node tools/test.mjs [exhibit-id ...]`
// Imports exhibits/<id>/tests.js for every exhibit (or just the ones named) and runs every
// test that is not flagged `browser: true`. Exits 1 if anything fails.
import { readdir, access } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT } from './serve.mjs';
import { runSuite } from '../assets/js/check.js';

const only = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const verbose = process.argv.includes('-v');
const dir = path.join(ROOT, 'exhibits');
const ids = (await readdir(dir, { withFileTypes: true }))
  .filter((d) => d.isDirectory() && (!only.length || only.includes(d.name)))
  .map((d) => d.name)
  .sort();

let failed = 0;
let passed = 0;
let skipped = 0;
for (const id of ids) {
  const file = path.join(dir, id, 'tests.js');
  if (!(await access(file).then(() => true, () => false))) {
    console.log(`${id}: no tests.js`);
    continue;
  }
  const mod = await import(pathToFileURL(file).href);
  const res = await runSuite(mod.default, { browser: false });
  passed += res.passed;
  failed += res.failed;
  skipped += res.skipped;
  console.log(`${res.failed ? '✗' : '✓'} ${id}: ${res.passed} passed, ${res.failed} failed, ${res.skipped} browser-only (${Math.round(res.ms)} ms)`);
  for (const r of res.results) {
    if (!r.ok) console.log(`    ✗ ${r.name}\n        ${r.error}`);
    else if (verbose && !r.skipped) console.log(`    ✓ ${r.name} (${r.ms.toFixed(1)} ms)`);
  }
}
console.log(`\n${passed} passed, ${failed} failed, ${skipped} browser-only skipped`);
process.exit(failed ? 1 : 0);
