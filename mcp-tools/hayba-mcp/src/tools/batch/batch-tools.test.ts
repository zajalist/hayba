/**
 * editor_batch / batch_status, Node side: argument validation, which lease a
 * batch runs under, the no-retry rule and batch_status polling. Everything runs
 * against a fake sender; nothing opens a socket. The editor-side state machine
 * is covered by the native Hayba.MCP.Batch.* tests.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { _resetLeaseKeeperForTesting, getLeaseKeeper } from '../../lease-keeper.js';
import type { TcpResponse } from '../../tcp-client.js';
import { NON_IDEMPOTENT, setDefaultSender, type Sender } from '../tool-executor.js';
import { BATCH_DESCRIPTORS, handleBatchStatus, resolveBatchLease } from './batch-tools.js';

vi.mock('../heavy-op-probe.js', () => ({ probeEditorProcess: async () => null }));

type Call = { cmd: string; params: Record<string, unknown> };

function fakeEditor(answer: (call: Call, n: number) => Omit<TcpResponse, 'id'> | Error) {
  const calls: Call[] = [];
  const send: Sender = async (cmd, params) => {
    calls.push({ cmd, params });
    const reply = answer({ cmd, params }, calls.length);
    if (reply instanceof Error) throw reply;
    return { id: 'fake', ...reply };
  };
  return { calls, send };
}

type ToolResult = { content: Array<{ text: string }>; isError?: boolean };

function tool(name: string) {
  const d = BATCH_DESCRIPTORS.find((t) => t.name === name);
  if (!d) throw new Error(`no descriptor ${name}`);
  return d.handler as unknown as (args: unknown) => Promise<ToolResult>;
}

const body = (r: ToolResult) => JSON.parse(r.content[0]!.text) as Record<string, unknown>;

afterEach(() => {
  _resetLeaseKeeperForTesting();
});

describe('editor_batch', () => {
  it('forwards the steps and sends the lease as lease_id', async () => {
    const editor = fakeEditor(() => ({ ok: true, data: { job_id: 'job-1', status: 'running', steps_total: 3 } }));
    setDefaultSender(editor.send);
    const steps = [
      { cmd: 'wp_region_load', params: { bounds: [0, 0, 25600, 25600], name: 'west' }, fence_after: 'gc' },
      { cmd: 'actor_set_transform', params: { actor: '/Game/Maps/Valley.Valley:PersistentLevel.Tree_3' } },
      { cmd: 'wp_region_unload', params: { name: 'west' }, fence_after: 'gc' },
    ];
    const r = await tool('editor_batch')({ lease_id: 'ls_4_aad6bc3c3546', steps, on_error: 'unload_then_stop' });
    expect(r.isError).toBeUndefined();
    expect(body(r)).toMatchObject({ job_id: 'job-1', status: 'running' });
    expect(editor.calls).toEqual([
      { cmd: 'editor_batch', params: { lease_id: 'ls_4_aad6bc3c3546', steps, on_error: 'unload_then_stop' } },
    ]);
  });

  it('accepts the permanent lease param and sends it as lease_id', async () => {
    const editor = fakeEditor(() => ({ ok: true, data: { job_id: 'job-3', status: 'running' } }));
    setDefaultSender(editor.send);
    await tool('editor_batch')({ lease: 'ls_5_aad6bc3c3546', steps: [{ cmd: 'level_save' }] });
    expect(editor.calls[0]!.params).toEqual({ lease_id: 'ls_5_aad6bc3c3546', steps: [{ cmd: 'level_save' }] });
  });

  it('refuses lease_id and lease that name different leases, without contacting the editor', async () => {
    const editor = fakeEditor(() => ({ ok: true, data: {} }));
    setDefaultSender(editor.send);
    const r = await tool('editor_batch')({ lease_id: 'ls_1_aad6bc3c3546', lease: 'ls_2_b30995e71074', steps: [{ cmd: 'level_save' }] });
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toContain('editor_batch [lease_id_ambiguous]');
    expect(editor.calls).toEqual([]);
  });

  it('uses the single lease this server holds when none is named', async () => {
    const editor = fakeEditor(() => ({ ok: true, data: { job_id: 'job-2', status: 'running' } }));
    setDefaultSender(editor.send);
    getLeaseKeeper().track('ls_7_aad6bc3c3546', 120);
    await tool('editor_batch')({ steps: [{ cmd: 'level_save' }] });
    expect(editor.calls[0]!.params.lease_id).toBe('ls_7_aad6bc3c3546');
    expect(editor.calls[0]!.params).not.toHaveProperty('lease');
  });

  it('refuses without a lease, and when the lease is ambiguous, without contacting the editor', async () => {
    const editor = fakeEditor(() => ({ ok: true, data: {} }));
    setDefaultSender(editor.send);
    const none = await tool('editor_batch')({ steps: [{ cmd: 'level_save' }] });
    expect(none.isError).toBe(true);
    expect(String(body(none).error)).toContain('lease_acquire');

    getLeaseKeeper().track('ls_1_aaaaaaaaaaaa', 60);
    getLeaseKeeper().track('ls_2_bbbbbbbbbbbb', 60);
    const two = await tool('editor_batch')({ steps: [{ cmd: 'level_save' }] });
    expect(two.isError).toBe(true);
    expect(String(body(two).error)).toContain('2 leases');
    expect(editor.calls).toEqual([]);
  });

  it.each([
    ['no steps', { lease: 'l', steps: [] }],
    ['too many steps', { lease: 'l', steps: Array.from({ length: 65 }, () => ({ cmd: 'level_save' })) }],
    ['an unknown fence', { lease: 'l', steps: [{ cmd: 'level_save', fence_after: 'forever' }] }],
    ['an unknown on_error', { lease: 'l', steps: [{ cmd: 'level_save' }], on_error: 'retry' }],
    ['a region load without bounds', { lease: 'l', steps: [{ cmd: 'wp_region_load', params: { name: 'x' } }] }],
    ['a region load with three numbers', { lease: 'l', steps: [{ cmd: 'wp_region_load', params: { bounds: [0, 0, 1] } }] }],
    ['a nested batch', { lease: 'l', steps: [{ cmd: 'editor_batch' }] }],
    ['releasing the lease mid-batch', { lease: 'l', steps: [{ cmd: 'lease_release', params: { token: 'l' } }] }],
    ['an unknown field', { lease: 'l', steps: [{ cmd: 'level_save' }], parallel: true }],
  ])('rejects %s before contacting the editor', async (_label, args) => {
    const editor = fakeEditor(() => ({ ok: true, data: {} }));
    setDefaultSender(editor.send);
    const r = await tool('editor_batch')(args);
    expect(r.isError).toBe(true);
    expect(editor.calls).toEqual([]);
  });

  it('accepts {min, max} bounds as pairs or points', async () => {
    const editor = fakeEditor(() => ({ ok: true, data: { job_id: 'j', status: 'running' } }));
    setDefaultSender(editor.send);
    const r = await tool('editor_batch')({
      lease: 'l',
      steps: [
        { cmd: 'wp_region_load', params: { bounds: { min: [0, 0], max: [10, 10] } } },
        { cmd: 'wp_region_load', params: { bounds: { min: { x: 20, y: 20 }, max: { x: 30, y: 30 } } } },
      ],
    });
    expect(r.isError).toBeUndefined();
    expect(editor.calls).toHaveLength(1);
  });

  it('is never auto-retried after a transport failure: a resend would run the steps twice', async () => {
    expect(NON_IDEMPOTENT.has('editor_batch')).toBe(true);
    expect(NON_IDEMPOTENT.has('batch_status')).toBe(false);
    const editor = fakeEditor(() => new Error('socket hang up'));
    setDefaultSender(editor.send);
    await expect(tool('editor_batch')({ lease: 'l', steps: [{ cmd: 'level_save' }] })).rejects.toThrow();
    expect(editor.calls).toHaveLength(1);
  });
});

describe('batch_status', () => {
  it('answers at once by default', async () => {
    const editor = fakeEditor(() => ({ ok: true, data: { job_id: 'j', status: 'running', phase: 'fence', busy: 'shaders' } }));
    setDefaultSender(editor.send);
    const r = await tool('batch_status')({ job_id: 'j' });
    expect(body(r)).toMatchObject({ status: 'running', busy: 'shaders' });
    expect(editor.calls).toEqual([{ cmd: 'batch_status', params: { job_id: 'j' } }]);
  });

  it('with wait_s polls until the batch is done', async () => {
    const editor = fakeEditor((_c, n) => ({
      ok: true,
      data: n < 3 ? { job_id: 'j', status: 'running' } : { job_id: 'j', status: 'succeeded', steps_run: 2 },
    }));
    setDefaultSender(editor.send);
    let t = 0;
    const r = await handleBatchStatus(
      { job_id: 'j', wait_s: 30 },
      { now: () => t, sleep: async (ms) => void (t += ms) },
    );
    expect(body(r as ToolResult)).toMatchObject({ status: 'succeeded' });
    expect(editor.calls).toHaveLength(3);
  });

  it('with wait_s gives up at the deadline and returns the running status', async () => {
    const editor = fakeEditor(() => ({ ok: true, data: { job_id: 'j', status: 'running' } }));
    setDefaultSender(editor.send);
    let t = 0;
    const r = await handleBatchStatus(
      { job_id: 'j', wait_s: 3 },
      { now: () => t, sleep: async (ms) => void (t += ms) },
    );
    expect(body(r as ToolResult)).toMatchObject({ status: 'running' });
    expect(editor.calls.length).toBe(4);
  });

  it('rejects a missing job id', async () => {
    const editor = fakeEditor(() => ({ ok: true, data: {} }));
    setDefaultSender(editor.send);
    const r = await tool('batch_status')({});
    expect(r.isError).toBe(true);
    expect(editor.calls).toEqual([]);
  });
});

describe('resolveBatchLease', () => {
  it('prefers the explicit token', () => {
    expect(resolveBatchLease('x', ['a', 'b'])).toEqual({ lease: 'x' });
  });
  it('falls back to the one held lease', () => {
    expect(resolveBatchLease(undefined, ['a'])).toEqual({ lease: 'a' });
  });
  it('explains what to do otherwise', () => {
    expect(resolveBatchLease(undefined, []).error).toContain('lease_acquire');
    expect(resolveBatchLease(undefined, ['a', 'b']).error).toContain('2 leases');
  });
});
