/**
 * Zero-dep static dev server for the L1 demo. Serves the package root so the
 * HTML page can import `../dist/index.js` directly.
 *
 *   npm run serve   →  http://localhost:5173/demo/
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '..', '..');
const START_PORT = Number(process.env.PORT ?? 5183);
const MAX_TRIES = 20;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.mjs':  'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map':  'application/json; charset=utf-8',
  '.svg':  'image/svg+xml',
};

const server = createServer(async (req, res) => {
  try {
    let url = decodeURIComponent((req.url ?? '/').split('?')[0]);
    if (url === '/') url = '/demo/';
    if (url.endsWith('/')) url += 'index.html';
    const fp = join(ROOT, url);
    if (!fp.startsWith(ROOT)) { res.writeHead(403); return res.end('forbidden'); }
    const body = await readFile(fp);
    res.writeHead(200, { 'content-type': MIME[extname(fp)] ?? 'application/octet-stream' });
    res.end(body);
  } catch (e) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found: ' + req.url);
  }
});

let attempt = 0;
server.on('error', (err) => {
  if (err.code !== 'EADDRINUSE') { console.error(err); process.exit(1); }
  if (attempt >= MAX_TRIES) { console.error(`no free port in ${START_PORT}..${START_PORT + MAX_TRIES}`); process.exit(1); }
  attempt++;
  setImmediate(() => server.listen(START_PORT + attempt));
});

server.listen(START_PORT, () => {
  const port = server.address().port;
  console.log(`hayba L1 demo → http://localhost:${port}/demo/`);
});
