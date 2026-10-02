import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { getUEClient, buildEnvelope, type TcpResponse } from '../../tcp-client.js';
import { _resetLeaseKeeperForTesting, getLeaseKeeper } from '../../lease-keeper.js';
import { LEASE_DESCRIPTORS } from './lease-tools.js';
import { NON_IDEMPOTENT, setDefaultSender, type Sender } from '../tool-executor.js';
import { recordSchema } from '../schema-registry.js';
import { listToolCategoriesHandler } from '../code-mode/list-tool-categories.js';

// Keep client owner/lease state real; isolate only the connection boundary.
vi.mock('../../tcp-client.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../tcp-client.js')>(),
  ensureConnected: vi.fn(async () => { throw new Error('adoption tests never dial the editor'); }),
}));
vi.mock('../heavy-op-probe.js', () => ({ probeEditorProcess: async () => null }));

type Call = { cmd: string; params: Record<string, unknown> };
const LEASE = 'ls_7_abcdef012345';
const OLD_LEASE = 'ls_8_abcdef012346';
const confirmation = { adopted: true, owner: 'lane-3', lease_id: LEASE, connection_owner: 'lane-3', expires_in_s: 100, note: 'n' };

function editor(answer: (c: Call) => Omit<TcpResponse, 'id'>): Call[] {
  const calls: Call[] = [];
  const send: Sender = async (cmd, params) => {
    calls.push({ cmd, params });
    return { id: 'fake', ...answer({ cmd, params }) };
  };
  setDefaultSender(send);
  return calls;
}

function tool(name: string) {
  const d = LEASE_DESCRIPTORS.find((t) => t.name === name);
  if (!d) throw new Error(`no descriptor ${name}`);
  return d.handler as unknown as (args: unknown) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>;
}

function unchanged() {
  expect(getUEClient().getOwner()).toBe('before-adoption');
  expect(getUEClient().getLease()).toBe(OLD_LEASE);
}

beforeEach(() => {
  vi.useFakeTimers();
  getUEClient().setOwner('before-adoption');
  getUEClient().setLease(OLD_LEASE);
});

afterEach(() => {
  _resetLeaseKeeperForTesting();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('lease_adopt (T9)', () => {
  it('switches owner and manual envelope lease only after matching confirmation', async () => {
    const calls = editor(() => ({ ok: true, data: confirmation }));
    const r = await tool('lease_adopt')({ owner: ' lane-3 ', lease_id: LEASE });
    expect(calls).toEqual([{ cmd: 'lease_adopt', params: { owner: 'lane-3', lease_id: LEASE } }]);
    expect(JSON.parse(r.content[0]!.text)).toEqual(confirmation);
    expect(buildEnvelope('ping', 'req_1', {}, getUEClient().getOwner(), getUEClient().getLease()))
      .toMatchObject({ owner: 'lane-3', lease: LEASE });
    // Confirmed adoption is manual: R9 never drops this id on an unknown reply.
    getUEClient().noteReply({ id: 'req_2', ok: false, error: 'lease_renew: [lease_id_unknown] unknown lease' }, LEASE);
    expect(getUEClient().getLease()).toBe(LEASE);
  });

  it('a refused adoption preserves the existing owner and lease', async () => {
    editor(() => ({ ok: false, error: "lease_adopt: [lease_owner_mismatch] lease belongs to 'lane-9'" }));
    await expect(tool('lease_adopt')({ owner: 'lane-3', lease_id: LEASE })).rejects.toThrow(/lease_owner_mismatch/);
    unchanged();
  });

  it.each([
    ['not adopted', { ...confirmation, adopted: false }],
    ['missing adopted', { owner: 'lane-3', lease_id: LEASE, connection_owner: 'lane-3' }],
    ['different owner', { ...confirmation, owner: 'lane-9' }],
    ['different lease', { ...confirmation, lease_id: OLD_LEASE }],
    ['different connection owner', { ...confirmation, connection_owner: 'lane-9' }],
    ['missing connection owner', { adopted: true, owner: 'lane-3', lease_id: LEASE }],
    ['empty data', {}],
  ])('a %s reply preserves existing state', async (_label, data) => {
    editor(() => ({ ok: true, data }));
    await tool('lease_adopt')({ owner: 'lane-3', lease_id: LEASE });
    unchanged();
  });

  it.each(['[REDACTED:lease]', 'lq_7_abcdef012345', '', 'not-a-lease'])('rejects unusable id %j without sending', async (lease_id) => {
    const calls = editor(() => ({ ok: true, data: confirmation }));
    expect((await tool('lease_adopt')({ owner: 'lane-3', lease_id })).isError).toBe(true);
    expect(calls).toEqual([]);
    unchanged();
  });

  it.each(['', ' ', 'x'.repeat(129)])('rejects invalid owner %j without sending', async (owner) => {
    const calls = editor(() => ({ ok: true, data: confirmation }));
    expect((await tool('lease_adopt')({ owner, lease_id: LEASE })).isError).toBe(true);
    expect(calls).toEqual([]);
    unchanged();
  });

  it('does not track the adopted lease or transfer existing keeper timers', async () => {
    const calls = editor(({ cmd }) => cmd === 'lease_adopt'
      ? { ok: true, data: confirmation }
      : { ok: false, error: "lease_renew: [lease_owner_mismatch] lease belongs to 'before-adoption'" });
    const keeper = getLeaseKeeper();
    const lost = vi.spyOn(console, 'error').mockImplementation(() => {});
    keeper.track(OLD_LEASE, 60);
    const timerCount = vi.getTimerCount();
    await tool('lease_adopt')({ owner: 'lane-3', lease_id: LEASE });
    expect(keeper.heldLeaseIds()).toEqual([OLD_LEASE]);
    expect(vi.getTimerCount()).toBe(timerCount);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(calls).toEqual([
      { cmd: 'lease_adopt', params: { owner: 'lane-3', lease_id: LEASE } },
      { cmd: 'lease_renew', params: { lease_id: OLD_LEASE, ttl_s: 60 } },
    ]);
    expect(keeper.heldLeaseIds()).toEqual([]);
    expect(lost).toHaveBeenCalledOnce();
    expect(getUEClient().getOwner()).toBe('lane-3');
    expect(getUEClient().getLease()).toBe(LEASE);
  });

  it('publishes its returns, stays retry-safe and describes reconnect/manual lifetime', () => {
    const d = LEASE_DESCRIPTORS.find((t) => t.name === 'lease_adopt');
    expect(d?.returns).toContain('connection_owner');
    expect(`${d?.description} ${d?.returns}`).not.toMatch(/token/i);
    expect(d?.description).toMatch(/reconnect/i);
    expect(d?.description).toMatch(/renew/i);
    expect(NON_IDEMPOTENT.has('lease_adopt')).toBe(false);
    expect(LEASE_DESCRIPTORS.find((t) => t.name === 'lease_status')?.returns).toContain('connection_owner');
  });

  it('appears as callable in the generated lease domain', async () => {
    for (const d of LEASE_DESCRIPTORS) {
      recordSchema(d.name, { shape: (d.schema ?? {}) as z.ZodRawShape, cost: 'low', returns: d.returns });
    }
    const res = await listToolCategoriesHandler({}, {} as never);
    const out = JSON.parse((res.content[0] as { text: string }).text) as { domains: Array<{ domain: string; callable: string[] }> };
    expect(out.domains.find((d) => d.domain === 'lease')?.callable).toContain('lease_adopt');
  });
});
