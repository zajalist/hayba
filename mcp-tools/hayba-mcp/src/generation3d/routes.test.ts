import express from 'express';
import { request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerGeneration3DRoutes } from './routes.js';

let server: Server;
afterEach(async () => { if (server) await new Promise<void>(resolve => server.close(() => resolve())); });
async function start() {
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(JSON.stringify({ code: 0, data: { balance: 20 } })));
  const app = express();
  registerGeneration3DRoutes(app, { fetch });
  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const port = (server.address() as AddressInfo).port;
  function call(path: string, body?: string, headers: Record<string, string> = {}, prefix = '/chat/3d') {
    return new Promise<{ status: number; body: any }>((resolve, reject) => {
      const req = request({ hostname: '127.0.0.1', port, path: `${prefix}${path}`, method: body === undefined ? 'GET' : 'POST', headers: { host: `127.0.0.1:${port}`, 'content-type': 'application/json', ...headers } }, res => {
        let text = '';
        res.on('data', chunk => text += chunk);
        res.on('end', () => resolve({ status: res.statusCode!, body: JSON.parse(text) }));
      });
      req.on('error', reject); req.end(body);
    });
  }
  return { call, fetch };
}
describe('loopback-only 3D routes', () => {
  it('serves safe capability metadata and probes without returning the key', async () => {
    const { call, fetch } = await start();
    const metadata = await call('/providers');
    expect(metadata.status).toBe(200);
    expect(metadata.body.providers).toHaveLength(5);
    expect((await call('/providers', undefined, {}, '/chat/generation')).body).toEqual(metadata.body);
    const result = await call('/connection', JSON.stringify({ provider: 'tripo', api_key: 'private-key' }));
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ provider: 'tripo', verified: true });
    expect(JSON.stringify(result)).not.toContain('private-key');
    expect(fetch).toHaveBeenCalledTimes(1);
  }, 15000);
  it('rejects rebound hosts, hostile origins, opaque origins, and wrong content type before upstream calls', async () => {
    const { call, fetch } = await start();
    for (const path of ['/connection', '/tasks', '/tasks/status']) {
      expect((await call(path, '{}', { host: 'attacker.example' })).status).toBe(403);
      expect((await call(path, '{}', { origin: 'https://attacker.example' })).status).toBe(403);
      expect((await call(path, '{}', { origin: 'null' })).status).toBe(403);
      expect((await call(path, '{}', { 'content-type': 'text/plain' })).status).toBe(415);
    }
    expect((await call('/providers', undefined, { host: 'evil.example' })).status).toBe(403);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('routes creation and polling to the real adapter and sanitizes upstream failures', async () => {
    const { call, fetch } = await start();
    fetch.mockResolvedValueOnce(new Response(JSON.stringify({ code: 0, data: { task_id: 'task_123' } })));
    const created = await call('/tasks', JSON.stringify({ provider: 'tripo', api_key: 'private-key', prompt: 'chair' }));
    expect(created).toMatchObject({ status: 200, body: { task_id: 'task_123', status: 'queued', progress: 0 } });
    fetch.mockResolvedValueOnce(new Response(JSON.stringify({ code: 0, data: { task_id: 'task_123', status: 'running', progress: 42 } })));
    expect(await call('/tasks/status', JSON.stringify({ provider: 'tripo', api_key: 'private-key', task_id: 'task_123' }))).toMatchObject({ status: 200, body: { status: 'running', progress: 42 } });
    fetch.mockResolvedValueOnce(new Response('private-key', { status: 401 }));
    const failed = await call('/connection', JSON.stringify({ provider: 'tripo', api_key: 'private-key' }));
    expect(failed).toMatchObject({ status: 401, body: { error: { code: 'PROVIDER_AUTH_FAILED' } } });
    expect(JSON.stringify(failed)).not.toContain('private-key');
  });
  it('sanitizes malformed JSON, overlarge JSON and invalid request errors', async () => {
    const { call, fetch } = await start();
    for (const body of ['{"api_key":"private-key",', JSON.stringify({ provider: 'other', api_key: 'private-key' }), JSON.stringify({ provider: 'tripo', api_key: 'private-key', prompt: 'x'.repeat(20000) })]) {
      const result = await call('/tasks', body);
      expect([400, 413]).toContain(result.status);
      expect(result.body).toHaveProperty('error.code');
      expect(JSON.stringify(result)).not.toContain('private-key');
    }
    expect(fetch).not.toHaveBeenCalled();
  });
});
