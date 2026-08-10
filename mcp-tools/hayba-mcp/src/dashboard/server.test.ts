import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Express } from 'express';
import { createDashboardApp, startDashboard } from './server.js';
import { jsonObjectBody, stringQuery } from '../http/express-boundary.js';

const servers = new Set<Server>();
const tempDirs = new Set<string>();

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function listen(app: Express): Promise<{ server: Server; url: string }> {
  const server = app.listen(0, '127.0.0.1');
  servers.add(server);
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const port = (server.address() as AddressInfo).port;
  return { server, url: `http://127.0.0.1:${port}` };
}

function staticFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hayba-express5-'));
  tempDirs.add(dir);
  writeFileSync(join(dir, 'index.html'), '<!doctype html><title>Hayba SPA</title>', 'utf8');
  writeFileSync(join(dir, 'app.js'), 'globalThis.haybaLoaded = true;', 'utf8');
  writeFileSync(join(dir, '.env'), 'HAYBA_TEST_SECRET=must-not-serve', 'utf8');
  return dir;
}

afterEach(async () => {
  await Promise.all([...servers].map(closeServer));
  servers.clear();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.clear();
  vi.restoreAllMocks();
});

describe('Express 5 dashboard boundary', () => {
  it('registers the named SPA wildcard and serves root plus nested navigation', async () => {
    const staticDir = staticFixture();
    const app = createDashboardApp({ staticDir, registerRoutes: () => undefined });
    const { url } = await listen(app);

    for (const path of ['/', '/projects/alpha/editor']) {
      const response = await fetch(`${url}${path}`, { headers: { accept: 'text/html' } });
      expect(response.status).toBe(200);
      expect(await response.text()).toContain('Hayba SPA');
    }
  });

  it('pins static MIME behavior and refuses dotfiles or missing asset fallbacks', async () => {
    const staticDir = staticFixture();
    const app = createDashboardApp({ staticDir, registerRoutes: () => undefined });
    const { url } = await listen(app);

    const script = await fetch(`${url}/app.js`);
    expect(script.status).toBe(200);
    expect(script.headers.get('content-type')).toMatch(/^text\/javascript(?:;|$)/);
    expect(await script.text()).toContain('haybaLoaded');

    for (const path of ['/.env', '/missing.js']) {
      const response = await fetch(`${url}${path}`, { headers: { accept: 'text/html' } });
      expect(response.status).toBe(404);
      expect(await response.text()).not.toContain('Hayba SPA');
      expect(await fetch(`${url}${path}`).then((r) => r.text())).not.toContain('must-not-serve');
    }
  });

  it('never lets the SPA shadow API, chat, or sliver 404s', async () => {
    const app = createDashboardApp({ staticDir: staticFixture(), registerRoutes: () => undefined });
    const { url } = await listen(app);

    for (const path of ['/api/no-such-route', '/chat/no-such-route', '/sliver/no-such-route']) {
      const response = await fetch(`${url}${path}`, { headers: { accept: 'text/html' } });
      expect(response.status).toBe(404);
      expect(response.headers.get('content-type')).toContain('application/json');
      expect(await response.json()).toEqual({ error: 'Not found' });
    }
  });

  it('handles absent and malformed JSON bodies without HTML errors or throws', async () => {
    const app = createDashboardApp({
      staticDir: null,
      registerRoutes: (target) => {
        target.post('/api/body', (req, res) => {
          const body = jsonObjectBody(req);
          if (typeof body.name !== 'string') return res.status(400).json({ error: 'name is required' });
          return res.json({ name: body.name });
        });
      },
    });
    const { url } = await listen(app);

    const absent = await fetch(`${url}/api/body`, { method: 'POST' });
    expect(absent.status).toBe(400);
    expect(await absent.json()).toEqual({ error: 'name is required' });

    const malformed = await fetch(`${url}/api/body`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"name":',
    });
    expect(malformed.status).toBe(400);
    expect(malformed.headers.get('content-type')).toContain('application/json');
    expect(await malformed.json()).toEqual({ error: 'Request body must be one valid JSON object' });
  });

  it('accepts a scalar, rejects an array, and keeps the simple parser non-nesting', async () => {
    const app = createDashboardApp({
      staticDir: null,
      registerRoutes: (target) => {
        target.get('/api/query', (req, res) => {
          const parsed = stringQuery(req.query.q, 'q');
          if (!parsed.ok) return res.status(400).json({ error: parsed.error });
          return res.json({ q: parsed.value ?? null });
        });
      },
    });
    const { url } = await listen(app);

    expect(await fetch(`${url}/api/query?q=one`).then((r) => r.json())).toEqual({ q: 'one' });

    const duplicate = await fetch(`${url}/api/query?q=one&q=two`);
    expect(duplicate.status).toBe(400);
    expect((await duplicate.json()).error).toContain('exactly once');

    // `simple` intentionally leaves bracket syntax as a different literal key;
    // it never constructs an attacker-controlled nested object for `q`.
    expect(await fetch(`${url}/api/query?q%5Bnested%5D=value`).then((r) => r.json())).toEqual({ q: null });
    expect(await fetch(`${url}/api/query?__proto__%5Bpolluted%5D=yes`).then((r) => r.json())).toEqual({ q: null });
    expect(({} as { polluted?: unknown }).polluted).toBeUndefined();
  });

  it('forwards rejected handlers to a generic redacted JSON error boundary', async () => {
    const logged: unknown[][] = [];
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      logged.push(args);
    });
    const app = createDashboardApp({
      staticDir: null,
      registerRoutes: (target) => {
        target.get('/api/reject', async () => {
          throw new Error('api_key=sk-this-must-not-reach-the-response');
        });
      },
    });
    const { url } = await listen(app);

    const response = await fetch(`${url}/api/reject`);
    expect(response.status).toBe(500);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(await response.json()).toEqual({ error: 'Internal server error' });
    expect(logged).toHaveLength(1);
    expect(String((logged[0]![1] as Error).message)).not.toContain('sk-this-must-not-reach');
  });

  it('redacts a JSON response exactly once at the dashboard boundary', async () => {
    const app = createDashboardApp({
      staticDir: null,
      registerRoutes: (target) => {
        target.get('/api/secret', (_req, res) => res.json({ api_key: 'sk-example-secret-value' }));
      },
    });
    const { url } = await listen(app);

    const body = await fetch(`${url}/api/secret`).then((response) => response.json());
    expect(body.api_key).toBe('[REDACTED:api_key]');
    expect(body._security_redaction.redacted_values).toBe(1);
  });

  it('binds, responds, returns a closeable handle, and shuts down cleanly', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const server = await startDashboard(0, '127.0.0.1', {
      staticDir: null,
      registerRoutes: (app) => {
        app.get('/api/smoke', (_req, res) => res.json({ ok: true }));
      },
    });
    expect(server).not.toBeNull();
    servers.add(server!);
    const port = (server!.address() as AddressInfo).port;
    expect(await fetch(`http://127.0.0.1:${port}/api/smoke`).then((r) => r.json())).toEqual({ ok: true });
    await closeServer(server!);
    expect(server!.listening).toBe(false);
  });

  it('reports EADDRINUSE through the Express 5 listen callback without crashing', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const blocker = createServer();
    servers.add(blocker);
    await new Promise<void>((resolve, reject) => {
      blocker.listen(0, '127.0.0.1', resolve);
      blocker.once('error', reject);
    });
    const port = (blocker.address() as AddressInfo).port;

    await expect(
      startDashboard(port, '127.0.0.1', {
        staticDir: null,
        registerRoutes: () => undefined,
      }),
    ).resolves.toBeNull();
    expect(blocker.listening).toBe(true);
  });
});
