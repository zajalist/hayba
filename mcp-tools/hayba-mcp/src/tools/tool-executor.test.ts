import { describe, it, expect } from 'vitest';
import { UeToolError, costToTimeoutMs, executeCommand, type Sender } from './tool-executor.js';
import type { TcpResponse } from '../tcp-client.js';
import { registerToolMeta, resetToolMetaRegistry } from './tool-meta-registry.js';

describe('UeToolError', () => {
  it('carries a code discriminator and optional uePayload', () => {
    const e = new UeToolError('boom', { code: 'plan_gate', uePayload: { reason: 'destructive' } });
    expect(e).toBeInstanceOf(Error);
    expect(e).toBeInstanceOf(UeToolError);
    expect(e.message).toBe('boom');
    expect(e.code).toBe('plan_gate');
    expect(e.uePayload).toEqual({ reason: 'destructive' });
    expect(e.name).toBe('UeToolError');
  });

  it('defaults uePayload to undefined', () => {
    const e = new UeToolError('x', { code: 'ue_error' });
    expect(e.uePayload).toBeUndefined();
  });
});

describe('costToTimeoutMs', () => {
  it('maps low/medium/high to 2s/10s/60s', () => {
    expect(costToTimeoutMs('low')).toBe(2_000);
    expect(costToTimeoutMs('medium')).toBe(10_000);
    expect(costToTimeoutMs('high')).toBe(60_000);
  });
  it('defaults to medium for unknown cost', () => {
    expect(costToTimeoutMs(undefined)).toBe(10_000);
    // @ts-expect-error — runtime safety for bad input
    expect(costToTimeoutMs('garbage')).toBe(10_000);
  });
});

const okSender: Sender = async (cmd, params, _timeout) => ({
  id: 't',
  ok: true,
  data: { echoed: { cmd, params } },
});

describe('executeCommand — happy path', () => {
  it('returns response.data object on ok:true', async () => {
    const data = await executeCommand('actor_list', { tag: 'x' }, { sender: okSender });
    expect(data).toEqual({ echoed: { cmd: 'actor_list', params: { tag: 'x' } } });
  });

  it('passes timeout-from-cost to the sender when meta is registered', async () => {
    const seen: number[] = [];
    const spy: Sender = async (_c, _p, t) => { seen.push(t); return { id: 't', ok: true, data: {} }; };
    resetToolMetaRegistry();
    registerToolMeta('build_project', { cost: 'high', effects: [], when: '', not_when: '' });
    await executeCommand('build_project', {}, { sender: spy });
    expect(seen[0]).toBe(60_000);
  });

  it('defaults timeout to medium (10s) when meta is missing', async () => {
    resetToolMetaRegistry();
    const seen: number[] = [];
    const spy: Sender = async (_c, _p, t) => { seen.push(t); return { id: 't', ok: true, data: {} }; };
    await executeCommand('unknown', {}, { sender: spy });
    expect(seen[0]).toBe(10_000);
  });

  it('honors an explicit opts.timeout override', async () => {
    const seen: number[] = [];
    const spy: Sender = async (_c, _p, t) => { seen.push(t); return { id: 't', ok: true, data: {} }; };
    await executeCommand('x', {}, { sender: spy, timeout: 1234 });
    expect(seen[0]).toBe(1234);
  });
});

describe('executeCommand — error code mapping', () => {
  it('throws UeToolError with code "plan_gate" when UE response carries that code', async () => {
    const sender: Sender = async () => ({ id: 't', ok: false, error: 'needs approval', code: 'plan_gate' });
    await expect(executeCommand('actor_delete', {}, { sender }))
      .rejects.toMatchObject({ name: 'UeToolError', code: 'plan_gate', message: 'needs approval' });
  });

  it('throws UeToolError with code "tool_disabled" likewise', async () => {
    const sender: Sender = async () => ({ id: 't', ok: false, error: 'off', code: 'tool_disabled' });
    await expect(executeCommand('x', {}, { sender }))
      .rejects.toMatchObject({ code: 'tool_disabled' });
  });

  it('defaults to "ue_error" when response has ok:false but no code', async () => {
    const sender: Sender = async () => ({ id: 't', ok: false, error: 'something' });
    await expect(executeCommand('x', {}, { sender }))
      .rejects.toMatchObject({ code: 'ue_error', message: 'something' });
  });

  it('passes through unrecognised codes as "ue_error" but preserves UE payload', async () => {
    const sender: Sender = async () => ({ id: 't', ok: false, error: 'novel', code: 'something_new' });
    try {
      await executeCommand('x', {}, { sender });
      throw new Error('should have thrown');
    } catch (e: unknown) {
      const u = e as InstanceType<typeof UeToolError>;
      expect(u.code).toBe('ue_error');
      expect((u.uePayload as TcpResponse).code).toBe('something_new');
    }
  });
});

describe('executeCommand — transport retry', () => {
  it('retries once when sender throws (transport failure)', async () => {
    let attempts = 0;
    const flaky: Sender = async () => {
      attempts++;
      if (attempts === 1) throw new Error('ECONNRESET');
      return { id: 't', ok: true, data: { attempts } };
    };
    const data = await executeCommand<{ attempts: number }>('x', {}, { sender: flaky });
    expect(data.attempts).toBe(2);
  });

  it('throws UeToolError with code "transport" after retry budget exhausted', async () => {
    const always: Sender = async () => { throw new Error('ECONNRESET'); };
    await expect(executeCommand('x', {}, { sender: always }))
      .rejects.toMatchObject({ name: 'UeToolError', code: 'transport' });
  });

  it('does NOT retry on UE error responses (ok:false)', async () => {
    let attempts = 0;
    const sender: Sender = async () => {
      attempts++;
      return { id: 't', ok: false, error: 'no' };
    };
    await expect(executeCommand('x', {}, { sender })).rejects.toMatchObject({ code: 'ue_error' });
    expect(attempts).toBe(1);
  });
});

import { InMemoryToolExecutor } from './tool-executor.js';

describe('InMemoryToolExecutor', () => {
  it('returns canned ok responses', async () => {
    const exec = new InMemoryToolExecutor();
    exec.on('actor_list', () => ({ ok: true, data: { actors: [], count: 0 } }));
    const data = await executeCommand<{ count: number }>('actor_list', {}, { sender: exec.send });
    expect(data.count).toBe(0);
  });
  it('returns canned ok:false with code', async () => {
    const exec = new InMemoryToolExecutor();
    exec.on('x', () => ({ ok: false, error: 'nope', code: 'plan_gate' }));
    await expect(executeCommand('x', {}, { sender: exec.send }))
      .rejects.toMatchObject({ code: 'plan_gate' });
  });
  it('throws "no handler registered" when called for an unregistered command', async () => {
    const exec = new InMemoryToolExecutor();
    await expect(executeCommand('missing', {}, { sender: exec.send }))
      .rejects.toMatchObject({ code: 'transport' }); // sender throws => retry once also throws => mapped to transport
  });
});
