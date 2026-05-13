/**
 * Zero-dep static dev server for the A1 architecture demo. Serves the package
 * root so the HTML page can fetch `../src/data/...` directly.
 *
 *   npm run serve   →  http://localhost:5184/demo/
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '..', '..');
const START_PORT = Number(process.env.PORT ?? 5184);
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
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found: ' + req.url);
  }
});

function listen(port, tries) {
  server.once('error', (err) => {
    if (err.code === 'EADDRINUSE' && tries < MAX_TRIES) {
      listen(port + 1, tries + 1);
    } else {
      throw err;
    }
  });
  server.listen(port, () => {
    console.log(`hayba architecture demo · http://localhost:${port}/demo/`);
  });
}
listen(START_PORT, 0);
