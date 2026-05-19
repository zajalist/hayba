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
