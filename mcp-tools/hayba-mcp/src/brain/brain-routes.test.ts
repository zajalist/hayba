import { describe, expect, it } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { request } from 'node:http';
import { installExpressJsonRedaction } from '../security/secret-redaction.js';
import { registerBrainRoutes } from './brain-routes.js';
import type { BrainConnector } from './brain-connector.js';

function fakeConnector(): BrainConnector & { token: string | null; rotated: string | null } {
  const c = {
    token: null as string | null,
    rotated: null as string | null,
    configured: () => true,
    signedIn: () => ({ signedIn: c.token !== null, email: c.token ? 'a@b.c' : undefined }),
    takeRotatedRefreshToken: () => { const r = c.rotated; c.rotated = null; return r; },
    setRefreshToken: (t: string | null) => { c.token = t; },
    startSignin: async () => ({ device_code: 'dc', user_code: 'ABCD-EFGH', verification_url: 'https://brain.test/device?code=ABCD-EFGH', expires_in: 600, interval: 2 }),
    pollSignin: async () => ({ status: 'approved' as const, refresh_token: 'rt', email: 'a@b.c' }),
    openSession: async () => ({ ok: false as const, reason: 'capacity', message: 'busy' }),
  };
  return c;
}
async function serve(c: BrainConnector, opts: { redactJson?: boolean } = {}) {
  const app = express();
  // The real dashboard app redacts every JSON response (see dashboard/server.ts).
  if (opts.redactJson) installExpressJsonRedaction(app);
  app.use(express.json()); registerBrainRoutes(app, c);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => server.close() };
}

/** Raw request so the test controls Host/Origin (fetch forbids setting Host). */
function rawGet(base: string, path: string, headers: Record<string, string>): Promise<number> {
  const { hostname, port } = new URL(base);
  return new Promise((resolve, reject) => {
    const req = request({ hostname, port, path, method: 'GET', headers }, (res) => { res.resume(); resolve(res.statusCode ?? 0); });
    req.on('error', reject);
    req.end();
  });
}

describe('brain routes', () => {
  it('runs device sign-in start/poll and stores the refresh token in memory only', async () => {
    const c = fakeConnector(); const s = await serve(c);
    const start = await (await fetch(`${s.base}/brain/signin/start`, { method: 'POST' })).json();
    expect(start).toMatchObject({ user_code: 'ABCD-EFGH' });
    const poll = await (await fetch(`${s.base}/brain/signin/poll`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ device_code: 'dc' }) })).json();
    expect(poll).toMatchObject({ status: 'approved', refresh_token: 'rt' });
    expect(c.token).toBe('rt');
    const status = await (await fetch(`${s.base}/brain/status`)).json();
    expect(status).toEqual({ configured: true, signed_in: true, email: 'a@b.c' });
    await fetch(`${s.base}/brain/signout`, { method: 'POST' });
    expect(c.token).toBeNull();
    s.close();
  });

  it('accepts a refresh token pushed by the panel and never echoes it', async () => {
    const c = fakeConnector(); const s = await serve(c);
    const res = await (await fetch(`${s.base}/brain/config`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ refresh_token: 'secret-rt' }) })).json();
    expect(JSON.stringify(res)).not.toContain('secret-rt');
    expect(c.token).toBe('secret-rt');
    s.close();
  });

  it('hands the rotated refresh token to the panel exactly once', async () => {
    const c = fakeConnector(); c.token = 'rt'; c.rotated = 'rt2'; const s = await serve(c);
    expect((await (await fetch(`${s.base}/brain/status`)).json()).rotated_refresh_token).toBe('rt2');
    expect((await (await fetch(`${s.base}/brain/status`)).json()).rotated_refresh_token).toBeUndefined();
    s.close();
  });

  it('delivers the refresh token intact on an app that redacts JSON responses', async () => {
    const c = fakeConnector(); c.token = 'rt'; c.rotated = 'rotated-refresh-value'; const s = await serve(c, { redactJson: true });
    const poll = await (await fetch(`${s.base}/brain/signin/poll`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ device_code: 'dc' }) })).json();
    expect(poll.refresh_token).toBe('rt');
    c.rotated = 'rotated-refresh-value';
    expect((await (await fetch(`${s.base}/brain/status`)).json()).rotated_refresh_token).toBe('rotated-refresh-value');
    s.close();
  });

  it('refuses DNS-rebinding style Host headers and foreign Origins', async () => {
    const c = fakeConnector(); c.token = 'rt'; const s = await serve(c);
    const port = new URL(s.base).port;
    expect(await rawGet(s.base, '/brain/status', { host: 'evil.example:7821' })).toBe(403);
    expect(await rawGet(s.base, '/brain/status', { host: `127.0.0.1:${port}`, origin: 'https://evil.example' })).toBe(403);
    expect(await rawGet(s.base, '/brain/status', { host: `127.0.0.1:${port}`, origin: 'null' })).toBe(403);
    expect(await rawGet(s.base, '/brain/status', { host: `127.0.0.1:${port}` })).toBe(200);
    expect(await rawGet(s.base, '/brain/status', { host: `localhost:${port}`, origin: `http://localhost:${port}` })).toBe(200);
    expect(await rawGet(s.base, '/brain/status', { host: `[::1]:${port}` })).toBe(200);
    s.close();
  });

  it('forwards only status, refresh_token and email from an approved poll', async () => {
    const c = fakeConnector();
    c.pollSignin = async () => ({ status: 'approved', refresh_token: 'rt', email: 'a@b.c', internal: 'x' }) as never;
    const s = await serve(c);
    const poll = await (await fetch(`${s.base}/brain/signin/poll`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ device_code: 'dc' }) })).json();
    expect(poll).toEqual({ status: 'approved', refresh_token: 'rt', email: 'a@b.c' });
    s.close();
  });
});
