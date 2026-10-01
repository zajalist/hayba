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

// ---------------------------------------------------------------------------
// P0 T3: asset_busy (router slot 3) and the Advisory state_warning.
// Imports are lazy so this block only appends to the file.
// ---------------------------------------------------------------------------
describe('asset_busy (P0 T3)', () => {
  const busy = {
    command: 'editor_start_pie',
    caller_owner: 'lane5',
    assets: [
      {
        asset: '/game/__haybatest__/bp_busy',
        owner: 'builder',
        label: 'build:bpgraph_7',
        lane: 'long',
        held_s: 12,
        since: '2026-09-28T11:59:48.000Z',
        expires_in_s: 108,
      },
    ],
  };

  it('keeps asset_busy as its own code with the busy detail, and sends once', async () => {
    const { executeCommand, UeToolError } = await import('./tool-executor.js');
    let sends = 0;
    const err: unknown = await executeCommand('editor_start_pie', {}, {
      sender: async () => {
        sends += 1;
        return {
          id: 'busy-1',
          ok: false,
          code: 'asset_busy',
          error:
            "asset_busy: 'editor_start_pie' is refused: /game/__haybatest__/bp_busy is being built by 'builder' " +
            '(label build:bpgraph_7, held 12 s, lease expires in 108 s). PIE/compile would use it half-built. ' +
            'Nothing ran; try again when editor_get_state.building no longer lists it.',
          busy,
        };
      },
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UeToolError);
    expect(err).toMatchObject({ code: 'asset_busy' });
    expect((err as { uePayload: { busy?: unknown } }).uePayload.busy).toEqual(busy);
    expect(sends).toBe(1);
  });

  it('surfaces state_warning beside lease_warning when the command ran under Advisory', async () => {
    const { executeCommand } = await import('./tool-executor.js');
    const state_warning = { code: 'asset_busy', busy: { ...busy, command: 'blueprint_compile' } };
    const lease_warning = { code: 'lease_conflict', reason: 'held', holder_owner: 'builder' };
    await expect(
      executeCommand('blueprint_compile', { path: '/Game/__HaybaTest__/BP_Busy' }, {
        sender: async () => ({ id: 'busy-2', ok: true, data: { compiled_clean: true }, lease_warning, state_warning }),
      }),
    ).resolves.toEqual({ compiled_clean: true, lease_warning, state_warning });
  });

  it('surfaces state_warning on its own', async () => {
    const { executeCommand } = await import('./tool-executor.js');
    const state_warning = { code: 'asset_busy', busy };
    await expect(
      executeCommand('ui_save_widget', { widget_blueprint_path: '/Game/UI/WBP_Menu' }, {
        sender: async () => ({ id: 'busy-3', ok: true, data: { saved: true }, state_warning }),
      }),
    ).resolves.toEqual({ saved: true, state_warning });
  });

  it('types busy and state_warning on TcpResponse and never carries a handle', () => {
    const reply: import('../tcp-client.js').TcpResponse = {
      id: 'busy-4',
      ok: false,
      code: 'asset_busy',
      busy,
      state_warning: { code: 'asset_busy', busy },
    };
    expect(reply.busy).toEqual(busy);
    expect(Object.keys(busy.assets[0]!).some((k) => /token|lease_id/.test(k))).toBe(false);
  });
});

describe('T5: package_read_only', () => {
  it('is a known UE code, promoted from the handler preflight', async () => {
    const { executeCommand } = await import('./tool-executor.js');
    const reply = {
      id: 'x',
      ok: false,
      code: 'package_read_only',
      error: 'level_save [package_read_only]: /Game/Maps/Valley cannot be saved: Content/Maps/Valley.umap is read-only on disk. Nothing was changed.',
      data: { ok: false, code: 'package_read_only', make_writable_hint: 'Take its source-control lock and retry: git lfs lock "Content/Maps/Valley.umap"' },
    };
    await expect(executeCommand('level_save', {}, { sender: async () => reply })).rejects.toMatchObject({
      name: 'UeToolError',
      code: 'package_read_only',
    });
  });
});

describe('T8: owner_required', () => {
  it('maps owner_required to its own code and keeps the lease detail', async () => {
    const send: Sender = async () => ({
      id: 'x',
      ok: false,
      code: 'owner_required',
      error:
        "owner_required: 'blueprint_add_node' (write_scoped) names no owner while 2 other agents are connected (lane-3, node-4312-a1b2c3). Send the envelope 'owner' (HAYBA_AGENT_ID) or a valid lease handle, then retry.",
      lease: { code: 'owner_required', enforcement: 'enforced_for_writes', reason: 'owner_missing', other_owners: ['lane-3', 'node-4312-a1b2c3'] },
    });
    const err = (await executeCommand('blueprint_add_node', {}, { sender: send }).catch((e: unknown) => e)) as {
      name: string;
      code: string;
      uePayload: { lease?: Record<string, unknown> };
    };
    expect(err).toMatchObject({ name: 'UeToolError', code: 'owner_required' });
    expect(err.uePayload.lease).toMatchObject({ reason: 'owner_missing' });
  });
});
