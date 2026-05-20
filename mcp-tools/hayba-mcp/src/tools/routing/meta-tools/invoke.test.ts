import { describe, it, expect, vi, beforeEach } from 'vitest';
import { z } from 'zod';
import { recordSchema } from '../../schema-registry.js';
import { invokeHandler } from './invoke.js';

describe('hayba_invoke', () => {
  beforeEach(() => {
    recordSchema('echo_tool', { shape: { msg: z.string() }, cost: 'low', returns: 'string' });
  });

  it('validates args via recorded zod schema and dispatches', async () => {
    const fakeDispatch = vi.fn(async (_cmd: string, args: Record<string, unknown>) => ({ echoed: args.msg }));
    const res = await invokeHandler({ name: 'echo_tool', args: { msg: 'hi' } }, {
      dispatch: fakeDispatch, isDisabled: () => false,
    });
    expect(res).toEqual({ ok: true, result: { echoed: 'hi' } });
    expect(fakeDispatch).toHaveBeenCalledWith('echo_tool', { msg: 'hi' });
  });

  it('returns validation error on bad args', async () => {
    const res = await invokeHandler({ name: 'echo_tool', args: { msg: 123 } }, {
      dispatch: vi.fn(), isDisabled: () => false,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.kind).toBe('validation');
  });

  it('refuses disabled tools', async () => {
    const res = await invokeHandler({ name: 'echo_tool', args: { msg: 'hi' } }, {
      dispatch: vi.fn(), isDisabled: () => true,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.kind).toBe('tool_disabled');
  });

  it('returns unknown_tool when no schema recorded', async () => {
    const res = await invokeHandler({ name: 'nonexistent', args: {} }, {
      dispatch: vi.fn(), isDisabled: () => false,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.kind).toBe('unknown_tool');
  });
});
