// Builds the single-file "fragment" variant of index.html for sandboxed hosts that wrap pages in
// their own document skeleton (no <html>/<head>/<body> of our own), and lists the files that
// must be published beside it:  node tools/artifact.mjs <out-dir>
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import { ROOT } from './serve.mjs';

const outDir = process.argv[2];
if (!outDir) throw new Error('usage: node tools/artifact.mjs <out-dir>');
const html = await readFile(path.join(ROOT, 'index.html'), 'utf8');
const title = /<title>[^<]*<\/title>/.exec(html)[0];
const links = html.match(/<link rel="stylesheet"[^>]*>/g).join('\n');
const body = /<body[^>]*>([\s\S]*)<\/body>/.exec(html)[1].trim();
const fragment = `${title}\n<meta name="claude:viewport-fit-sides" content="cover">\n${links}\n${body}\n`;
await mkdir(outDir, { recursive: true });
await writeFile(path.join(outDir, 'from-scratch.html'), fragment);

async function walk(dir, out = []) {
  for (const d of await readdir(dir, { withFileTypes: true })) {
    if (d.name.startsWith('_') || d.name.startsWith('.') || d.name === 'README.md') continue;
    const p = path.join(dir, d.name);
    if (d.isDirectory()) await walk(p, out);
    else out.push(path.relative(ROOT, p).split(path.sep).join('/'));
  }
  return out;
}
const files = [...(await walk(path.join(ROOT, 'assets'))), ...(await walk(path.join(ROOT, 'exhibits')))].sort();
await writeFile(path.join(outDir, 'files.json'), JSON.stringify(files));
console.log(`${files.length} files\n${files.join(' ')}`);
