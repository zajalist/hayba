import { describe, expect, it, vi } from 'vitest';
import { executeCommand, UeToolError, type Sender } from './tool-executor.js';
import type { TcpResponse } from '../tcp-client.js';

// Top-level refusal codes from the editor (P0 spec §4.2). Each task appends one
// describe block here; tool-executor.test.ts is off limits (R11).
const replying = (resp: Omit<TcpResponse, 'id'>) => vi.fn<Sender>(async () => ({ id: 'refusal', ...resp }));

describe('T1: editor_unsafe codes (ADR-0011)', () => {
  const health = {
    editor_unsafe: true,
    python_unhealthy: true,
    restart_required: true,
    cause: 'python_native_fault',
    fault_code: 'HCR-NATIVE-002',
  };

  it.each([
    ['editor_unsafe_restart_required', 'policy_blocked'],
    ['native_fault_contained', 'session_suspect'],
  ] as const)('maps %s to a typed error and never retries it', async (code, state) => {
    const sender = replying({
      ok: false,
      code,
      error: `${code}: 'blueprint_get_info' …`,
      editor_health: health,
      advisory: { state, session_health: 'restart_required' },
    });
    const error = await executeCommand('blueprint_get_info', { path: '/Game/BP' }, { sender }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UeToolError);
    expect((error as UeToolError).code).toBe(code);
    const payload = (error as UeToolError).uePayload as TcpResponse;
    expect(payload.editor_health).toEqual(health);
    expect(payload.advisory?.session_health).toBe('restart_required');
    expect(sender).toHaveBeenCalledTimes(1);
  });

  it('still maps an unknown code to ue_error', async () => {
    const sender = replying({ ok: false, code: 'something_new', error: 'x' });
    const error = await executeCommand('ping', {}, { sender }).catch((e: unknown) => e);
    expect((error as UeToolError).code).toBe('ue_error');
  });
});
