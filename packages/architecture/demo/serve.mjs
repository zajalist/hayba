/**
 * Zero-dep static dev server for the A1 architecture demo. Serves the package
 * root so the HTML page can fetch `../src/data/...` directly.
 *
 *   npm run serve   →  http://localhost:5184/demo/
 *
 * SSE note: GET /api/events cannot fit into the handleRequest({method,url,body}) → {status,body}
 * shape because it requires a long-lived raw ServerResponse. The HTTP wrapper detects
 * { status: 0, sse: true } and handles the connection separately, outside handleRequest.
 */
import { createServer } from 'node:http';
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { watch } from 'node:fs';
import { extname, join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listCultures, readCulture, writeCulture, deleteCulture, seedCulture } from '../dist/culture/index.js';
import { resolveRules } from '../dist/culture/resolve.js';

const ROOT = resolve(fileURLToPath(import.meta.url), '..', '..');

// Default cultures dir — can be overridden in tests via __setDataDir
const DEFAULT_CULTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), '../src/data/cultures');
let dataCulturesDir = DEFAULT_CULTURES_DIR;

/** Test helper: redirect the cultures directory. */
export function __setDataDir(dir) {
  dataCulturesDir = dir;
}

// ─── SSE subscriber registry ──────────────────────────────────────────────────
/** @type {Set<import('node:http').ServerResponse>} */
const sseSubscribers = new Set();

function broadcastCultureChanged(id) {
  const payload = `event: culture-changed\ndata: ${JSON.stringify({ id })}\n\n`;
  for (const res of sseSubscribers) {
    try { res.write(payload); } catch { sseSubscribers.delete(res); }
  }
}

// ─── File watcher (debounced per culture id) ──────────────────────────────────
const debounceTimers = new Map();

function startWatcher() {
  try {
    const watcher = watch(DEFAULT_CULTURES_DIR, { recursive: true }, (_event, filename) => {
      if (!filename) return;
      // filename is like "norse/culture.json" — grab the first path segment
      const cultureId = filename.split(/[\\/]/)[0];
      if (!cultureId) return;
      clearTimeout(debounceTimers.get(cultureId));
      debounceTimers.set(cultureId, setTimeout(() => {
        debounceTimers.delete(cultureId);
        broadcastCultureChanged(cultureId);
      }, 200));
    });
    watcher.on('error', () => { /* silently ignore watch errors */ });
  } catch {
    // cultures dir may not exist yet during tests — that's fine
  }
}

// ─── Core request dispatcher ──────────────────────────────────────────────────
/**
 * Pure async dispatcher. Returns { status, body, headers? }.
 * Special sentinel for SSE: { status: 0, sse: true } — the HTTP wrapper
 * handles the long-lived connection separately.
 *
 * @param {{ method: string, url: string, body?: string }} req
 * @returns {Promise<{ status: number, body?: string, headers?: Record<string,string>, sse?: boolean }>}
 */
export async function handleRequest({ method, url, body }) {
  // Strip query string
  const path = url.split('?')[0];

  // ─── SSE: sentinel only, raw connection handled by HTTP wrapper ───────────
  if (path === '/api/events' && method === 'GET') {
    return { status: 0, sse: true };
  }

  const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };

  // ─── GET /api/cultures ────────────────────────────────────────────────────
  if (path === '/api/cultures' && method === 'GET') {
    const list = await listCultures(dataCulturesDir);
    return { status: 200, body: JSON.stringify(list), headers: JSON_HEADERS };
  }

  // ─── POST /api/cultures ───────────────────────────────────────────────────
  if (path === '/api/cultures' && method === 'POST') {
    let parsed;
    try { parsed = JSON.parse(body ?? '{}'); } catch {
      return { status: 400, body: JSON.stringify({ error: 'invalid JSON' }), headers: JSON_HEADERS };
    }
    const { id, name, region, climate } = parsed;
    if (!id || !name || !region || !climate) {
      return { status: 400, body: JSON.stringify({ error: 'id, name, region, climate required' }), headers: JSON_HEADERS };
    }
    // 409 on duplicate
    const existing = await listCultures(dataCulturesDir);
    if (existing.some(c => c.id === id)) {
      return { status: 409, body: JSON.stringify({ error: `culture '${id}' already exists` }), headers: JSON_HEADERS };
    }
    const culture = seedCulture({ id, name, region, climate });
    await writeCulture(dataCulturesDir, culture);
    const full = await readCulture(dataCulturesDir, id);
    return { status: 201, body: JSON.stringify(full), headers: JSON_HEADERS };
  }

  // ─── GET /api/cultures/:id ────────────────────────────────────────────────
  const cultureIdMatch = path.match(/^\/api\/cultures\/([^/]+)$/);
  if (cultureIdMatch) {
    const id = cultureIdMatch[1];

    if (method === 'GET') {
      try {
        const culture = await readCulture(dataCulturesDir, id);
        return { status: 200, body: JSON.stringify(culture), headers: JSON_HEADERS };
      } catch {
        return { status: 404, body: JSON.stringify({ error: 'not found' }), headers: JSON_HEADERS };
      }
    }

    // ─── PATCH /api/cultures/:id ───────────────────────────────────────────
    if (method === 'PATCH') {
      let existing;
      try { existing = await readCulture(dataCulturesDir, id); } catch {
        return { status: 404, body: JSON.stringify({ error: 'not found' }), headers: JSON_HEADERS };
      }
      let patch;
      try { patch = JSON.parse(body ?? '{}'); } catch {
        return { status: 400, body: JSON.stringify({ error: 'invalid JSON' }), headers: JSON_HEADERS };
      }
      // Deep-merge top-level fields; arrays replaced wholesale
      const merged = { ...existing, ...patch };
      await writeCulture(dataCulturesDir, merged);
      const full = await readCulture(dataCulturesDir, id);
      return { status: 200, body: JSON.stringify(full), headers: JSON_HEADERS };
    }

    // ─── DELETE /api/cultures/:id ──────────────────────────────────────────
    if (method === 'DELETE') {
      // 404 if not found
      try { await readCulture(dataCulturesDir, id); } catch {
        return { status: 404, body: JSON.stringify({ error: 'not found' }), headers: JSON_HEADERS };
      }
      await deleteCulture(dataCulturesDir, id);
      return { status: 204, body: '', headers: {} };
    }
  }

  // ─── GET /api/cultures/:id/resolve ───────────────────────────────────────
  const resolveMatch = path.match(/^\/api\/cultures\/([^/]+)\/resolve$/);
  if (resolveMatch && method === 'GET') {
    const id = resolveMatch[1];
    const qp = new URLSearchParams(url.split('?')[1] ?? '');
    const eraId    = qp.get('eraId');
    const scenario = qp.get('scenario');
    const tagsRaw  = qp.get('tags') ?? '';
    if (!eraId || scenario === null) {
      return { status: 400, body: JSON.stringify({ error: 'eraId and scenario are required' }), headers: JSON_HEADERS };
    }
    let culture;
    try { culture = await readCulture(dataCulturesDir, id); } catch {
      return { status: 404, body: JSON.stringify({ error: 'culture not found' }), headers: JSON_HEADERS };
    }
    const era = (culture.eras ?? []).find(e => e.id === eraId);
    if (!era) {
      return { status: 404, body: JSON.stringify({ error: 'era not found' }), headers: JSON_HEADERS };
    }
    // Parse tags=axis1:val1,axis2:val2
    const tagState = {};
    if (tagsRaw) {
      for (const pair of tagsRaw.split(',')) {
        const colon = pair.indexOf(':');
        if (colon > 0) tagState[pair.slice(0, colon)] = pair.slice(colon + 1);
      }
    }
    // Resolve with ruleId for tooltip support
    const eraIds = new Set((era.rules ?? []).map(r => r.id));
    const allRules = [
      ...(culture.rules ?? []).filter(r => !eraIds.has(r.id)).map(rule => ({ rule, source: 0 })),
      ...(era.rules ?? []).map(rule => ({ rule, source: 1 })),
    ];
    const matches = allRules.filter(({ rule }) => {
      if (rule.conditions?.scenario !== undefined && rule.conditions.scenario !== scenario) return false;
      for (const [axis, val] of Object.entries(rule.conditions?.tagMatches ?? {})) {
        if (tagState[axis] !== val) return false;
      }
      return true;
    });
    matches.sort((a, b) => {
      if (b.rule.priority !== a.rule.priority) return b.rule.priority - a.rule.priority;
      return a.source - b.source;
    });
    const best = matches[0];
    return {
      status: 200,
      body: JSON.stringify({ assigns: best?.rule.assigns ?? {}, ruleId: best?.rule.id ?? null }),
      headers: JSON_HEADERS,
    };
  }

  // ─── GET /api/bindings/list ───────────────────────────────────────────────
  if (path === '/api/bindings/list' && method === 'GET') {
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
          out.push({ styleSheetId: sheetEntry.name, elementId: fileEntry.name.replace(/\.json$/, '') });
        }
      }
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
    return { status: 200, body: JSON.stringify(out), headers: JSON_HEADERS };
  }

  // Not an API route — signal caller to serve static file
  return { status: -1 };
}

// ─── MIME map ─────────────────────────────────────────────────────────────────
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.mjs':  'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map':  'application/json; charset=utf-8',
  '.svg':  'image/svg+xml',
};

// ─── HTTP body reader ─────────────────────────────────────────────────────────
async function readBody(req, maxBytes = 1_000_000) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (c) => {
      total += c.length;
      if (total > maxBytes) { reject(new Error(`request body exceeds ${maxBytes} bytes`)); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

// ─── HTTP server ──────────────────────────────────────────────────────────────
const server = createServer(async (req, res) => {
  try {
    let rawUrl = decodeURIComponent((req.url ?? '/').split('?')[0]);

    // SSE: long-lived connection, bypass handleRequest
    if (rawUrl === '/api/events' && req.method === 'GET') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        'connection': 'keep-alive',
        'access-control-allow-origin': '*',
      });
      res.write(':ok\n\n');
      sseSubscribers.add(res);
      const heartbeat = setInterval(() => {
        try { res.write(':keepalive\n\n'); } catch { /* ignore */ }
      }, 25_000);
      res.on('close', () => { sseSubscribers.delete(res); clearInterval(heartbeat); });
      return;
    }

    const bodyText = ['POST', 'PATCH', 'PUT'].includes(req.method ?? '') ? await readBody(req) : undefined;
    const result = await handleRequest({ method: req.method ?? 'GET', url: rawUrl, body: bodyText });

    // API route matched
    if (result.status !== -1) {
      res.writeHead(result.status, result.headers ?? {});
      res.end(result.body ?? '');
      return;
    }

    // Static file serving
    let url = rawUrl;
    if (url === '/') url = '/demo/';
    if (url.endsWith('/')) url += 'index.html';
    const fp = join(ROOT, url);
    if (!fp.startsWith(ROOT)) { res.writeHead(403); return res.end('forbidden'); }
    const fileBody = await readFile(fp);
    res.writeHead(200, { 'content-type': MIME[extname(fp)] ?? 'application/octet-stream' });
    res.end(fileBody);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found: ' + req.url);
  }
});

const START_PORT = Number(process.env.PORT ?? 5184);
const MAX_TRIES = 20;

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

// Only start server + watcher when run directly (not imported by tests)
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  startWatcher();
  listen(START_PORT, 0);
}
