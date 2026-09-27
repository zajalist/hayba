import { describe, expect, it } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
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
});
