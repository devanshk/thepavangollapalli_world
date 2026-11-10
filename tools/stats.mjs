// Counts what is actually in the repository and stamps the numbers into index.html, so every
// figure the page quotes about itself is measured:  node tools/stats.mjs [--write]
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT } from './serve.mjs';

const SKIP = new Set(['.git', 'node_modules', '_design', 'shots', 'tmp']);
const CODE = new Set(['.js', '.mjs', '.css', '.html']);

async function walk(dir, out = []) {
  for (const d of await readdir(dir, { withFileTypes: true })) {
    if (SKIP.has(d.name) || d.name.startsWith('_')) continue;
    const p = path.join(dir, d.name);
    if (d.isDirectory()) await walk(p, out);
    else out.push(p);
  }
  return out;
}
const lineCount = async (file) => (await readFile(file, 'utf8')).split('\n').length;

export async function collect() {
  const files = (await walk(ROOT)).filter((f) => CODE.has(path.extname(f)));
  let lines = 0;
  const perExhibit = {};
  for (const f of files) {
    const n = await lineCount(f);
    lines += n;
    const rel = path.relative(ROOT, f).split(path.sep);
    if (rel[0] === 'exhibits' && rel.length > 2) {
      const e = (perExhibit[rel[1]] ||= { files: 0, lines: 0, tests: 0, browserTests: 0 });
      e.files += 1;
      e.lines += n;
    }
  }
  let tests = 0;
  for (const id of Object.keys(perExhibit)) {
    const mod = await import(pathToFileURL(path.join(ROOT, 'exhibits', id, 'tests.js')).href).catch(() => null);
    if (!mod) continue;
    perExhibit[id].tests = mod.default.length;
    perExhibit[id].browserTests = mod.default.filter((t) => t.browser).length;
    tests += mod.default.length;
  }
  return { exhibits: Object.keys(perExhibit).length, files: files.length, lines, tests, perExhibit };
}

const stats = await collect();
console.log(JSON.stringify(stats, null, 2));

if (process.argv.includes('--write')) {
  const file = path.join(ROOT, 'index.html');
  let html = await readFile(file, 'utf8');
  const fmt = (n) => n.toLocaleString('en-US');
  const stamp = (key, value) => {
    // <any data-stat="key" …>old</any>  →  …>new</any>
    html = html.replace(new RegExp(`(data-stat="${key}"[^>]*>)[^<]*(<)`, 'g'), `$1${value}$2`);
  };
  stamp('exhibits', fmt(stats.exhibits));
  stamp('files', fmt(stats.files));
  stamp('lines', fmt(stats.lines));
  stamp('tests', fmt(stats.tests));
  for (const [id, e] of Object.entries(stats.perExhibit)) {
    stamp(`${id}-lines`, fmt(e.lines));
    stamp(`${id}-files`, fmt(e.files));
    stamp(`${id}-tests`, fmt(e.tests));
  }
  await writeFile(file, html);
  console.log('stamped index.html');
}
