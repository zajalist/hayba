import { describe, it, expect } from 'vitest';
import { UeToolError } from './tool-executor.js';

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
