// Static file server for local development: `node tools/serve.mjs [port]` (default 4173).
// Also exported as startServer() so the test tooling can run on an ephemeral port.
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
};

export function startServer(port = 0, root = ROOT) {
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      let file = path.normalize(path.join(root, decodeURIComponent(url.pathname)));
      if (!file.startsWith(root)) {
        res.writeHead(403).end('Forbidden');
        return;
      }
      let info = await stat(file).catch(() => null);
      if (info && info.isDirectory()) {
        file = path.join(file, 'index.html');
        info = await stat(file).catch(() => null);
      }
      if (!info) {
        res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found: ' + url.pathname);
        return;
      }
      const body = await readFile(file);
      res.writeHead(200, {
        'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
        'cache-control': 'no-store',
      });
      res.end(body);
    } catch (err) {
      res.writeHead(500, { 'content-type': 'text/plain' }).end(String(err));
    }
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const { port: actual } = server.address();
      resolve({ server, port: actual, url: `http://127.0.0.1:${actual}`, close: () => new Promise((r) => server.close(r)) });
    });
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.argv[2] || process.env.PORT || 4173);
  const { url } = await startServer(port);
  console.log(`Serving ${ROOT}\n  → ${url}/`);
}
