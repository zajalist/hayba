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
  it('renews inside both the TTL and the orphan grace: max(1 s, min(ttl, grace) / 3)', () => {
    expect(renewIntervalMs(120)).toBe(20_000);
    expect(renewIntervalMs(30)).toBe(10_000);
    expect(renewIntervalMs(900)).toBe(20_000);
    expect(renewIntervalMs(1)).toBe(1_000);
    expect(renewIntervalMs(120, 300)).toBe(40_000);
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

describe('LeaseKeeper lifetime (T7)', () => {
  it('renewAllByOwner sends lease_renew with no id and adopts nothing', async () => {
    const editor = fakeEditor(({ cmd, params }) =>
      cmd === 'lease_renew' && Object.keys(params).length === 0
        ? {
            ok: true,
            data: {
              owner: 'lane-3',
              renewed: 2,
              expires_in_s: 118,
              leases: [
                { lease_id: 'ls_4_0123456789ab', expires_in_s: 118, orphaned: false },
                { lease_id: 'ls_5_0123456789ab', expires_in_s: 120, orphaned: false },
              ],
            },
          }
        : new Error(`unexpected ${cmd}`),
    );
    const keeper = new LeaseKeeper({ sender: editor.send, ...manualTimers() });
    const reply = await keeper.renewAllByOwner();
    expect(editor.calls).toEqual([{ cmd: 'lease_renew', params: {} }]);
    expect(reply).toMatchObject({ owner: 'lane-3', renewed: 2 });
    expect(keeper.heldLeaseIds()).toEqual([]);
  });

  it('renewAllByOwner forwards an explicit TTL', async () => {
    const editor = fakeEditor(() => ({ ok: true, data: { renewed: 1 } }));
    const keeper = new LeaseKeeper({ sender: editor.send, ...manualTimers() });
    await keeper.renewAllByOwner(300);
    expect(editor.calls).toEqual([{ cmd: 'lease_renew', params: { ttl_s: 300 } }]);
  });

  it('a restarted server with the same HAYBA_AGENT_ID revives its orphans by owner (R-10)', async () => {
    // Same owner before and after the restart, whatever the pid.
    expect(resolveAgentOwner({ HAYBA_AGENT_ID: 'lane-3' }, 111)).toBe(resolveAgentOwner({ HAYBA_AGENT_ID: 'lane-3' }, 222));
    const editor = fakeEditor(({ cmd }) =>
      cmd === 'lease_renew'
        ? { ok: true, data: { owner: 'lane-3', renewed: 1, leases: [{ lease_id: 'ls_9_0123456789ab', orphaned: false }] } }
        : new Error(`unexpected ${cmd}`),
    );
    const restarted = new LeaseKeeper({ sender: editor.send, ...manualTimers() });
    expect(restarted.heldLeaseIds()).toEqual([]); // the old tracked ids died with the old process
    await expect(restarted.renewAllByOwner()).resolves.toMatchObject({ renewed: 1 });
  });

  it('a redaction marker is never tracked', () => {
    const timers = manualTimers();
    const keeper = new LeaseKeeper({ sender: fakeEditor(() => ({ ok: true })).send, ...timers });
    expect(keeper.track('[REDACTED:token]', 60)).toBe(false);
    expect(timers.count()).toBe(0);
  });

  it('the heartbeat stays inside the 60 s orphan grace even for the maximum TTL', () => {
    const intervals: number[] = [];
    const keeper = new LeaseKeeper({
      sender: fakeEditor(() => ({ ok: true })).send,
      setInterval: (_fn, ms) => {
        intervals.push(ms);
        return {};
      },
      clearInterval: () => {},
    });
    keeper.track('ls_1_0123456789ab', 900);
    expect(intervals).toEqual([20_000]);
  });
});

describe('lease enforcement replies (T8)', () => {
  it('maps an owner_required refusal to its own code', async () => {
    const { send } = fakeEditor(() => ({
      ok: false,
      code: 'owner_required',
      error: "owner_required: 'level_save' (write_world) names no owner while 1 other agents are connected (lane-3).",
      lease: { reason: 'owner_missing', other_owners: ['lane-3'] },
    }));
    await expect(executeCommand('level_save', {}, { sender: send })).rejects.toMatchObject({
      name: 'UeToolError',
      code: 'owner_required',
    });
  });

  it('keeps lease_unknown as a lease_conflict reason, not a code of its own', async () => {
    const { send } = fakeEditor(() => ({
      ok: false,
      code: 'lease_conflict',
      error: "lease_conflict: 'level_save': the envelope's lease_id is unknown or expired",
      lease: { reason: 'lease_unknown', lease_id_error: 'unknown_or_expired' },
    }));
    await expect(executeCommand('level_save', {}, { sender: send })).rejects.toMatchObject({
      code: 'lease_conflict',
      uePayload: { lease: { reason: 'lease_unknown' } },
    });
  });

  it('passes repeats_in_window through an advisory warning', async () => {
    const { send } = fakeEditor(() => ({
      ok: true,
      data: { ran: true },
      lease_warning: { code: 'lease_conflict', reason: 'held', enforcement: 'advisory', repeats_in_window: 7 },
    }));
    await expect(executeCommand('actor_spawn', {}, { sender: send })).resolves.toMatchObject({
      lease_warning: { repeats_in_window: 7 },
    });
  });
});
