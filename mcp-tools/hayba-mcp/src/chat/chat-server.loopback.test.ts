import { afterEach, describe, expect, it } from 'vitest';
import express from 'express';
import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { registerChatRoutes, __resetChatState } from './chat-server.js';
import { temporarySessionStore } from './session-store.test-helpers.js';

/** Raw request so the test controls Host/Origin (fetch forbids setting Host). */
function raw(port: number, method: string, path: string, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port, path, method, headers: { 'content-type': 'application/json', ...headers } }, (res) => {
      res.resume(); resolve(res.statusCode ?? 0);
    });
    req.on('error', reject);
    req.end(method === 'GET' ? undefined : '{}');
  });
}

describe('chat routes DNS-rebinding guard (R7)', () => {
  let server: Server;
  afterEach(() => { server?.close(); __resetChatState(); });

  async function start(): Promise<number> {
    const app = express();
    app.use(express.json());
    registerChatRoutes(app, { sessionStore: temporarySessionStore(), tools: [], dispatchTool: async () => ({}) });
    server = app.listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    return (server.address() as AddressInfo).port;
  }

  it('refuses a rebound Host or a foreign Origin on every /chat route', async () => {
    const port = await start();
    for (const [method, path] of [['GET', '/chat/sessions'], ['GET', '/chat/config'], ['POST', '/chat/config'], ['POST', '/chat/stream'], ['POST', '/chat/cancel'], ['POST', '/chat/approve']] as const) {
      expect(await raw(port, method, path, { host: `evil.example:${port}` }), `${method} ${path} host`).toBe(403);
      expect(await raw(port, method, path, { host: `127.0.0.1:${port}`, origin: 'https://evil.example' }), `${method} ${path} origin`).toBe(403);
    }
  });

  it('still serves loopback callers', async () => {
    const port = await start();
    expect(await raw(port, 'GET', '/chat/sessions', { host: `127.0.0.1:${port}` })).toBe(200);
    expect(await raw(port, 'GET', '/chat/sessions', { host: `localhost:${port}`, origin: `http://localhost:${port}` })).toBe(200);
  });
});
