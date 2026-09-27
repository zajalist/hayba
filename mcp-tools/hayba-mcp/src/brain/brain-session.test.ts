import { describe, expect, it } from 'vitest';
import { BrainSession, type BrainSessionOptions } from './brain-session.js';
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
    const s = new BrainSession('s-1', { ...baseOpts(sockets), backoffMs: [10, 10, 10], resumeWindowMs: 1 });
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

  it('reports alive while usable and dead after close or give-up', async () => {
    const sockets: FakeSocket[] = [];
    const s = new BrainSession('s-1', baseOpts(sockets));
    const p = s.open(); await tick(); sockets[0].open(); await tick(); sockets[0].push(welcome); await p;
    expect(s.isAlive()).toBe(true);
    s.close();
    expect(s.isAlive()).toBe(false);

    const gaveUp = new BrainSession('s-1', { ...baseOpts(sockets), backoffMs: [10, 10, 10], resumeWindowMs: 1 });
    const p2 = gaveUp.open(); await tick(); sockets[1].open(); await tick(); sockets[1].push(welcome); await p2;
    sockets[1].drop();
    await new Promise((r) => setTimeout(r, 20));
    expect(gaveUp.isAlive()).toBe(false);
  });

  it('delivers a post-welcome pro_unavailable to frames() instead of swallowing it in the handshake handler', async () => {
    const sockets: FakeSocket[] = [];
    const s = new BrainSession('s-1', baseOpts(sockets));
    const p = s.open(); await tick(); sockets[0].open(); await tick(); sockets[0].push(welcome); await p;
    sockets[0].push({ type: 'pro_unavailable', seq: 2, reason: 'maintenance', message: 'restarting' });
    const it = s.frames();
    expect((await it.next()).value).toMatchObject({ type: 'pro_unavailable', reason: 'maintenance' });
  });

  it('drops duplicate inbound frames by seq after replay', async () => {
    const sockets: FakeSocket[] = [];
    const s = new BrainSession('s-1', baseOpts(sockets));
    const p = s.open(); await tick(); sockets[0].open(); await tick(); sockets[0].push(welcome); await p;
    const delta = { type: 'event', seq: 2, event: { type: 'message_delta', activityId: 'a', text: 'x' } };
    sockets[0].push(delta);
    sockets[0].push(delta);
    sockets[0].push({ type: 'done', seq: 3, reason: 'end_turn' });
    const got: string[] = [];
    for await (const f of s.frames()) { got.push(`${f.type}:${f.seq}`); if (f.type === 'done') break; }
    expect(got).toEqual(['event:2', 'done:3']);
  });

  // ── final-review fix wave ────────────────────────────────────────────────
  async function established(opts: Partial<BrainSessionOptions> = {}) {
    const sockets: FakeSocket[] = [];
    const s = new BrainSession('s-1', { ...baseOpts(sockets), ...opts });
    const p = s.open(); await tick(); sockets[0].open(); await tick(); sockets[0].push(welcome); await p;
    return { s, sockets };
  }
  const until = async (cond: () => boolean, ms = 500) => {
    const t0 = Date.now();
    while (!cond()) { if (Date.now() - t0 > ms) throw new Error('timed out'); await tick(); }
  };

  it('R1: a rejected resume (seq 1, below lastInSeq) ends the session and reaches frames()', async () => {
    const { s, sockets } = await established();
    sockets[0].push({ type: 'event', seq: 7, event: { type: 'message_delta', activityId: 'a', text: 'x' } });
    const it = s.frames(); await it.next();
    sockets[0].drop();
    await until(() => sockets.length === 2);
    sockets[1].open(); await tick();
    expect(sockets[1].sent[0]).toMatchObject({ type: 'resume', last_seq: 7 });
    sockets[1].push({ type: 'pro_unavailable', seq: 1, session_id: 'unknown', reason: 'session_expired', message: 'That Pro session has ended.' });
    expect((await it.next()).value).toMatchObject({ type: 'pro_unavailable', reason: 'session_expired' });
    expect((await it.next()).done).toBe(true);
    expect(s.isAlive()).toBe(false);
    await new Promise((r) => setTimeout(r, 20));
    expect(sockets).toHaveLength(2); // no reconnect storm
  });

  it('R1: an upgrade_required answer to a resume ends the session the same way', async () => {
    const { s, sockets } = await established();
    sockets[0].drop();
    await until(() => sockets.length === 2);
    sockets[1].open(); await tick();
    sockets[1].push({ type: 'upgrade_required', seq: 1, min_version: 2, download_url: 'https://example.com/dl' });
    const got: string[] = [];
    for await (const f of s.frames()) got.push(f.type);
    expect(got).toEqual(['upgrade_required']);
    expect(s.isAlive()).toBe(false);
  });

  it('R1: an opened-but-never-acked reconnect does not reset the give-up clock', async () => {
    const { s, sockets } = await established({ backoffMs: [2], resumeWindowMs: 60 });
    sockets[0].drop();
    // Every reconnect opens, then the brain closes it without ever acking.
    const t0 = Date.now();
    while (s.isAlive() && Date.now() - t0 < 1000) {
      const last = sockets.at(-1)!;
      if (last.readyState === 0) { last.open(); await tick(); last.drop(); }
      await tick();
    }
    expect(s.isAlive()).toBe(false);
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  it('R1: a reconnect socket stuck connecting times out and counts toward give-up', async () => {
    const { s, sockets } = await established({ backoffMs: [1], resumeWindowMs: 40, connectTimeoutMs: 5 });
    sockets[0].drop();
    await until(() => !s.isAlive(), 1000); // sockets never open; old code hung here forever
    expect(sockets.length).toBeGreaterThan(1);
  });

  it('R1: a resume ACK (welcome resumed:true) re-arms backoff and keeps the session alive', async () => {
    const { s, sockets } = await established({ backoffMs: [2], resumeWindowMs: 60 });
    sockets[0].drop();
    await until(() => sockets.length === 2);
    sockets[1].open(); await tick();
    sockets[1].push({ ...welcome, seq: 2, resumed: true });
    await new Promise((r) => setTimeout(r, 80)); // past the resume window: must not give up now
    expect(s.isAlive()).toBe(true);
  });

  it('R4: re-sends tool_results for an unfinished turn after an ACKed resume, and stops after done', async () => {
    const { s, sockets } = await established();
    sockets[0].push({ type: 'tool_call', seq: 2, id: 't-1', name: 'world_inspect', args: {}, gated: false });
    const it = s.frames(); await it.next();
    s.send({ type: 'tool_result', id: 't-1', ok: true, result: 1 }); // written to the (dying) socket
    expect(sockets[0].sent.at(-1)).toMatchObject({ type: 'tool_result', id: 't-1' });
    sockets[0].drop();
    await until(() => sockets.length === 2);
    sockets[1].open(); await tick();
    expect(sockets[1].sent.some((m) => m.type === 'tool_result')).toBe(false); // not before the ACK
    sockets[1].push({ ...welcome, seq: 3, resumed: true });
    await tick();
    expect(sockets[1].sent.filter((m) => m.type === 'tool_result' && m.id === 't-1')).toHaveLength(1);
    // Once the turn reaches done nothing is retained.
    sockets[1].push({ type: 'done', seq: 4, reason: 'end_turn' });
    await it.next();
    sockets[1].drop();
    await until(() => sockets.length === 3);
    sockets[2].open(); await tick();
    sockets[2].push({ ...welcome, seq: 5, resumed: true });
    await tick();
    expect(sockets[2].sent.some((m) => m.type === 'tool_result')).toBe(false);
  });

  it('R4: pings the brain on an interval while connected and never surfaces inbound pings', async () => {
    const { s, sockets } = await established({ pingIntervalMs: 5 });
    await until(() => sockets[0].sent.some((m) => m.type === 'ping'));
    sockets[0].push({ type: 'ping', seq: 2 });
    sockets[0].push({ type: 'done', seq: 3, reason: 'end_turn' });
    const got: string[] = [];
    for await (const f of s.frames()) { got.push(f.type); if (f.type === 'done') break; }
    expect(got).toEqual(['done']);
    s.close();
    const sent = sockets[0].sent.length;
    await new Promise((r) => setTimeout(r, 20));
    expect(sockets[0].sent.length).toBe(sent); // pinging stops with the session
  });

  it('never delivers welcome frames to frames(), even a stray ACK replayed after two drops', async () => {
    const { s, sockets } = await established();
    sockets[0].push({ type: 'event', seq: 2, event: { type: 'message_delta', activityId: 'a', text: 'x' } });
    const it = s.frames(); await it.next();
    sockets[0].drop();
    await until(() => sockets.length === 2);
    sockets[1].open(); await tick();
    // The brain ACKs this resume (seq 3), but the socket dies before the ACK arrives.
    sockets[1].drop();
    await until(() => sockets.length === 3);
    sockets[2].open(); await tick();
    // The next resume replays the lost ACK before the real one.
    sockets[2].push({ ...welcome, seq: 3, resumed: true });
    sockets[2].push({ ...welcome, seq: 4, resumed: true });
    sockets[2].push({ type: 'done', seq: 5, reason: 'end_turn' });
    expect((await it.next()).value).toMatchObject({ type: 'done', seq: 5 });
    expect(s.isAlive()).toBe(true);
  });

  it('close() resolves only once the socket has actually closed', async () => {
    const { s, sockets } = await established();
    sockets[0].deferClose = true;
    let settled = false;
    const closing = s.close().then(() => { settled = true; });
    expect(s.isAlive()).toBe(false);
    await new Promise((r) => setTimeout(r, 20));
    expect(settled).toBe(false);
    sockets[0].finishClose();
    await closing;
    expect(settled).toBe(true);
  });

  it('close() gives up waiting for the close event after closeTimeoutMs', async () => {
    const { s, sockets } = await established({ closeTimeoutMs: 10 });
    sockets[0].deferClose = true;
    const t0 = Date.now();
    await s.close();
    expect(Date.now() - t0).toBeGreaterThanOrEqual(5);
    expect(sockets[0].readyState).toBe(2); // still closing; we stopped waiting
  });

  it('close() on an already-closed socket resolves at once', async () => {
    const { s, sockets } = await established({ closeTimeoutMs: 10_000 });
    await s.close();
    sockets[0].deferClose = true;
    await s.close(); // would hang 10 s if it waited on a socket that is already gone
  });

  it('ignores frames from a socket that has been replaced', async () => {
    const { s, sockets } = await established();
    sockets[0].drop();
    await until(() => sockets.length === 2);
    sockets[1].open(); await tick();
    sockets[1].push({ ...welcome, seq: 2, resumed: true });
    sockets[0].push({ type: 'done', seq: 50, reason: 'stale' });
    sockets[1].push({ type: 'done', seq: 3, reason: 'end_turn' });
    const it = s.frames();
    expect((await it.next()).value).toMatchObject({ type: 'done', reason: 'end_turn' });
  });
});
