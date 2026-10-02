/**
 * lease_* tools on the wire (T4): the handle is lease_id, never token. Bad
 * arguments are refused with the editor's own [lease_id_*] messages before
 * anything is sent. The deprecated `token` input is accepted but never sent.
 * Runs against a fake sender; tcp-client is mocked so nothing can dial 52342.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { _resetLeaseKeeperForTesting, getLeaseKeeper } from '../../lease-keeper.js';
import type { TcpResponse } from '../../tcp-client.js';
import { setDefaultSender, type Sender } from '../tool-executor.js';
import { BATCH_DESCRIPTORS } from '../batch/batch-tools.js';
import { LEASE_DESCRIPTORS, LEASE_ID_MESSAGES, TOKEN_DEPRECATION } from './lease-tools.js';

vi.mock('../../tcp-client.js', () => ({
  ensureConnected: vi.fn(async () => {
    throw new Error('lease-wire tests never dial the editor');
  }),
}));
vi.mock('../heavy-op-probe.js', () => ({ probeEditorProcess: async () => null }));

const A = 'ls_1_aad6bc3c3546';
const B = 'ls_2_b30995e71074';
const TICKET = 'lq_2_b4086670970d';

type Call = { cmd: string; params: Record<string, unknown> };
type ToolResult = { content: Array<{ text: string }>; isError?: boolean };

function fakeEditor(answer: (call: Call) => Omit<TcpResponse, 'id'>) {
  const calls: Call[] = [];
  const send: Sender = async (cmd, params) => {
    calls.push({ cmd, params });
    return { id: 'fake', ...answer({ cmd, params }) };
  };
  return { calls, send };
}

function tool(name: string) {
  const d = [...LEASE_DESCRIPTORS, ...BATCH_DESCRIPTORS].find((t) => t.name === name);
  if (!d) throw new Error(`no descriptor ${name}`);
  return d.handler as unknown as (args: unknown) => Promise<ToolResult>;
}

const body = (r: ToolResult) => JSON.parse(r.content[0]!.text) as Record<string, unknown>;

afterEach(() => {
  _resetLeaseKeeperForTesting();
});

describe('lease_acquire', () => {
  it('forwards the request and renews a granted lease_id in the background', async () => {
    const editor = fakeEditor(() => ({ ok: true, data: { status: 'granted', lease_id: A, expires_in_s: 60 } }));
    setDefaultSender(editor.send);
    const r = await tool('lease_acquire')({ resources: ['world:/Game/Maps/Valley'], ttl_s: 60, lane: 'long' });
    expect(editor.calls).toEqual([
      { cmd: 'lease_acquire', params: { resources: ['world:/Game/Maps/Valley'], ttl_s: 60, lane: 'long' } },
    ]);
    expect(body(r)).toMatchObject({ status: 'granted', lease_id: A, auto_renew: true });
    expect(getLeaseKeeper().heldLeaseIds()).toEqual([A]);
  });

  it('does not renew a queued answer', async () => {
    setDefaultSender(
      fakeEditor(() => ({ ok: true, data: { status: 'queued', ticket: TICKET, position: 1, holder_owner: 'agent-b', eta_s: 40 } })).send,
    );
    const r = await tool('lease_acquire')({ resources: ['world:/Game/Maps/Valley'] });
    expect(body(r)).toMatchObject({ status: 'queued', ticket: TICKET });
    expect(getLeaseKeeper().heldLeaseIds()).toEqual([]);
  });

  it('reports lease_id_error and tracks nothing when the grant carries no usable lease_id', async () => {
    for (const data of [
      { status: 'granted', token: '[REDACTED:token]' },
      { status: 'granted', lease_id: '[REDACTED:token]' },
      { status: 'granted', lease_id: 'lease-abc-1' },
    ]) {
      setDefaultSender(fakeEditor(() => ({ ok: true, data })).send);
      const r = await tool('lease_acquire')({ resources: ['world:/Game/Maps/Valley'] });
      expect(body(r)).toMatchObject({ status: 'granted', auto_renew: false, lease_id_error: 'missing_or_unusable' });
    }
    expect(getLeaseKeeper().heldLeaseIds()).toEqual([]);
  });

  it('rejects a bad argument without contacting the editor', async () => {
    const editor = fakeEditor(() => ({ ok: true, data: {} }));
    setDefaultSender(editor.send);
    const r = await tool('lease_acquire')({ resources: ['world:/Game/V'], ttl_s: 5000 });
    expect(r.isError).toBe(true);
    expect(editor.calls).toEqual([]);
  });
});

describe('lease_renew', () => {
  it('sends lease_id and ttl_s', async () => {
    const editor = fakeEditor(() => ({ ok: true, data: { lease_id: A, renewed: true, expires_in_s: 90 } }));
    setDefaultSender(editor.send);
    const r = await tool('lease_renew')({ lease_id: A, ttl_s: 90 });
    expect(editor.calls).toEqual([{ cmd: 'lease_renew', params: { lease_id: A, ttl_s: 90 } }]);
    expect(body(r)).not.toHaveProperty('deprecation');
  });

  it('accepts the deprecated token, sends it as lease_id and says so', async () => {
    const editor = fakeEditor(() => ({ ok: true, data: { lease_id: A, renewed: true, expires_in_s: 120 } }));
    setDefaultSender(editor.send);
    const r = await tool('lease_renew')({ token: A });
    expect(editor.calls).toEqual([{ cmd: 'lease_renew', params: { lease_id: A } }]);
    expect(body(r).deprecation).toBe(TOKEN_DEPRECATION);
  });

  it.each([
    ['two different ids', { lease_id: A, token: B }, LEASE_ID_MESSAGES.ambiguous('lease_renew')],
    ['a marker under lease_id', { lease_id: '[REDACTED:token]' }, LEASE_ID_MESSAGES.redacted('lease_renew')],
  ])('refuses %s with the editor message and sends nothing', async (_label, args, message) => {
    const editor = fakeEditor(() => ({ ok: true, data: {} }));
    setDefaultSender(editor.send);
    const r = await tool('lease_renew')(args);
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toContain(message);
    expect(editor.calls).toEqual([]);
  });
});

describe('lease_release', () => {
  it('stops the heartbeat and releases by lease_id', async () => {
    const editor = fakeEditor(() => ({ ok: true, data: { lease_id: A, released: true } }));
    setDefaultSender(editor.send);
    getLeaseKeeper().track(A, 60);
    await tool('lease_release')({ lease_id: A });
    expect(getLeaseKeeper().heldLeaseIds()).toEqual([]);
    expect(editor.calls).toEqual([{ cmd: 'lease_release', params: { lease_id: A } }]);
  });

  it('withdraws a queued request by ticket', async () => {
    const editor = fakeEditor(() => ({ ok: true, data: { ticket: TICKET, released: true } }));
    setDefaultSender(editor.send);
    await tool('lease_release')({ ticket: TICKET });
    expect(editor.calls).toEqual([{ cmd: 'lease_release', params: { ticket: TICKET } }]);
  });

  it('maps the deprecated token to lease_id, or to ticket for an lq_ value', async () => {
    const editor = fakeEditor(({ params }) => ({ ok: true, data: { ...params, released: true } }));
    setDefaultSender(editor.send);
    expect(body(await tool('lease_release')({ token: A })).deprecation).toBe(TOKEN_DEPRECATION);
    expect(body(await tool('lease_release')({ token: TICKET })).deprecation).toBe(TOKEN_DEPRECATION);
    expect(editor.calls).toEqual([
      { cmd: 'lease_release', params: { lease_id: A } },
      { cmd: 'lease_release', params: { ticket: TICKET } },
    ]);
  });

  it.each([
    ['nothing', {}, LEASE_ID_MESSAGES.releaseExactlyOne],
    ['both a lease_id and a ticket', { lease_id: A, ticket: TICKET }, LEASE_ID_MESSAGES.releaseExactlyOne],
    ['two different ids', { lease_id: A, token: B }, LEASE_ID_MESSAGES.ambiguous('lease_release')],
    ['a marker', { lease_id: '[REDACTED:token]' }, LEASE_ID_MESSAGES.redacted('lease_release')],
  ])('refuses %s with the editor message and sends nothing', async (_label, args, message) => {
    const editor = fakeEditor(() => ({ ok: true, data: {} }));
    setDefaultSender(editor.send);
    const r = await tool('lease_release')(args);
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toContain(message);
    expect(editor.calls).toEqual([]);
  });
});

describe('lease_status', () => {
  it('adds which lease_ids this server is renewing', async () => {
    setDefaultSender(fakeEditor(() => ({ ok: true, data: { enforcement: 'advisory', leases: [], waiters: [] } })).send);
    getLeaseKeeper().track(A, 60);
    const out = body(await tool('lease_status')({}));
    expect(out).toMatchObject({ enforcement: 'advisory', renewing_lease_ids: [A] });
    expect(out).not.toHaveProperty('renewing_tokens');
  });
});

describe('protocol keys (ADR-0010, "Lease ids")', () => {
  const SECRET_TAIL = /(token|secret|password|passwd|pwd|credential|cookie|authorization|key)$/i;

  it('no lease or batch key ends in a secret word, except the deprecated token input', () => {
    for (const d of [...LEASE_DESCRIPTORS, ...BATCH_DESCRIPTORS]) {
      for (const key of Object.keys(d.schema)) {
        if (key === 'token' && (d.name === 'lease_renew' || d.name === 'lease_release')) continue;
        expect(`${d.name}.${key}`).not.toMatch(SECRET_TAIL);
      }
    }
  });

  it('no returns text names token, and no description contains token: or token=', () => {
    for (const d of [...LEASE_DESCRIPTORS, ...BATCH_DESCRIPTORS]) {
      expect(`${d.name}: ${d.returns}`).not.toMatch(/\btoken\b/);
      expect(d.description).not.toMatch(/token[:=]/);
    }
  });
});

describe('lease tools, lifetime (T7)', () => {
  type T7Call = { cmd: string; params: Record<string, unknown> };
  function t7Editor(data: Record<string, unknown> = {}) {
    const calls: T7Call[] = [];
    const send: Sender = async (cmd, params) => {
      calls.push({ cmd, params });
      return { id: 't7', ok: true, data };
    };
    setDefaultSender(send);
    return calls;
  }
  function t7Tool(name: string) {
    const d = LEASE_DESCRIPTORS.find((t) => t.name === name);
    if (!d) throw new Error(`no descriptor ${name}`);
    return d.handler as unknown as (args: unknown) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>;
  }
  afterEach(() => _resetLeaseKeeperForTesting());

  it('lease_renew with no id renews by owner', async () => {
    const calls = t7Editor({ owner: 'o', renewed: 2 });
    await t7Tool('lease_renew')({});
    await t7Tool('lease_renew')({ ttl_s: 60 });
    expect(calls).toEqual([
      { cmd: 'lease_renew', params: {} },
      { cmd: 'lease_renew', params: { ttl_s: 60 } },
    ]);
  });

  it('a marker under the deprecated alias renews by owner too (R5)', async () => {
    const calls = t7Editor({ renewed: 1 });
    await t7Tool('lease_renew')({ token: '[REDACTED:token]' });
    expect(calls).toEqual([{ cmd: 'lease_renew', params: {} }]);
  });

  it('lease_renew with an id sends lease_id, never the alias', async () => {
    const calls = t7Editor({ renewed: true });
    await t7Tool('lease_renew')({ token: 'ls_3_0123456789ab' });
    expect(calls).toEqual([{ cmd: 'lease_renew', params: { lease_id: 'ls_3_0123456789ab' } }]);
  });

  it('lease_release all stops every heartbeat before releasing', async () => {
    const stopped = vi.spyOn(getLeaseKeeper(), 'stopAll');
    const editor = fakeEditor(() => {
      expect(stopped).toHaveBeenCalledOnce();
      expect(getLeaseKeeper().heldLeaseIds()).toEqual([]);
      return { ok: true, data: { owner: 'o', released: 2, tickets_withdrawn: 0 } };
    });
    setDefaultSender(editor.send);
    const calls = editor.calls;
    getLeaseKeeper().track('ls_1_0123456789ab', 120);
    getLeaseKeeper().track('ls_2_0123456789ab', 120);
    await t7Tool('lease_release')({ all: true });
    expect(getLeaseKeeper().heldLeaseIds()).toEqual([]);
    expect(calls).toEqual([{ cmd: 'lease_release', params: { all: true } }]);
    stopped.mockRestore();
  });

  it('lease_release needs exactly one of lease_id, ticket or all', async () => {
    const calls = t7Editor();
    for (const bad of [
      {},
      { lease_id: A, all: true },
      { ticket: TICKET, lease_id: A },
      { ticket: TICKET, all: true },
      { token: A, all: true },
    ]) {
      const r = await t7Tool('lease_release')(bad);
      expect(r.isError).toBe(true);
      expect(r.content[0]!.text).toContain('[bad_request]');
    }
    const marker = await t7Tool('lease_release')({ lease_id: '[REDACTED:token]' });
    expect(marker.isError).toBe(true);
    expect(marker.content[0]!.text).toContain('[lease_id_redacted]');
    expect(calls).toEqual([]);
  });

  it('lease_release of a ticket sends ticket', async () => {
    const calls = t7Editor({ released: true });
    await t7Tool('lease_release')({ ticket: 'lq_7_0123456789ab' });
    expect(calls).toEqual([{ cmd: 'lease_release', params: { ticket: 'lq_7_0123456789ab' } }]);
  });
});


describe('lease lifetime compatibility (T7)', () => {
  it('acquire renews with the server-clamped TTL', async () => {
    const editor = fakeEditor(({ cmd }) => ({
      ok: true,
      data: cmd === 'lease_acquire' ? { status: 'granted', lease_id: A, ttl_s: 5 } : { renewed: true },
    }));
    setDefaultSender(editor.send);
    const interval = vi.spyOn(globalThis, 'setInterval');
    try {
      await tool('lease_acquire')({ resources: ['global'], ttl_s: 900 });
      expect(interval).toHaveBeenLastCalledWith(expect.any(Function), 1_666);
      await getLeaseKeeper().renewNow(A);
      expect(editor.calls.at(-1)).toEqual({ cmd: 'lease_renew', params: { lease_id: A, ttl_s: 5 } });
    } finally {
      interval.mockRestore();
    }
  });

  it('trims matching canonical and alias IDs and preserves ticket aliases', async () => {
    const editor = fakeEditor(() => ({ ok: true, data: {} }));
    setDefaultSender(editor.send);
    await tool('lease_renew')({ lease_id: ` ${A} `, token: A });
    await tool('lease_release')({ token: ` ${TICKET} ` });
    expect(editor.calls).toEqual([
      { cmd: 'lease_renew', params: { lease_id: A } },
      { cmd: 'lease_release', params: { ticket: TICKET } },
    ]);
  });

  it('owner renew with a padded deprecated marker forwards TTL and adopts no returned IDs', async () => {
    const editor = fakeEditor(() => ({ ok: true, data: { renewed: 1, leases: [{ lease_id: A }] } }));
    setDefaultSender(editor.send);
    await tool('lease_renew')({ token: ' [REDACTED:token] ', ttl_s: 300 });
    expect(editor.calls).toEqual([{ cmd: 'lease_renew', params: { ttl_s: 300 } }]);
    expect(getLeaseKeeper().heldLeaseIds()).toEqual([]);
  });

  it('never turns a conflicting canonical ID and alias marker into owner renewal', async () => {
    const editor = fakeEditor(() => ({ ok: true, data: {} }));
    setDefaultSender(editor.send);
    const result = await tool('lease_renew')({ lease_id: A, token: '[REDACTED:token]' });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain(LEASE_ID_MESSAGES.ambiguous('lease_renew'));
    expect(editor.calls).toEqual([]);
  });
});
