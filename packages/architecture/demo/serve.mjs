/**
 * Zero-dep static dev server for the A1 architecture demo. Serves the package
 * root so the HTML page can fetch `../src/data/...` directly.
 *
 *   npm run serve   →  http://localhost:5184/demo/
 */
import { createServer } from 'node:http';
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '..', '..');

async function readBody(req, maxBytes = 1_000_000) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (c) => {
      total += c.length;
      if (total > maxBytes) {
        reject(new Error(`request body exceeds ${maxBytes} bytes`));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

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

    // ─── API: list bindings on disk ─────────────────────────────────────
    if (url === '/api/bindings/list' && req.method === 'GET') {
      const bindingsRoot = join(ROOT, 'src', 'bindings');
      const out = [];
      try {
        const styleSheets = await readdir(bindingsRoot, { withFileTypes: true });
        for (const sheetEntry of styleSheets) {
          if (!sheetEntry.isDirectory()) continue;
          const sheetDir = join(bindingsRoot, sheetEntry.name);
          const files = await readdir(sheetDir, { withFileTypes: true });
          for (const fileEntry of files) {
            if (!fileEntry.isFile() || !fileEntry.name.endsWith('.json')) continue;
            out.push({
              styleSheetId: sheetEntry.name,
              elementId: fileEntry.name.replace(/\.json$/, ''),
            });
          }
        }
      } catch (err) {
        if (err.code !== 'ENOENT') throw err;
      }
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(out));
      return;
    }

    // ─── API: write binding to disk ─────────────────────────────────────
    const writeMatch = url.match(/^\/api\/bindings\/([^/]+)\/([^/]+)$/);
    if (writeMatch && req.method === 'POST') {
      const [, styleSheetId, elementId] = writeMatch;
      const idPat = /^[a-z0-9_-]+$/i;
      if (!idPat.test(styleSheetId) || !idPat.test(elementId)) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'invalid id (only [A-Za-z0-9_-] allowed)' }));
        return;
      }
      let bodyText;
      try {
        bodyText = await readBody(req);
      } catch (err) {
        res.writeHead(413, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: err.message }));
        return;
      }
      let body;
      try {
        body = JSON.parse(bodyText);
      } catch {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'request body must be valid JSON' }));
        return;
      }
      if (typeof body !== 'object' || body === null ||
          body.elementId !== elementId || body.styleSheetId !== styleSheetId ||
          typeof body.profiles !== 'object' || typeof body.params !== 'object') {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          ok: false,
          error: 'binding JSON malformed: elementId/styleSheetId/profiles/params required and ids must match the URL',
        }));
        return;
      }
      const targetDir = join(ROOT, 'src', 'bindings', styleSheetId);
      const targetFile = join(targetDir, `${elementId}.json`);
      const bindingsRoot = join(ROOT, 'src', 'bindings');
      if (!targetFile.startsWith(bindingsRoot)) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'path traversal refused' }));
        return;
      }
      await mkdir(targetDir, { recursive: true });
      await writeFile(targetFile, JSON.stringify(body, null, 2) + '\n', 'utf-8');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, path: `src/bindings/${styleSheetId}/${elementId}.json` }));
      return;
    }

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
