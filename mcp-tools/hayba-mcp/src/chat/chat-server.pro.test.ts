import { afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { argsHash } from '@hayba/brain-protocol';
import { registerChatRoutes, __resetChatState } from './chat-server.js';
import { temporarySessionStore } from './session-store.test-helpers.js';
import type { LLMClient, LLMResponse } from '../agents/llm-client.js';
import { createBrainConnector, type BrainConnector } from '../brain/brain-connector.js';
import type { BrainSession, SocketLike } from '../brain/brain-session.js';
import { FakeSocket } from '../brain/fake-socket.test-helpers.js';

const TOOL = 'zz_thing_delete';
const ARGS = { path: '/Game/Thing' };
const H = argsHash(ARGS);

/**
 * A scripted brain behind FakeSockets: answers every `hello` with `welcome`
 * and lets the test push per-socket frames with a monotonically rising seq.
 */
class FakeBrain {
  sockets: FakeSocket[] = [];
  private seq = new Map<FakeSocket, number>();
  get sock(): FakeSocket { return this.sockets[this.sockets.length - 1]; }
  factory = (): SocketLike => {
    const s = new FakeSocket();
    this.sockets.push(s);
    const send = s.send.bind(s);
    s.send = (d: string) => {
      send(d);
      if ((JSON.parse(d) as { type?: string }).type === 'hello') {
        setTimeout(() => this.push({ type: 'welcome', limits: { max_steps: 40, max_tokens: 1, wall_clock_ms: 1 }, protocol_range: [1, 1], resumed: false }, s));
      }
    };
    setTimeout(() => s.open(), 0);
    return s;
  };
  push(frame: Record<string, unknown>, sock: FakeSocket = this.sock): void {
    const seq = (this.seq.get(sock) ?? 0) + 1;
    this.seq.set(sock, seq);
    sock.push({ seq, ...frame });
  }
  /** Ends the current turn the way the protocol ruling requires: an outcome, then exactly one `done`. */
  finishTurn(activityId: string): void {
    this.push({ type: 'event', event: { type: 'activity_completed', activityId, outcome: 'succeeded', reason: 'end_turn' } });
    this.push({ type: 'done', reason: 'end_turn' });
  }
  sentTypes(sock: FakeSocket = this.sock): string[] { return sock.sent.map((f) => f.type as string); }
}

function brainConnector(brain: FakeBrain): BrainConnector & { opened: BrainSession[] } {
  const inner = createBrainConnector({
    brainUrl: 'ws://brain.test',
    clientVersion: 'test',
    socketFactory: brain.factory,
    fetchImpl: (async () => new Response(JSON.stringify({ access_token: 'jwt', refresh_token: 'rt', expires_in: 3600 }))) as typeof fetch,
  });
  inner.setRefreshToken('rt', 'a@b.c');
  const opened: BrainSession[] = [];
  return {
    ...inner,
    opened,
    async openSession(...args) {
      const r = await inner.openSession(...args);
      if (r.ok) opened.push(r.session);
      return r;
    },
  };
}

type SseFrame = { event: string; data: Record<string, unknown> };
function parseSse(text: string): SseFrame[] {
  return text.split('\n\n').flatMap((block) => {
    const event = /^event: (.*)$/m.exec(block)?.[1];
    const data = /^data: (.*)$/m.exec(block)?.[1];
    return event && data ? [{ event, data: JSON.parse(data) as Record<string, unknown> }] : [];
  });
}
async function waitFor(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 5));
  expect(cond()).toBe(true);
}

describe('chat server Pro loop', () => {
  let server: Server;
  let base: string;
  afterEach(() => {
    server?.close();
    __resetChatState();
  });

  function start(brain: BrainConnector, dispatchTool = vi.fn(async () => ({ ok: true })), client?: LLMClient) {
    const app = express();
    app.use(express.json());
    registerChatRoutes(app, {
      brain,
      ...(client ? { createClient: () => client } : {}),
      sessionStore: temporarySessionStore(),
      tools: [{ name: TOOL, description: '', input_schema: { type: 'object', properties: {} } }],
      dispatchTool,
    });
    server = app.listen(0);
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    return dispatchTool;
  }
  async function stream(body: Record<string, unknown>) {
    const res = await fetch(`${base}/chat/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { sessionId: res.headers.get('x-hayba-session-id') as string, frames: res.text().then(parseSse) };
  }
  const post = (path: string, body: unknown) =>
    fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  /** Runs a first Pro turn that the brain parks at an approval request for TOOL/ARGS. */
  async function parkAtApproval(brain: FakeBrain) {
    const s1 = await stream({ prompt: 'delete the thing', loop: 'pro' });
    await waitFor(() => brain.sockets.length === 1 && brain.sentTypes().includes('turn'));
    brain.push({ type: 'event', event: { type: 'activity_started', activityId: 'a1', title: 'Delete thing' } });
    brain.push({ type: 'event', event: { type: 'approval_requested', activityId: 'a1', approvalId: 'p1', call: { id: 'c1', name: TOOL, input: ARGS }, argsHash: H, source: 'ts' } });
    const frames = await s1.frames;
    expect(frames.at(-1)).toMatchObject({ event: 'done', data: { reason: 'plan_request' } });
    return s1.sessionId;
  }

  it('pro unavailable emits a single brain_unavailable error then done', async () => {
    const connector: BrainConnector = {
      configured: () => true,
      signedIn: () => ({ signedIn: true }),
      takeRotatedRefreshToken: () => null,
      setRefreshToken: () => {},
      startSignin: async () => { throw new Error('unused'); },
      pollSignin: async () => { throw new Error('unused'); },
      openSession: async () => ({ ok: false, reason: 'capacity', message: 'busy' }),
    };
    start(connector);
    const { frames } = await stream({ prompt: 'hi', loop: 'pro' });
    const got = await frames;
    const errors = got.filter((f) => f.event === 'error');
    expect(errors).toEqual([{ event: 'error', data: { error: 'busy', kind: 'brain_unavailable', reason: 'capacity' } }]);
    expect(got.at(-1)).toMatchObject({ event: 'done', data: { reason: 'brain_unavailable' } });
    expect(got.indexOf(errors[0])).toBeLessThan(got.length - 1);
  });

  it('rejects an unknown loop value', async () => {
    start(brainConnector(new FakeBrain()));
    const res = await post('/chat/stream', { prompt: 'hi', loop: 'turbo' });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid loop' });
  });

  it('approve resumes the remote session instead of starting a new turn', async () => {
    const brain = new FakeBrain();
    const connector = brainConnector(brain);
    const dispatchTool = start(connector);
    const sessionId = await parkAtApproval(brain);

    const approved = await post('/chat/approve', { session_id: sessionId });
    expect(approved.status).toBe(200);

    const s2 = await stream({ session_id: sessionId, prompt: '', loop: 'pro' });
    await waitFor(() => brain.sentTypes().includes('approve'));
    expect(brain.sock.sent.find((f) => f.type === 'approve')).toMatchObject({ type: 'approve', name: TOOL, args_hash: H });
    brain.push({ type: 'tool_call', id: 't1', name: TOOL, args: ARGS, gated: true });
    await waitFor(() => dispatchTool.mock.calls.length === 1);
    expect(dispatchTool).toHaveBeenCalledWith(TOOL, ARGS);
    brain.finishTurn('a1');
    const frames = await s2.frames;
    expect(frames.at(-1)).toMatchObject({ event: 'done', data: { reason: 'end_turn' } });

    expect(brain.sentTypes().filter((t) => t === 'turn')).toHaveLength(1);
    expect(connector.opened).toHaveLength(1);
  });

  it('cancels a parked (declined) brain turn before starting a new one', async () => {
    const brain = new FakeBrain();
    const connector = brainConnector(brain);
    start(connector);
    const sessionId = await parkAtApproval(brain);

    // No /chat/approve: the user moved on with a new prompt.
    const s2 = await stream({ session_id: sessionId, prompt: 'never mind, list things instead', loop: 'pro' });
    await waitFor(() => brain.sentTypes().filter((t) => t === 'turn').length === 2);
    expect(brain.sentTypes()).toEqual(['hello', 'turn', 'cancel', 'turn']);

    // The brain closes out the cancelled turn, then answers the new one.
    brain.push({ type: 'event', event: { type: 'message_delta', activityId: 'a1', text: 'stale' } });
    brain.push({ type: 'event', event: { type: 'activity_completed', activityId: 'a1', outcome: 'cancelled', reason: 'aborted' } });
    brain.push({ type: 'done', reason: 'aborted' });
    brain.push({ type: 'event', event: { type: 'message_delta', activityId: 'b1', text: 'fresh' } });
    brain.finishTurn('b1');

    const frames = await s2.frames;
    const text = frames.filter((f) => f.event === 'text_delta').map((f) => f.data.text).join('');
    expect(text).toBe('fresh');
    expect(frames.at(-1)).toMatchObject({ event: 'done', data: { reason: 'end_turn', cancelled: false } });
    expect(connector.opened).toHaveLength(1);
    // The declined plan is gone: there is nothing left to approve.
    expect((await post('/chat/approve', { session_id: sessionId })).status).toBe(409);
  });

  it('opens a fresh brain session when the previous one has died', async () => {
    const brain = new FakeBrain();
    const connector = brainConnector(brain);
    start(connector);
    const s1 = await stream({ prompt: 'first', loop: 'pro' });
    await waitFor(() => brain.sentTypes().includes('turn'));
    brain.finishTurn('a1');
    await s1.frames;

    connector.opened[0].close(); // e.g. gave up after its resume window

    const s2 = await stream({ session_id: s1.sessionId, prompt: 'second', loop: 'pro' });
    await waitFor(() => brain.sockets.length === 2 && brain.sentTypes().includes('turn'));
    brain.finishTurn('a2');
    const frames = await s2.frames;
    expect(frames.at(-1)).toMatchObject({ event: 'done', data: { reason: 'end_turn' } });
    expect(connector.opened).toHaveLength(2);
    expect(brain.sentTypes(brain.sockets[0]).filter((t) => t === 'turn')).toHaveLength(1);
  });

  it('never sends a Community approval to the brain, and cancels the parked Pro turn when Community runs', async () => {
    const brain = new FakeBrain();
    const connector = brainConnector(brain);
    // Community model: asks to run the same destructive tool on DIFFERENT args, so it parks too.
    const otherArgs = { path: '/Game/Other' };
    const response: LLMResponse = { content: '', toolCalls: [{ id: 'c2', name: TOOL, input: otherArgs }], stopReason: 'tool_use' };
    const client: LLMClient = {
      provider: 'mock', model: 'fake', protocol: 'anthropic',
      complete: async () => response,
      async *stream() { yield { type: 'done', response }; },
    };
    const dispatchTool = start(connector, vi.fn(async () => ({ ok: true })), client);
    const sessionId = await parkAtApproval(brain); // Pro parks P

    // Community turn parks C; starting it closes out the brain's parked turn.
    const c = await stream({ session_id: sessionId, prompt: 'use the local loop', loop: 'community' });
    const cFrames = await c.frames;
    expect(cFrames.find((f) => f.event === 'plan_request')).toMatchObject({ data: { name: TOOL, args_hash: argsHash(otherArgs) } });
    expect(brain.sentTypes()).toEqual(['hello', 'turn', 'cancel']);
    brain.push({ type: 'done', reason: 'aborted' }); // the brain closes out P

    expect((await post('/chat/approve', { session_id: sessionId })).status).toBe(200); // approves C

    // The next Pro turn must NOT send approve{C}; it starts a fresh turn.
    const p2 = await stream({ session_id: sessionId, prompt: 'back to pro', loop: 'pro' });
    await waitFor(() => brain.sentTypes().filter((t) => t === 'turn').length === 2);
    expect(brain.sentTypes()).toEqual(['hello', 'turn', 'cancel', 'turn']);
    brain.finishTurn('b1');
    expect((await p2.frames).at(-1)).toMatchObject({ event: 'done', data: { reason: 'end_turn' } });
    expect(dispatchTool).not.toHaveBeenCalled();
  });

  it('a mid-turn pro_unavailable ends the turn with one brain_unavailable error, then reopens next time', async () => {
    const brain = new FakeBrain();
    const connector = brainConnector(brain);
    start(connector);
    const s1 = await stream({ prompt: 'hi', loop: 'pro' });
    await waitFor(() => brain.sentTypes().includes('turn'));
    brain.push({ type: 'pro_unavailable', reason: 'maintenance', message: 'Hayba Pro is restarting.' });
    const frames = await s1.frames;
    // Legacy error frames carry no semantic `type`; the semantic stream mirrors it separately.
    const legacyErrors = frames.filter((f) => f.event === 'error' && f.data.type === undefined);
    expect(legacyErrors).toEqual([{ event: 'error', data: { error: 'Hayba Pro is restarting.', kind: 'brain_unavailable', reason: 'maintenance' } }]);
    expect(frames.at(-1)).toMatchObject({ event: 'done', data: { reason: 'brain_unavailable' } });

    const s2 = await stream({ session_id: s1.sessionId, prompt: 'again', loop: 'pro' });
    await waitFor(() => brain.sockets.length === 2 && brain.sentTypes().includes('turn'));
    brain.finishTurn('a2');
    await s2.frames;
    expect(connector.opened).toHaveLength(2);
  });

  it('R9: closes the least-recently-used idle Pro session when a third Pro chat starts', async () => {
    const brain = new FakeBrain();
    const connector = brainConnector(brain);
    start(connector);
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const s = await stream({ prompt: `chat ${i}`, loop: 'pro' });
      await waitFor(() => brain.sockets.length === i + 1 && brain.sentTypes().includes('turn'));
      brain.finishTurn(`a${i}`);
      await s.frames;
      ids.push(s.sessionId);
      await new Promise((r) => setTimeout(r, 5)); // distinct lastActivity stamps
    }
    expect(connector.opened.map((b) => b.isAlive())).toEqual([false, true, true]);
    expect(new Set(ids).size).toBe(3);
  });

  it('R9: waits for the evicted Pro socket to finish closing before sending the next hello', async () => {
    const brain = new FakeBrain();
    const connector = brainConnector(brain);
    start(connector);
    for (let i = 0; i < 2; i++) {
      const s = await stream({ prompt: `chat ${i}`, loop: 'pro' });
      await waitFor(() => brain.sockets.length === i + 1 && brain.sentTypes().includes('turn'));
      brain.finishTurn(`a${i}`);
      await s.frames;
      await new Promise((r) => setTimeout(r, 5));
    }
    const lru = brain.sockets[0];
    lru.deferClose = true;
    const third = await stream({ prompt: 'chat 2', loop: 'pro' });
    await waitFor(() => lru.readyState === 2); // eviction started
    await new Promise((r) => setTimeout(r, 30));
    expect(brain.sockets).toHaveLength(2); // no hello while the brain may still count the old session
    lru.finishClose();
    await waitFor(() => brain.sockets.length === 3 && brain.sentTypes().includes('turn'));
    expect(brain.sentTypes()[0]).toBe('hello');
    brain.finishTurn('a2');
    await third.frames;
  });

  it('R9: closes the brain session of a deleted chat', async () => {
    const brain = new FakeBrain();
    const connector = brainConnector(brain);
    start(connector);
    const s = await stream({ prompt: 'hi', loop: 'pro' });
    await waitFor(() => brain.sentTypes().includes('turn'));
    brain.finishTurn('a1');
    await s.frames;
    const res = await fetch(`${base}/chat/sessions/${s.sessionId}`, { method: 'DELETE' });
    expect(res.status).toBe(204);
    expect(connector.opened[0].isAlive()).toBe(false);
  });
});
