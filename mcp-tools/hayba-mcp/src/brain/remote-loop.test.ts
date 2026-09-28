import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { argsHash } from '@hayba/brain-protocol';
import { BrainSession } from './brain-session.js';
import { LocalApprovals } from './local-approvals.js';
import { runRemoteLoop } from './remote-loop.js';
import { FakeSocket, baseOpts } from './fake-socket.test-helpers.js';

const tick = () => new Promise((r) => setTimeout(r, 5));
async function connected() {
  const sockets: FakeSocket[] = [];
  const session = new BrainSession('s-1', baseOpts(sockets));
  const p = session.open(); await tick(); sockets[0].open(); await tick();
  sockets[0].push({ type: 'welcome', seq: 1, limits: { max_steps: 40, max_tokens: 1, wall_clock_ms: 1 }, protocol_range: [1, 1], resumed: false });
  await p;
  return { session, sock: sockets[0] };
}
const guard = {
  manifest: new Set(['world_inspect', 'asset_delete']),
  permissions: { 'tools.execute': true, 'facts.vision': false, 'facts.scene': false, python_run: false },
  rawShape: () => undefined,
};
async function drain(gen: AsyncGenerator<unknown>) { const out: unknown[] = []; for await (const e of gen) out.push(e); return out; }

describe('runRemoteLoop', () => {
  it('sends a turn, relays events and runs allowed tool calls locally', async () => {
    const { session, sock } = await connected();
    const dispatchTool = vi.fn(async () => ({ actors: 3 }));
    const run = drain(runRemoteLoop({ session, messages: [{ role: 'user', content: 'hi' }], mode: 'production', approvals: new LocalApprovals(), dispatchTool, guard, signal: new AbortController().signal }));
    await tick();
    expect(sock.sent.at(-1)).toMatchObject({ type: 'turn', mode: 'production' });
    sock.push({ type: 'event', seq: 2, event: { type: 'message_delta', activityId: 'a', text: 'hi' } });
    sock.push({ type: 'tool_call', seq: 3, id: 't-1', name: 'world_inspect', args: {}, gated: false });
    await tick();
    expect(dispatchTool).toHaveBeenCalledWith('world_inspect', {});
    expect(sock.sent.at(-1)).toMatchObject({ type: 'tool_result', id: 't-1', ok: true, result: { actors: 3 } });
    sock.push({ type: 'event', seq: 4, event: { type: 'activity_completed', activityId: 'a', outcome: 'succeeded', reason: 'end_turn' } });
    sock.push({ type: 'done', seq: 5, reason: 'end_turn' });
    const events = await run;
    expect(events).toHaveLength(2);
  });

  it('waits for done after the outcome, then a second turn on the same session sees only its own frames', async () => {
    const { session, sock } = await connected();
    const run1 = drain(runRemoteLoop({ session, messages: [{ role: 'user', content: 'turn 1' }], mode: 'production', approvals: new LocalApprovals(), dispatchTool: vi.fn(), guard, signal: new AbortController().signal }));
    await tick();
    sock.push({ type: 'event', seq: 2, event: { type: 'activity_completed', activityId: 'a', outcome: 'succeeded', reason: 'end_turn' } });
    await tick();
    // The outcome fired, but the turn boundary (`done`) hasn't arrived: run1 must still be pending.
    let settled = false;
    void run1.then(() => { settled = true; });
    await tick();
    expect(settled).toBe(false);
    sock.push({ type: 'done', seq: 3, reason: 'end_turn' });
    expect(await run1).toEqual([{ type: 'activity_completed', activityId: 'a', outcome: 'succeeded', reason: 'end_turn' }]);

    const run2 = drain(runRemoteLoop({ session, messages: [{ role: 'user', content: 'turn 2' }], mode: 'production', approvals: new LocalApprovals(), dispatchTool: vi.fn(), guard, signal: new AbortController().signal }));
    await tick();
    sock.push({ type: 'event', seq: 4, event: { type: 'activity_completed', activityId: 'b', outcome: 'succeeded', reason: 'end_turn' } });
    sock.push({ type: 'done', seq: 5, reason: 'end_turn' });
    expect(await run2).toEqual([{ type: 'activity_completed', activityId: 'b', outcome: 'succeeded', reason: 'end_turn' }]);
  });

  it('yields a non-terminal busy error and still waits for done to end the turn', async () => {
    const { session, sock } = await connected();
    const run = drain(runRemoteLoop({ session, messages: [{ role: 'user', content: 'x' }], mode: 'production', approvals: new LocalApprovals(), dispatchTool: vi.fn(), guard, signal: new AbortController().signal }));
    await tick();
    sock.push({ type: 'event', seq: 2, event: { type: 'error', activityId: 'a', error: 'busy, try later', kind: 'busy' } });
    sock.push({ type: 'done', seq: 3, reason: 'end_turn' });
    expect(await run).toEqual([{ type: 'error', activityId: 'a', error: 'busy, try later', kind: 'busy' }]);
  });

  it('refuses an unapproved destructive call without dispatching', async () => {
    const { session, sock } = await connected();
    const dispatchTool = vi.fn();
    void drain(runRemoteLoop({ session, messages: [{ role: 'user', content: 'x' }], mode: 'production', approvals: new LocalApprovals(), dispatchTool, guard, signal: new AbortController().signal }));
    await tick();
    sock.push({ type: 'tool_call', seq: 2, id: 't-2', name: 'asset_delete', args: { path: '/Game/X' }, gated: false });
    await tick();
    expect(dispatchTool).not.toHaveBeenCalled();
    expect(sock.sent.at(-1)).toMatchObject({ type: 'tool_result', id: 't-2', ok: false, result: { error: 'approval_required' } });
  });

  it('on resume-after-approval sends approve, lets exactly that call through once, and consumes through the resumed turn\'s done', async () => {
    const { session, sock } = await connected();
    const dispatchTool = vi.fn(async () => ({ deleted: true }));
    const args = { path: '/Game/X' };
    const approvals = new LocalApprovals();
    const run = drain(runRemoteLoop({ session, messages: [], mode: 'production', approvedCall: { name: 'asset_delete', argsHash: argsHash(args) }, approvals, dispatchTool, guard, signal: new AbortController().signal }));
    await tick();
    expect(sock.sent.at(-1)).toMatchObject({ type: 'approve', name: 'asset_delete', args_hash: argsHash(args) });
    sock.push({ type: 'tool_call', seq: 2, id: 't-3', name: 'asset_delete', args, gated: true });
    await tick();
    sock.push({ type: 'tool_call', seq: 3, id: 't-4', name: 'asset_delete', args, gated: true });
    await tick();
    expect(dispatchTool).toHaveBeenCalledTimes(1);
    expect(sock.sent.at(-1)).toMatchObject({ id: 't-4', ok: false });
    // The frames the resumed (approve) call unblocks still belong to the same
    // turn and end with the same turn's `done` — this call must consume it.
    sock.push({ type: 'event', seq: 4, event: { type: 'activity_completed', activityId: 'a', outcome: 'succeeded', reason: 'end_turn' } });
    sock.push({ type: 'done', seq: 5, reason: 'end_turn' });
    expect(await run).toEqual([{ type: 'activity_completed', activityId: 'a', outcome: 'succeeded', reason: 'end_turn' }]);
  });

  it('pauses (returns) on approval_requested and forwards cancel on abort', async () => {
    const { session, sock } = await connected();
    const ac = new AbortController();
    const run = drain(runRemoteLoop({ session, messages: [{ role: 'user', content: 'x' }], mode: 'production', approvals: new LocalApprovals(), dispatchTool: vi.fn(), guard, signal: ac.signal }));
    await tick();
    ac.abort();
    expect(sock.sent.at(-1)).toMatchObject({ type: 'cancel' });
    sock.push({ type: 'event', seq: 2, event: { type: 'approval_requested', activityId: 'a', approvalId: 'p1', call: { id: 't', name: 'asset_delete', input: {} }, argsHash: '{}', source: 'ts' } });
    expect(await run).toHaveLength(1);
  });

  it('ends the loop with a cancelled activity_completed when aborted while the brain is silent/offline', async () => {
    const { session, sock } = await connected();
    const ac = new AbortController();
    const run = drain(runRemoteLoop({ session, messages: [{ role: 'user', content: 'x' }], mode: 'production', approvals: new LocalApprovals(), dispatchTool: vi.fn(), guard, signal: ac.signal }));
    await tick();
    sock.push({ type: 'event', seq: 2, event: { type: 'activity_started', activityId: 'act-1', title: 'Doing a thing' } });
    await tick();
    sock.drop(); // brain goes silent; nothing else will ever arrive on this session
    ac.abort();
    const events = await run;
    expect(events).toEqual([
      { type: 'activity_started', activityId: 'act-1', title: 'Doing a thing' },
      { type: 'activity_completed', activityId: 'act-1', outcome: 'cancelled', reason: 'aborted' },
    ]);
  });

  it('redacts secrets in a failed dispatchTool error message before it leaves the machine', async () => {
    const { session, sock } = await connected();
    const dispatchTool = vi.fn(async () => { throw new Error('upstream said Bearer sk-live-abc123 was rejected'); });
    const run = drain(runRemoteLoop({ session, messages: [{ role: 'user', content: 'hi' }], mode: 'production', approvals: new LocalApprovals(), dispatchTool, guard, signal: new AbortController().signal }));
    await tick();
    sock.push({ type: 'tool_call', seq: 2, id: 't-9', name: 'world_inspect', args: {}, gated: false });
    await tick();
    sock.push({ type: 'event', seq: 3, event: { type: 'activity_completed', activityId: 'a', outcome: 'succeeded', reason: 'end_turn' } });
    sock.push({ type: 'done', seq: 4, reason: 'end_turn' });
    await run;
    const sent = sock.sent.find((s) => s.id === 't-9') as { result: { message: string } };
    expect(sent.result.message).not.toContain('sk-live-abc123');
    expect(sent.result.message).toContain('[REDACTED');
  });

  it('ends locally on an already-aborted signal without waiting for the brain', async () => {
    const { session, sock } = await connected();
    const ac = new AbortController();
    ac.abort();
    const events = await drain(runRemoteLoop({ session, messages: [{ role: 'user', content: 'x' }], mode: 'production', approvals: new LocalApprovals(), dispatchTool: vi.fn(), guard, signal: ac.signal }));
    expect(events).toEqual([{ type: 'activity_completed', activityId: 'brain', outcome: 'cancelled', reason: 'aborted' }]);
    expect(sock.sent.at(-1)).toMatchObject({ type: 'cancel' });
  });

  it('discards turn 1 stragglers on the reused session so turn 2 never sees them', async () => {
    const { session, sock } = await connected();
    const dispatchTool1 = vi.fn();
    const ac = new AbortController();
    const run1 = drain(runRemoteLoop({ session, messages: [{ role: 'user', content: 'turn 1' }], mode: 'production', approvals: new LocalApprovals(), dispatchTool: dispatchTool1, guard, signal: ac.signal }));
    await tick();
    // Turn 1 is aborted locally while the brain is silent (nothing pending yet).
    ac.abort();
    await tick();
    expect(await run1).toEqual([{ type: 'activity_completed', activityId: 'brain', outcome: 'cancelled', reason: 'aborted' }]);

    // The brain only now replies to the cancelled turn: a message, a tool_call, then its terminal + done.
    sock.push({ type: 'event', seq: 2, event: { type: 'message_delta', activityId: 'a', text: 'stale' } });
    sock.push({ type: 'tool_call', seq: 3, id: 't-stale', name: 'world_inspect', args: {}, gated: false });
    sock.push({ type: 'event', seq: 4, event: { type: 'activity_completed', activityId: 'a', outcome: 'cancelled', reason: 'aborted' } });
    sock.push({ type: 'done', seq: 5, reason: 'aborted' });
    await tick();
    // The stale tool_call must be answered as cancelled, never dispatched.
    expect(dispatchTool1).not.toHaveBeenCalled();
    expect(sock.sent.find((s) => s.id === 't-stale')).toMatchObject({ ok: false, result: { error: 'cancelled' } });

    // Turn 2 on the SAME session must only see its own frames and complete normally.
    const dispatchTool2 = vi.fn(async () => ({ ok: true }));
    const run2 = drain(runRemoteLoop({ session, messages: [{ role: 'user', content: 'turn 2' }], mode: 'production', approvals: new LocalApprovals(), dispatchTool: dispatchTool2, guard, signal: new AbortController().signal }));
    await tick();
    sock.push({ type: 'event', seq: 6, event: { type: 'message_delta', activityId: 'b', text: 'fresh' } });
    sock.push({ type: 'tool_call', seq: 7, id: 't-fresh', name: 'world_inspect', args: {}, gated: false });
    await tick();
    expect(dispatchTool2).toHaveBeenCalledWith('world_inspect', {});
    sock.push({ type: 'event', seq: 8, event: { type: 'activity_completed', activityId: 'b', outcome: 'succeeded', reason: 'end_turn' } });
    sock.push({ type: 'done', seq: 9, reason: 'end_turn' });
    const events2 = await run2;
    expect(events2).toEqual([
      { type: 'message_delta', activityId: 'b', text: 'fresh' },
      { type: 'activity_completed', activityId: 'b', outcome: 'succeeded', reason: 'end_turn' },
    ]);
  });

  it('R1: turns a mid-turn upgrade_required into brain_unavailable with reason upgrade_required', async () => {
    const { session, sock } = await connected();
    const reasons: string[] = [];
    const run = drain(runRemoteLoop({ session, messages: [{ role: 'user', content: 'hi' }], mode: 'production', approvals: new LocalApprovals(), dispatchTool: vi.fn(), guard, signal: new AbortController().signal, onUnavailable: (r) => reasons.push(r) }));
    await tick();
    sock.push({ type: 'upgrade_required', seq: 2, min_version: 2, download_url: 'https://example.com/dl' });
    const events = await run;
    expect(events).toEqual([expect.objectContaining({ type: 'error', kind: 'brain_unavailable' })]);
    expect(reasons).toEqual(['upgrade_required']);
  });

  it('R1: a resume rejected mid-turn yields brain_unavailable and leaves the session dead', async () => {
    const { session, sock } = await connected();
    const reasons: string[] = [];
    const run = drain(runRemoteLoop({ session, messages: [{ role: 'user', content: 'hi' }], mode: 'production', approvals: new LocalApprovals(), dispatchTool: vi.fn(), guard, signal: new AbortController().signal, onUnavailable: (r) => reasons.push(r) }));
    await tick();
    sock.push({ type: 'event', seq: 2, event: { type: 'message_delta', activityId: 'a', text: 'x' } });
    sock.drop();
    await new Promise((r) => setTimeout(r, 20));
    const next = (session as unknown as { socket: FakeSocket }).socket;
    next.open(); await tick();
    next.push({ type: 'pro_unavailable', seq: 1, session_id: 'unknown', reason: 'session_expired', message: 'That Pro session has ended.' });
    const events = await run;
    expect(events.at(-1)).toMatchObject({ type: 'error', kind: 'brain_unavailable' });
    expect(reasons).toEqual(['session_expired']);
    expect(session.isAlive()).toBe(false);
  });

  it('dispatches the schema-parsed args, not the raw ones the brain sent', async () => {
    const { session, sock } = await connected();
    const dispatchTool = vi.fn(async () => ({}));
    const parsedGuard = { ...guard, rawShape: (n: string) => (n === 'world_inspect' ? { limit: z.number().default(5) } : undefined) };
    const run = drain(runRemoteLoop({ session, messages: [{ role: 'user', content: 'hi' }], mode: 'production', approvals: new LocalApprovals(), dispatchTool, guard: parsedGuard, signal: new AbortController().signal }));
    await tick();
    sock.push({ type: 'tool_call', seq: 2, id: 't-1', name: 'world_inspect', args: { extra: 'x' }, gated: false });
    await tick();
    expect(dispatchTool).toHaveBeenCalledWith('world_inspect', { limit: 5 });
    sock.push({ type: 'done', seq: 3, reason: 'end_turn' });
    await run;
  });

  it('an approval the turn never used expires when that turn reaches done', async () => {
    const { session, sock } = await connected();
    const approvals = new LocalApprovals();
    const run = drain(runRemoteLoop({ session, messages: [], mode: 'production', approvedCall: { name: 'asset_delete', argsHash: argsHash({ path: '/Game/A' }) }, approvals, dispatchTool: vi.fn(), guard, signal: new AbortController().signal }));
    await tick();
    sock.push({ type: 'done', seq: 2, reason: 'end_turn' });
    await run;
    expect(approvals.consume('asset_delete', argsHash({ path: '/Game/A' }))).toBe(false);
  });
});
