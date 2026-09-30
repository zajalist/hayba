/**
 * Multi-agent leases, Node side: the owner/lease envelope, the renew heartbeat
 * keyed by lease_id, and the I-5 regression. Everything runs against a fake
 * sender; nothing opens a socket. The lease_* tool shapes are covered in
 * tools/lease/lease-wire.test.ts.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  LeaseKeeper,
  isUsableLeaseId,
  renewIntervalMs,
  _resetLeaseKeeperForTesting,
  getLeaseKeeper,
} from './lease-keeper.js';
import { buildEnvelope, resolveAgentOwner, type TcpResponse } from './tcp-client.js';
import { executeCommand, setDefaultSender, type Sender } from './tools/tool-executor.js';
import { handleLeaseAcquire } from './tools/lease/lease-tools.js';
import { redactSecrets } from './security/secret-redaction.js';

vi.mock('./tools/heavy-op-probe.js', () => ({ probeEditorProcess: async () => null }));

const LEASE = 'ls_1_aad6bc3c3546';

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

/**
 * The editor's last-mile redaction (RedactFinalEnvelope) sits between the
 * lease handler and the socket. The Node redactor applies the same key rule,
 * so it stands in for it here.
 */
function nativeRedaction(send: Sender): Sender {
  return async (cmd, params, timeoutMs) => redactSecrets(await send(cmd, params, timeoutMs)).value;
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

afterEach(() => {
  _resetLeaseKeeperForTesting();
});

describe('wire envelope', () => {
  it('omits owner and lease when absent, so older editors see the old envelope', () => {
    expect(buildEnvelope('ping', 'req_1', {})).toEqual({ cmd: 'ping', id: 'req_1', params: {} });
  });

  it('carries owner and lease when set', () => {
    expect(buildEnvelope('actor_spawn', 'req_2', { a: 1 }, 'agent-a', LEASE)).toEqual({
      cmd: 'actor_spawn',
      id: 'req_2',
      params: { a: 1 },
      owner: 'agent-a',
      lease: LEASE,
    });
  });

  it('takes the owner from HAYBA_AGENT_ID, else one per process', () => {
    expect(resolveAgentOwner({ HAYBA_AGENT_ID: '  terrain-agent ' }, 42)).toBe('terrain-agent');
    expect(resolveAgentOwner({}, 42)).toMatch(/^node-42-[0-9a-f]{6}$/);
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

describe('lease ids', () => {
  it('accepts only ls_<seq>_<mac> ids', () => {
    expect(isUsableLeaseId(LEASE)).toBe(true);
    expect(isUsableLeaseId('ls_7')).toBe(true);
    for (const bad of ['[REDACTED:token]', 'lease-abc-1', 'lq_2_b4086670970d', 'LS_1_AAD6', '', 42, null, undefined]) {
      expect(isUsableLeaseId(bad)).toBe(false);
    }
  });
});

describe('LeaseKeeper heartbeat', () => {
  it('renews at a third of the TTL, never faster than once a second', () => {
    expect(renewIntervalMs(120)).toBe(40_000);
    expect(renewIntervalMs(1)).toBe(1_000);
  });

  it('renews every tick with lease_id and the lease TTL', async () => {
    const timers = manualTimers();
    const editor = fakeEditor(() => ({ ok: true, data: { lease_id: LEASE, renewed: true } }));
    const keeper = new LeaseKeeper({ sender: editor.send, ...timers });
    expect(keeper.track(LEASE, 90)).toBe(true);
    timers.tick();
    timers.tick();
    await flush();
    expect(editor.calls).toEqual([
      { cmd: 'lease_renew', params: { lease_id: LEASE, ttl_s: 90 } },
      { cmd: 'lease_renew', params: { lease_id: LEASE, ttl_s: 90 } },
    ]);
  });

  it('refuses to track anything that is not a lease_id', () => {
    const timers = manualTimers();
    const keeper = new LeaseKeeper({ sender: fakeEditor(() => ({ ok: true })).send, ...timers });
    expect(keeper.track('[REDACTED:token]', 60)).toBe(false);
    expect(keeper.track('lease-abc-1', 60)).toBe(false);
    expect(keeper.track('', 60)).toBe(false);
    expect(keeper.heldLeaseIds()).toEqual([]);
    expect(timers.count()).toBe(0);
  });

  it('stops and reports once the editor refuses a renew', async () => {
    const timers = manualTimers();
    const lost: string[] = [];
    const editor = fakeEditor(() => ({ ok: false, error: 'lease_renew [lease_id_unknown]: unknown or expired lease' }));
    const keeper = new LeaseKeeper({ sender: editor.send, ...timers, onLost: (id) => lost.push(id) });
    keeper.track(LEASE, 30);
    expect(await keeper.renewNow(LEASE)).toBe(false);
    expect(lost).toEqual([LEASE]);
    expect(keeper.heldLeaseIds()).toEqual([]);
    expect(timers.count()).toBe(0);
  });

  it('keeps renewing through a transport failure', async () => {
    const timers = manualTimers();
    const editor = fakeEditor(() => new Error('ECONNRESET'));
    const keeper = new LeaseKeeper({ sender: editor.send, ...timers });
    keeper.track(LEASE, 30);
    expect(await keeper.renewNow(LEASE)).toBe(true);
    expect(keeper.heldLeaseIds()).toEqual([LEASE]);
  });

  it('untrack clears the timer', () => {
    const timers = manualTimers();
    const keeper = new LeaseKeeper({ sender: fakeEditor(() => ({ ok: true })).send, ...timers });
    keeper.track(LEASE, 30);
    keeper.track(LEASE, 60);
    expect(timers.count()).toBe(1);
    keeper.untrack(LEASE);
    expect(timers.count()).toBe(0);
  });
});

describe('I-5: the lease handle survives redaction', () => {
  it('a grant that names the handle `token` is redacted, reported as lease_id_error and never tracked', async () => {
    const editor = fakeEditor(() => ({ ok: true, data: { status: 'granted', token: LEASE, expires_in_s: 60 } }));
    setDefaultSender(nativeRedaction(editor.send));
    const out = JSON.parse((await handleLeaseAcquire({ resources: ['world:/Game/Maps/Valley'] })).content[0]!.text);
    expect(out.token).toBe('[REDACTED:token]');
    expect(out).toMatchObject({ status: 'granted', auto_renew: false, lease_id_error: 'missing_or_unusable' });
    expect(getLeaseKeeper().heldLeaseIds()).toEqual([]);
  });

  it('a grant that names it lease_id passes redaction unchanged and is renewed', async () => {
    const editor = fakeEditor(({ cmd }) =>
      cmd === 'lease_acquire'
        ? { ok: true, data: { status: 'granted', lease_id: LEASE, expires_in_s: 60 } }
        : { ok: true, data: { lease_id: LEASE, renewed: true } },
    );
    setDefaultSender(nativeRedaction(editor.send));
    const out = JSON.parse((await handleLeaseAcquire({ resources: ['world:/Game/Maps/Valley'], ttl_s: 60 })).content[0]!.text);
    expect(out).toMatchObject({ lease_id: LEASE, auto_renew: true });
    expect(getLeaseKeeper().heldLeaseIds()).toEqual([LEASE]);
    expect(await getLeaseKeeper().renewNow(LEASE)).toBe(true);
    expect(editor.calls.at(-1)).toEqual({ cmd: 'lease_renew', params: { lease_id: LEASE, ttl_s: 60 } });
  });
});
