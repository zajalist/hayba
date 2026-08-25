import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { setupRecipeSystem } from '../recipes/index.js';
import { mountRecipeRoutes } from './recipe-routes.js';
import { installHttpErrorBoundary } from './express-boundary.js';

describe('recipe HTTP routes', () => {
  let userDir: string;
  let sys: Awaited<ReturnType<typeof setupRecipeSystem>>;
  let server: Server;
  let url: string;

  beforeEach(async () => {
    userDir = mkdtempSync(join(tmpdir(), 'hayba-sl-http-'));
    sys = await setupRecipeSystem({ userDir, bundledDir: 'src/recipes/specs', maxDepth: 4 });
    const app = express();
    app.set('query parser', 'simple');
    app.use(express.json({ limit: '1mb', strict: true }));
    mountRecipeRoutes(app, sys);
    app.use('/recipe', (_req, res) => res.status(404).json({ error: 'Not found' }));
    installHttpErrorBoundary(app);
    server = app.listen(0);
    const port = (server.address() as AddressInfo).port;
    url = `http://127.0.0.1:${port}`;
  });
  afterEach(() => {
    server.close();
    rmSync(userDir, { recursive: true, force: true });
  });

  it('GET /recipe/list returns installed recipes', async () => {
    const r = await fetch(`${url}/recipe/list`);
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.recipes.length).toBeGreaterThan(0);
    expect(body.recipes[0].id).toBe('com.hayba.composition.frame_target');
  });

  it('GET /recipe/list?category=composition filters', async () => {
    const r = await fetch(`${url}/recipe/list?category=composition`);
    const body = await r.json();
    expect(body.recipes.every((s: { category: string }) => s.category === 'composition')).toBe(true);
  });

  it('GET /recipe/get?id=... returns the full spec', async () => {
    const r = await fetch(`${url}/recipe/get?id=com.hayba.composition.frame_target`);
    const body = await r.json();
    expect(body.found).toBe(true);
    expect(body.spec.params.length).toBeGreaterThan(0);
  });

  it('POST /recipe/run executes and returns outputs', async () => {
    const r = await fetch(`${url}/recipe/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'com.hayba.composition.frame_target', params: { target: '/Game/X.X' } }),
    });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.ok).toBe(true);
    expect(body.outputs).toHaveProperty('camera_transform');
  });

  it('POST /recipe/run returns ok=false on validation failure', async () => {
    const r = await fetch(`${url}/recipe/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: 'com.hayba.composition.frame_target',
        params: { target: '/Game/X.X', distance: 9999 },
      }),
    });
    const body = await r.json();
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/distance/);
  });

  it('POST /recipe/import installs from a JSON body', async () => {
    const spec = {
      id: 'com.test.http.demo',
      version: '1.0.0',
      category: 'demo',
      title: 'HTTP Demo',
      description: '',
      author: 'test',
      params: [],
      executor: { kind: 'demo.http' },
      determinism: { pure: true, declared_outputs: [], side_effects: [], seed_param: null },
    };
    const r = await fetch(`${url}/recipe/import`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ spec }),
    });
    const body = await r.json();
    expect(body.ok).toBe(true);
    expect(sys.loader.get('com.test.http.demo')).toBeDefined();
  });

  it('rejects absent and malformed JSON bodies as JSON 400s', async () => {
    const absent = await fetch(`${url}/recipe/run`, { method: 'POST' });
    expect(absent.status).toBe(400);
    expect(await absent.json()).toEqual({ error: 'missing id' });

    const malformed = await fetch(`${url}/recipe/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"id":',
    });
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toEqual({ error: 'Request body must be one valid JSON object' });
  });

  it('returns a bounded JSON 413 when the direct HTTP body limit is exceeded', async () => {
    const response = await fetch(`${url}/recipe/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'x', padding: 'a'.repeat(1_100_000) }),
    });
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: "JSON body exceeds this endpoint's configured limit" });
  });

  it('rejects duplicate query keys rather than selecting one implicitly', async () => {
    const response = await fetch(`${url}/recipe/get?id=first&id=second`);
    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain('exactly once');
  });

  it('keeps unknown recipe routes on the JSON boundary', async () => {
    const response = await fetch(`${url}/recipe/not-a-route`);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'Not found' });
  });
});
