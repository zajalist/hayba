import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { setupSliverSystem } from '../slivers/index.js';
import { mountSliverRoutes } from './sliver-routes.js';

describe('sliver HTTP routes', () => {
  let userDir: string;
  let sys: Awaited<ReturnType<typeof setupSliverSystem>>;
  let server: Server;
  let url: string;

  beforeEach(async () => {
    userDir = mkdtempSync(join(tmpdir(), 'hayba-sl-http-'));
    sys = await setupSliverSystem({ userDir, bundledDir: 'src/slivers/specs', maxDepth: 4 });
    const app = express();
    app.use(express.json());
    mountSliverRoutes(app, sys);
    server = app.listen(0);
    const port = (server.address() as AddressInfo).port;
    url = `http://127.0.0.1:${port}`;
  });
  afterEach(() => {
    server.close();
    rmSync(userDir, { recursive: true, force: true });
  });

  it('GET /sliver/list returns installed slivers', async () => {
    const r = await fetch(`${url}/sliver/list`);
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.slivers.length).toBeGreaterThan(0);
    expect(body.slivers[0].id).toBe('com.hayba.composition.frame_target');
  });

  it('GET /sliver/list?category=composition filters', async () => {
    const r = await fetch(`${url}/sliver/list?category=composition`);
    const body = await r.json();
    expect(body.slivers.every((s: { category: string }) => s.category === 'composition')).toBe(true);
  });

  it('GET /sliver/get?id=... returns the full spec', async () => {
    const r = await fetch(`${url}/sliver/get?id=com.hayba.composition.frame_target`);
    const body = await r.json();
    expect(body.found).toBe(true);
    expect(body.spec.params.length).toBeGreaterThan(0);
  });

  it('POST /sliver/run executes and returns outputs', async () => {
    const r = await fetch(`${url}/sliver/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'com.hayba.composition.frame_target', params: { target: '/Game/X.X' } }),
    });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.ok).toBe(true);
    expect(body.outputs).toHaveProperty('camera_transform');
  });

  it('POST /sliver/run returns ok=false on validation failure', async () => {
    const r = await fetch(`${url}/sliver/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'com.hayba.composition.frame_target', params: { target: '/Game/X.X', distance: 9999 } }),
    });
    const body = await r.json();
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/distance/);
  });

  it('POST /sliver/import installs from a JSON body', async () => {
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
    const r = await fetch(`${url}/sliver/import`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ spec }),
    });
    const body = await r.json();
    expect(body.ok).toBe(true);
    expect(sys.loader.get('com.test.http.demo')).toBeDefined();
  });
});
