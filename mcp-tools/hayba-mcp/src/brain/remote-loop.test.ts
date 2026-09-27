import { describe, expect, it, vi } from 'vitest';
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
    const events = await run;
    expect(events).toHaveLength(2);
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

  it('on resume-after-approval sends approve and lets exactly that call through once', async () => {
    const { session, sock } = await connected();
    const dispatchTool = vi.fn(async () => ({ deleted: true }));
    const args = { path: '/Game/X' };
    const approvals = new LocalApprovals();
    void drain(runRemoteLoop({ session, messages: [], mode: 'production', approvedCall: { name: 'asset_delete', argsHash: argsHash(args) }, approvals, dispatchTool, guard, signal: new AbortController().signal }));
    await tick();
    expect(sock.sent.at(-1)).toMatchObject({ type: 'approve', name: 'asset_delete', args_hash: argsHash(args) });
    sock.push({ type: 'tool_call', seq: 2, id: 't-3', name: 'asset_delete', args, gated: true });
    await tick();
    sock.push({ type: 'tool_call', seq: 3, id: 't-4', name: 'asset_delete', args, gated: true });
    await tick();
    expect(dispatchTool).toHaveBeenCalledTimes(1);
    expect(sock.sent.at(-1)).toMatchObject({ id: 't-4', ok: false });
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
});
