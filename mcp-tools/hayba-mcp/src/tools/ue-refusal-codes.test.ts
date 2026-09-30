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

describe('T2: PIE refusal codes', () => {
  const pieDetail = {
    pie: 'agent:lane3',
    phase: 'queued',
    simulating: false,
    since_s: 0,
    command: 'editor_pie_press_key',
    caller_owner: 'lane5',
    rule: 'pie_owner',
  };

  it.each(['pie_active', 'pie_blocked'] as const)('%s maps to its own code and is sent once', async (code) => {
    let calls = 0;
    const sender: Sender = async () => {
      calls += 1;
      return { id: 't', ok: false, code, error: `${code}: refused; nothing ran`, pie: pieDetail };
    };
    const err = await executeCommand('blueprint_add_node', {}, { sender }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UeToolError);
    expect((err as UeToolError).code).toBe(code);
    expect(calls).toBe(1);
  });

  it('keeps the pie detail on the payload', async () => {
    const sender: Sender = async () => ({ id: 't', ok: false, code: 'pie_active', error: 'pie_active: refused', pie: pieDetail });
    const err = (await executeCommand('editor_pie_press_key', {}, { sender }).catch((e: unknown) => e)) as UeToolError;
    expect((err.uePayload as TcpResponse).pie).toEqual(pieDetail);
  });

  it('pie_blocked keeps the blocked Blueprints in data', async () => {
    const data = { ok: false, code: 'pie_blocked', blocked_assets: [{ asset: '/Game/BP_A.BP_A', status: 'errored' }], blocked_count: 1 };
    const sender: Sender = async () => ({
      id: 't',
      ok: false,
      code: 'pie_blocked',
      error: "pie_blocked: 'editor_start_pie' was not run: 1 Blueprint(s) would open a modal dialog before play (/Game/BP_A.BP_A is errored). Compile or fix them first.",
      data,
    });
    const err = (await executeCommand('editor_start_pie', {}, { sender }).catch((e: unknown) => e)) as UeToolError;
    expect(err.code).toBe('pie_blocked');
    expect((err.uePayload as TcpResponse).data).toEqual(data);
  });
});
