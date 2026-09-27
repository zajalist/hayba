import { describe, expect, it } from 'vitest';
import { BrainSession } from './brain-session.js';
import { FakeSocket, baseOpts } from './fake-socket.test-helpers.js';

const welcome = { type: 'welcome', seq: 1, limits: { max_steps: 40, max_tokens: 400000, wall_clock_ms: 1800000 }, protocol_range: [1, 1], resumed: false };
const tick = () => new Promise((r) => setTimeout(r, 5));

describe('BrainSession', () => {
  it('sends hello with the access token and resolves on welcome', async () => {
    const sockets: FakeSocket[] = [];
    const s = new BrainSession('s-1', baseOpts(sockets));
    const p = s.open();
    await tick(); sockets[0].open(); await tick();
    expect(sockets[0].sent[0]).toMatchObject({ type: 'hello', access_token: 'jwt', v: 1, seq: 1, session_id: 's-1' });
    sockets[0].push(welcome);
    expect(await p).toMatchObject({ ok: true });
  });

  it('maps pro_unavailable to a failed open', async () => {
    const sockets: FakeSocket[] = [];
    const s = new BrainSession('s-1', baseOpts(sockets));
    const p = s.open();
    await tick(); sockets[0].open(); await tick();
    sockets[0].push({ type: 'pro_unavailable', seq: 1, reason: 'capacity', message: 'busy' });
    expect(await p).toEqual({ ok: false, reason: 'capacity', message: 'busy' });
  });

  it('reports unreachable when the socket never opens', async () => {
    const sockets: FakeSocket[] = [];
    const s = new BrainSession('s-1', baseOpts(sockets));
    expect(await s.open()).toMatchObject({ ok: false, reason: 'unreachable' });
  });

  it('buffers tool_result while disconnected and resumes with last_seq', async () => {
    const sockets: FakeSocket[] = [];
    const s = new BrainSession('s-1', baseOpts(sockets));
    const p = s.open(); await tick(); sockets[0].open(); await tick(); sockets[0].push(welcome); await p;
    sockets[0].push({ type: 'tool_call', seq: 2, id: 't-1', name: 'world_inspect', args: {}, gated: false });
    const it = s.frames(); await it.next();
    sockets[0].drop();
    s.send({ type: 'tool_result', id: 't-1', ok: true, result: 1 });
    await tick(); await tick();
    const s2 = sockets[1];
    s2.open(); await tick();
    expect(s2.sent[0]).toMatchObject({ type: 'resume', last_seq: 2, access_token: 'jwt' });
    expect(s2.sent[1]).toMatchObject({ type: 'tool_result', id: 't-1' });
    expect((s2.sent[1].seq as number)).toBeGreaterThan(s2.sent[0].seq as number);
  });

  it('retries token refresh failures during reconnect and recovers once the token succeeds', async () => {
    const sockets: FakeSocket[] = [];
    let calls = 0;
    const getAccessToken = async () => {
      calls += 1;
      if (calls === 2) throw new Error('token refresh failed'); // first reconnect attempt
      return 'jwt';
    };
    const s = new BrainSession('s-1', { ...baseOpts(sockets), getAccessToken, backoffMs: [1, 1, 1] });
    const p = s.open(); await tick(); sockets[0].open(); await tick(); sockets[0].push(welcome); await p;
    sockets[0].drop();
    // Give both the failing and the recovering reconnect attempts time to run; no
    // unhandled rejection should escape (vitest would fail the test on one), and a
    // second socket must eventually appear despite the first token refresh failing.
    await new Promise((r) => setTimeout(r, 30));
    expect(calls).toBeGreaterThanOrEqual(3);
    expect(sockets.length).toBe(2);
    sockets[1].open(); await tick();
    expect(sockets[1].sent[0]).toMatchObject({ type: 'resume' });
  });

  it('gives up and delivers a synthetic pro_unavailable once the resume window elapses', async () => {
    const sockets: FakeSocket[] = [];
    const s = new BrainSession('s-1', { ...baseOpts(sockets), backoffMs: [1, 1, 1], resumeWindowMs: 1 });
    const p = s.open(); await tick(); sockets[0].open(); await tick(); sockets[0].push(welcome); await p;
    sockets[0].drop();
    // Give the 1ms resume window time to elapse before the (1ms-delayed) reconnect attempt fires.
    await new Promise((r) => setTimeout(r, 20));
    const got: string[] = [];
    for await (const f of s.frames()) { got.push(f.type); }
    expect(got).toEqual(['pro_unavailable']);
    expect(sockets.length).toBe(1); // never reconnected
  });

  it('a fresh (non-resumed) welcome clears turn-discard mode', async () => {
    const sockets: FakeSocket[] = [];
    const s = new BrainSession('s-1', baseOpts(sockets));
    const p = s.open(); await tick(); sockets[0].open(); await tick(); sockets[0].push(welcome); await p;
    s.cancelTurn();
    sockets[0].push({ type: 'tool_call', seq: 2, id: 't-1', name: 'world_inspect', args: {}, gated: false });
    await tick();
    expect(sockets[0].sent.find((m) => m.id === 't-1')).toMatchObject({ ok: false, result: { error: 'cancelled' } });
    // A brand-new (non-resumed) welcome means old discard state is stale; a tool_call after it must flow through.
    sockets[0].push({ type: 'welcome', seq: 3, limits: { max_steps: 40, max_tokens: 1, wall_clock_ms: 1 }, protocol_range: [1, 1], resumed: false });
    sockets[0].push({ type: 'tool_call', seq: 4, id: 't-2', name: 'world_inspect', args: {}, gated: false });
    const got: Array<{ type: string }> = [];
    for await (const f of s.frames()) { got.push(f); if (f.type === 'tool_call') break; }
    expect(got.at(-1)).toMatchObject({ type: 'tool_call', id: 't-2' });
  });

  it('turn-discard mode auto-clears after discardTimeoutMs if done never arrives', async () => {
    const sockets: FakeSocket[] = [];
    const s = new BrainSession('s-1', { ...baseOpts(sockets), discardTimeoutMs: 5 });
    const p = s.open(); await tick(); sockets[0].open(); await tick(); sockets[0].push(welcome); await p;
    s.cancelTurn();
    await new Promise((r) => setTimeout(r, 20)); // let the 5ms safety-net timer fire
    sockets[0].push({ type: 'tool_call', seq: 2, id: 't-1', name: 'world_inspect', args: {}, gated: false });
    const got: Array<{ type: string }> = [];
    for await (const f of s.frames()) { got.push(f); if (f.type === 'tool_call') break; }
    expect(got.at(-1)).toMatchObject({ type: 'tool_call', id: 't-1' });
  });

  it('drops duplicate inbound frames by seq after replay', async () => {
    const sockets: FakeSocket[] = [];
    const s = new BrainSession('s-1', baseOpts(sockets));
    const p = s.open(); await tick(); sockets[0].open(); await tick(); sockets[0].push(welcome); await p;
    sockets[0].push({ type: 'ping', seq: 2 });
    sockets[0].push({ type: 'ping', seq: 2 });
    sockets[0].push({ type: 'done', seq: 3, reason: 'end_turn' });
    const got: string[] = [];
    for await (const f of s.frames()) { got.push(`${f.type}:${f.seq}`); if (f.type === 'done') break; }
    expect(got).toEqual(['ping:2', 'done:3']);
  });
});
