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
});
