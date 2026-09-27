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
