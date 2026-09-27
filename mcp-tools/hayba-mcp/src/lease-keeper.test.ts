/**
 * Multi-agent leases, Node side: the owner/lease envelope, the renew
 * heartbeat, the lease_* tools and how lease replies surface through
 * executeCommand. Everything runs against a fake sender; nothing opens a socket.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { LeaseKeeper, renewIntervalMs, _resetLeaseKeeperForTesting, getLeaseKeeper } from './lease-keeper.js';
import { buildEnvelope, resolveAgentOwner, type TcpResponse } from './tcp-client.js';
import { executeCommand, setDefaultSender, type Sender } from './tools/tool-executor.js';
import { LEASE_DESCRIPTORS } from './tools/lease/lease-tools.js';

vi.mock('./tools/heavy-op-probe.js', () => ({ probeEditorProcess: async () => null }));

type Call = { cmd: string; params: Record<string, unknown> };

/** A fake editor: records every command and answers from a script. */
function fakeEditor(answer: (call: Call) => Omit<TcpResponse, 'id'> | Error) {
  const calls: Call[] = [];
  const send: Sender = async (cmd, params) => {
    calls.push({ cmd, params });
    const reply = answer({ cmd, params });
    if (reply instanceof Error) throw reply;
    return { id: 'fake', ...reply };
  };
  return { calls, send };
}

/** Manual timers: tick() fires every interval once. */
function manualTimers() {
  const intervals = new Map<number, () => void>();
  let next = 1;
  return {
    setInterval: (fn: () => void, _ms: number) => {
      const id = next++;
      intervals.set(id, fn);
      return { id } as unknown as { unref?: () => void };
    },
    clearInterval: (handle: { unref?: () => void }) => {
      intervals.delete((handle as unknown as { id: number }).id);
    },
    tick: () => [...intervals.values()].forEach((fn) => fn()),
    count: () => intervals.size,
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

function tool(name: string) {
  const d = LEASE_DESCRIPTORS.find((t) => t.name === name);
  if (!d) throw new Error(`no descriptor ${name}`);
  return d.handler as unknown as (args: unknown) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>;
}

afterEach(() => {
  _resetLeaseKeeperForTesting();
});

describe('wire envelope', () => {
  it('omits owner and lease when absent, so older editors see the old envelope', () => {
    expect(buildEnvelope('ping', 'req_1', {})).toEqual({ cmd: 'ping', id: 'req_1', params: {} });
  });

  it('carries owner and lease when set', () => {
    expect(buildEnvelope('actor_spawn', 'req_2', { a: 1 }, 'agent-a', 'lease-x-1')).toEqual({
      cmd: 'actor_spawn',
      id: 'req_2',
      params: { a: 1 },
      owner: 'agent-a',
      lease: 'lease-x-1',
    });
  });

  it('takes the owner from HAYBA_AGENT_ID, else one per process', () => {
    expect(resolveAgentOwner({ HAYBA_AGENT_ID: '  terrain-agent ' }, 42)).toBe('terrain-agent');
    const a = resolveAgentOwner({}, 42);
    expect(a).toMatch(/^node-42-[0-9a-f]{6}$/);
    expect(resolveAgentOwner({ HAYBA_AGENT_ID: 'x'.repeat(500) }, 42)).toHaveLength(128);
  });
});

describe('executeCommand lease replies', () => {
  it('maps an enforced refusal to code lease_conflict', async () => {
    const { send } = fakeEditor(() => ({
      ok: false,
      error: "lease_conflict: 'level_save' (write_world) conflicts with a lease held by 'agent-b'",
      code: 'lease_conflict',
      lease: { holder_owner: 'agent-b' },
    }));
    await expect(executeCommand('level_save', {}, { sender: send })).rejects.toMatchObject({
      name: 'UeToolError',
      code: 'lease_conflict',
    });
  });

  it('surfaces an advisory lease_warning in the data the tool returns', async () => {
    const { send } = fakeEditor(() => ({
      ok: true,
      data: { spawned: true },
      lease_warning: { holder_owner: 'agent-b', enforcement: 'advisory' },
    }));
    await expect(executeCommand('actor_spawn', {}, { sender: send })).resolves.toEqual({
      spawned: true,
      lease_warning: { holder_owner: 'agent-b', enforcement: 'advisory' },
    });
  });
});

describe('LeaseKeeper heartbeat', () => {
  it('renews at a third of the TTL, never faster than once a second', () => {
    expect(renewIntervalMs(120)).toBe(40_000);
    expect(renewIntervalMs(1)).toBe(1_000);
  });

  it('renews every tick with the lease TTL', async () => {
    const timers = manualTimers();
    const editor = fakeEditor(() => ({ ok: true, data: { renewed: true } }));
    const keeper = new LeaseKeeper({ sender: editor.send, ...timers });
    keeper.track('lease-1', 90);
    timers.tick();
    timers.tick();
    await flush();
    expect(editor.calls).toEqual([
      { cmd: 'lease_renew', params: { token: 'lease-1', ttl_s: 90 } },
      { cmd: 'lease_renew', params: { token: 'lease-1', ttl_s: 90 } },
    ]);
  });

  it('stops and reports once the editor refuses a renew', async () => {
    const timers = manualTimers();
    const lost: string[] = [];
    const editor = fakeEditor(() => ({ ok: false, error: 'lease_renew: unknown or expired lease' }));
    const keeper = new LeaseKeeper({ sender: editor.send, ...timers, onLost: (t) => lost.push(t) });
    keeper.track('lease-1', 30);
    expect(await keeper.renewNow('lease-1')).toBe(false);
    expect(lost).toEqual(['lease-1']);
    expect(keeper.heldTokens()).toEqual([]);
    expect(timers.count()).toBe(0);
  });

  it('keeps renewing through a transport failure', async () => {
    const timers = manualTimers();
    const editor = fakeEditor(() => new Error('ECONNRESET'));
    const keeper = new LeaseKeeper({ sender: editor.send, ...timers });
    keeper.track('lease-1', 30);
    expect(await keeper.renewNow('lease-1')).toBe(true);
    expect(keeper.heldTokens()).toEqual(['lease-1']);
  });

  it('untrack clears the timer', () => {
    const timers = manualTimers();
    const keeper = new LeaseKeeper({ sender: fakeEditor(() => ({ ok: true })).send, ...timers });
    keeper.track('a', 30);
    keeper.track('a', 60);
    expect(timers.count()).toBe(1);
    keeper.untrack('a');
    expect(timers.count()).toBe(0);
  });
});

describe('lease_* tools', () => {
  it('lease_acquire forwards the request and starts renewing a granted lease', async () => {
    const editor = fakeEditor(({ cmd }) =>
      cmd === 'lease_acquire'
        ? { ok: true, data: { status: 'granted', token: 'lease-abc-1', expires_in_s: 60 } }
        : { ok: true, data: {} },
    );
    setDefaultSender(editor.send);
    const r = await tool('lease_acquire')({ resources: ['world:/Game/Maps/Valley'], ttl_s: 60, lane: 'long' });
    expect(editor.calls[0]).toEqual({
      cmd: 'lease_acquire',
      params: { resources: ['world:/Game/Maps/Valley'], ttl_s: 60, lane: 'long' },
    });
    expect(JSON.parse(r.content[0]!.text)).toMatchObject({ status: 'granted', auto_renew: true });
    expect(getLeaseKeeper().heldTokens()).toEqual(['lease-abc-1']);
  });

  it('lease_acquire does not renew a queued answer', async () => {
    const editor = fakeEditor(() => ({
      ok: true,
      data: { status: 'queued', ticket: 'q-abc-2', position: 1, holder_owner: 'agent-b', eta_s: 40 },
    }));
    setDefaultSender(editor.send);
    const r = await tool('lease_acquire')({ resources: ['world:/Game/Maps/Valley'] });
    expect(JSON.parse(r.content[0]!.text)).toMatchObject({ status: 'queued', ticket: 'q-abc-2' });
    expect(getLeaseKeeper().heldTokens()).toEqual([]);
  });

  it('lease_acquire rejects a bad argument without contacting the editor', async () => {
    const editor = fakeEditor(() => ({ ok: true, data: {} }));
    setDefaultSender(editor.send);
    const r = await tool('lease_acquire')({ resources: ['world:/Game/V'], ttl_s: 5000 });
    expect(r.isError).toBe(true);
    expect(editor.calls).toEqual([]);
  });

  it('lease_release stops the heartbeat and releases', async () => {
    const editor = fakeEditor(() => ({ ok: true, data: { released: true } }));
    setDefaultSender(editor.send);
    getLeaseKeeper().track('lease-abc-1', 60);
    await tool('lease_release')({ token: 'lease-abc-1' });
    expect(getLeaseKeeper().heldTokens()).toEqual([]);
    expect(editor.calls).toEqual([{ cmd: 'lease_release', params: { token: 'lease-abc-1' } }]);
  });

  it('lease_status adds which tokens this server is renewing', async () => {
    const editor = fakeEditor(() => ({ ok: true, data: { enforcement: 'advisory', leases: [], waiters: [] } }));
    setDefaultSender(editor.send);
    getLeaseKeeper().track('lease-abc-1', 60);
    const r = await tool('lease_status')({});
    expect(JSON.parse(r.content[0]!.text)).toMatchObject({
      enforcement: 'advisory',
      renewing_tokens: ['lease-abc-1'],
    });
  });
});
