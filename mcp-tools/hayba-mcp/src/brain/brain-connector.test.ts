import { describe, expect, it } from 'vitest';
import { createBrainConnector } from './brain-connector.js';
import { FakeSocket } from './fake-socket.test-helpers.js';

const permissions = { 'tools.execute': true, 'facts.vision': false, 'facts.scene': false, python_run: false };

describe('createBrainConnector', () => {
  it('reports not_configured without a brain URL and auth before sign-in', async () => {
    const off = createBrainConnector({ brainUrl: '', clientVersion: 't' });
    expect(off.configured()).toBe(false);
    expect(await off.openSession('s', { mode: 'subscription' }, [], permissions)).toMatchObject({ ok: false, reason: 'not_configured' });
    const on = createBrainConnector({ brainUrl: 'wss://brain.test', clientVersion: 't' });
    expect(await on.openSession('s', { mode: 'subscription' }, [], permissions)).toMatchObject({ ok: false, reason: 'auth' });
  });

  it('refreshes over https, opens the ws session, and surfaces a rotated refresh token once', async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const fetchImpl = (async (url: string, init: { body: string }) => {
      calls.push({ url, body: JSON.parse(init.body) });
      return new Response(JSON.stringify({ access_token: 'jwt', refresh_token: 'rt2', expires_in: 3600 }));
    }) as unknown as typeof fetch;
    const urls: string[] = [];
    const socketFactory = (url: string) => {
      urls.push(url);
      const s = new FakeSocket();
      const send = s.send.bind(s);
      s.send = (d: string) => {
        send(d);
        setTimeout(() => s.push({ type: 'welcome', seq: 1, limits: { max_steps: 40, max_tokens: 1, wall_clock_ms: 1 }, protocol_range: [1, 1], resumed: false }));
      };
      setTimeout(() => s.open());
      return s;
    };
    const c = createBrainConnector({ brainUrl: 'wss://brain.test/', clientVersion: 't', fetchImpl, socketFactory });
    c.setRefreshToken('rt1', 'a@b.c');
    const r = await c.openSession('s', { mode: 'subscription' }, [], permissions);
    expect(r.ok).toBe(true);
    expect(calls).toEqual([{ url: 'https://brain.test/auth/refresh', body: { refresh_token: 'rt1' } }]);
    expect(urls).toEqual(['wss://brain.test/v1/session']);
    expect(c.takeRotatedRefreshToken()).toBe('rt2');
    expect(c.takeRotatedRefreshToken()).toBeNull();
    expect(c.signedIn()).toEqual({ signedIn: true, email: 'a@b.c' });
    if (r.ok) r.session.close();
  });

  it('maps a 401 from /auth/refresh to reason auth with a sign-in-again message', async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ error: 'refresh failed' }), { status: 401 })) as unknown as typeof fetch;
    const c = createBrainConnector({ brainUrl: 'wss://brain.test', clientVersion: 't', fetchImpl, socketFactory: () => new FakeSocket() });
    c.setRefreshToken('revoked');
    expect(await c.openSession('s', { mode: 'subscription' }, [], permissions)).toEqual({ ok: false, reason: 'auth', message: 'Sign in to Hayba Pro again' });
  });

  it('shares one in-flight refresh between concurrent callers (refresh tokens rotate)', async () => {
    let refreshes = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const fetchImpl = (async () => {
      refreshes += 1;
      await gate;
      return new Response(JSON.stringify({ access_token: 'jwt', refresh_token: 'rt2', expires_in: 3600 }));
    }) as unknown as typeof fetch;
    const socketFactory = () => {
      const s = new FakeSocket();
      const send = s.send.bind(s);
      s.send = (d: string) => { send(d); setTimeout(() => s.push({ type: 'welcome', seq: 1, limits: { max_steps: 40, max_tokens: 1, wall_clock_ms: 1 }, protocol_range: [1, 1], resumed: false })); };
      setTimeout(() => s.open());
      return s;
    };
    const c = createBrainConnector({ brainUrl: 'wss://brain.test', clientVersion: 't', fetchImpl, socketFactory });
    c.setRefreshToken('rt1');
    const both = Promise.all([c.openSession('a', { mode: 'subscription' }, [], permissions), c.openSession('b', { mode: 'subscription' }, [], permissions)]);
    await new Promise((r) => setTimeout(r, 10));
    release();
    const [a, b] = await both;
    expect(a.ok && b.ok).toBe(true);
    expect(refreshes).toBe(1);
    for (const r of [a, b]) if (r.ok) r.session.close();
  });
});
