import { describe, it, expect, vi, beforeEach } from 'vitest';
import { z } from 'zod';
import { recordSchema } from '../../schema-registry.js';
import { invokeHandler, UE_LEGACY_ALLOWLIST } from './invoke.js';
import { IdempotencyLedger } from '../idempotency-ledger.js';

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

  it('rejects unknown argument names and lists the accepted params', async () => {
    // zod's default strip mode used to silently DELETE a misnamed key here and
    // dispatch the rest — the tool then "ignored its parameter" (test_list
    // {filter}, editor_pie_screenshot {path}, ui_set_slot_layout {anchors}).
    const dispatch = vi.fn();
    const res = await invokeHandler({ name: 'echo_tool', args: { msg: 'hi', mesage: 'oops' } }, {
      dispatch, isDisabled: () => false,
    });
    expect(res.ok).toBe(false);
    if (!res.ok && res.error.kind === 'validation') {
      expect(JSON.stringify(res.error.issues)).toContain('mesage');
      expect(res.error.accepted_params).toEqual(['msg']);
    }
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('refuses disabled tools', async () => {
    const res = await invokeHandler({ name: 'echo_tool', args: { msg: 'hi' } }, {
      dispatch: vi.fn(), isDisabled: () => true,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.kind).toBe('tool_disabled');
  });

  describe('principal-scoped idempotency', () => {
    it('fails closed without SDK-authenticated principal context and never dispatches', async () => {
      const dispatch = vi.fn();
      const res = await invokeHandler(
        { name: 'echo_tool', args: { msg: 'hi' }, idempotency_key: 'outside-tool-params' },
        { dispatch, isDisabled: () => false, idempotency: { ledger: new IdempotencyLedger() } },
      );
      expect(res).toMatchObject({
        ok: false,
        error: {
          kind: 'idempotency_unavailable',
          scope: 'process_lifetime',
        },
      });
      expect(JSON.stringify(res)).toContain('authenticated MCP principal');
      expect(JSON.stringify(res)).toContain('#379');
      expect(JSON.stringify(res)).not.toContain('outside-tool-params');
      expect(dispatch).not.toHaveBeenCalled();
    });

    it('deduplicates verified calls after validation without forwarding the envelope key', async () => {
      const ledger = new IdempotencyLedger();
      const dispatch = vi.fn(async (_cmd: string, params: Record<string, unknown>) => ({
        echoed: params.msg,
        advisory: { state: 'success' },
      }));
      const ctx = {
        dispatch,
        isDisabled: () => false,
        idempotency: { ledger, authenticatedPrincipal: 'resource\0authenticated-client' },
      };
      const envelope = { name: 'echo_tool', args: { msg: 'hi' }, idempotency_key: 'retry-7' };
      const first = await invokeHandler(envelope, ctx);
      const replay = await invokeHandler(envelope, ctx);

      expect(replay).toEqual(first);
      expect(dispatch).toHaveBeenCalledTimes(1);
      expect(dispatch).toHaveBeenCalledWith('echo_tool', { msg: 'hi' });
      expect(JSON.stringify(dispatch.mock.calls)).not.toContain('retry-7');
    });

    it('returns a stable secret-safe conflict for changed validated params', async () => {
      const ledger = new IdempotencyLedger();
      const ctx = {
        dispatch: vi.fn(async () => ({ advisory: { state: 'success' } })),
        isDisabled: () => false,
        idempotency: { ledger, authenticatedPrincipal: 'authenticated-client' },
      };
      await invokeHandler(
        { name: 'echo_tool', args: { msg: 'first-secret' }, idempotency_key: 'raw-secret-key' },
        ctx,
      );
      const conflict = await invokeHandler(
        { name: 'echo_tool', args: { msg: 'changed-secret' }, idempotency_key: 'raw-secret-key' },
        ctx,
      );
      expect(conflict).toMatchObject({ ok: false, error: { kind: 'idempotency_conflict' } });
      const json = JSON.stringify(conflict);
      expect(json).not.toContain('raw-secret-key');
      expect(json).not.toContain('first-secret');
      expect(json).not.toContain('changed-secret');
    });

    it('does not replay a result that still needs verification', async () => {
      const ledger = new IdempotencyLedger();
      const dispatch = vi.fn(async () => ({ advisory: { state: 'success_needs_verification' } }));
      const ctx = {
        dispatch,
        isDisabled: () => false,
        idempotency: { ledger, authenticatedPrincipal: 'authenticated-client' },
      };
      const envelope = { name: 'echo_tool', args: { msg: 'hi' }, idempotency_key: 'retry-8' };
      await invokeHandler(envelope, ctx);
      await invokeHandler(envelope, ctx);
      expect(dispatch).toHaveBeenCalledTimes(2);
    });
  });

  it('returns unknown_tool when no schema recorded', async () => {
    const res = await invokeHandler({ name: 'nonexistent', args: {} }, {
      dispatch: vi.fn(), isDisabled: () => false,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.kind).toBe('unknown_tool');
  });

  describe('via: "ue_legacy" fallthrough', () => {
    it('dispatches allowlisted commands directly via dispatchLegacy', async () => {
      const dispatchLegacy = vi.fn(async (_cmd: string, _args: Record<string, unknown>) => ({ actorLabel: 'Hayba_Terrain' }));
      const dispatch = vi.fn(); // should NOT be called
      const res = await invokeHandler(
        { name: 'landscape_import', args: { heightmapPath: 'D:/h.png' }, via: 'ue_legacy' },
        { dispatch, dispatchLegacy, isDisabled: () => false },
      );
      expect(res.ok).toBe(true);
      if (res.ok) expect(res.result).toEqual({ actorLabel: 'Hayba_Terrain' });
      expect(dispatchLegacy).toHaveBeenCalledWith('landscape_import', { heightmapPath: 'D:/h.png' });
      expect(dispatch).not.toHaveBeenCalled();
    });

    it('falls back to dispatch when dispatchLegacy is not provided', async () => {
      const dispatch = vi.fn(async () => ({ ok: true }));
      const res = await invokeHandler(
        { name: 'pcg_create_graph', args: { assetPath: '/Game/Foo' }, via: 'ue_legacy' },
        { dispatch, isDisabled: () => false },
      );
      expect(res.ok).toBe(true);
      expect(dispatch).toHaveBeenCalledWith('pcg_create_graph', { assetPath: '/Game/Foo' });
    });

    it('rejects non-allowlisted commands with legacy_not_allowlisted', async () => {
      const dispatchLegacy = vi.fn();
      const res = await invokeHandler(
        { name: 'rm_rf_everything', args: {}, via: 'ue_legacy' },
        { dispatch: vi.fn(), dispatchLegacy, isDisabled: () => false },
      );
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.kind).toBe('legacy_not_allowlisted');
        if (res.error.kind === 'legacy_not_allowlisted') {
          expect(res.error.name).toBe('rm_rf_everything');
        }
      }
      expect(dispatchLegacy).not.toHaveBeenCalled();
    });

    it('still honours isDisabled even on the legacy route', async () => {
      const res = await invokeHandler(
        { name: 'landscape_import', args: {}, via: 'ue_legacy' },
        { dispatch: vi.fn(), dispatchLegacy: vi.fn(), isDisabled: () => true },
      );
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error.kind).toBe('tool_disabled');
    });

    it('allowlist covers the postmortem-named legacy commands', () => {
      for (const cmd of [
        'landscape_import',
        'describe_assets',
        'pcg_create_graph',
        'pcg_execute_graph',
        'pcg_export_graph',
        'pcg_list_assets',
        'pcg_validate_graph',
        'pcg_read_node_output',
      ]) {
        expect(UE_LEGACY_ALLOWLIST.has(cmd)).toBe(true);
      }
    });

    it('rejects an agent_callable:false sidecar entry (e.g. ping)', async () => {
      // ping is in the sidecar but marked agent_callable:false because
      // it's a discovery handshake, not an agent-driven tool.
      const dispatch = vi.fn();
      const res = await invokeHandler(
        { name: 'ping', args: {}, via: 'ue_legacy' },
        { dispatch, isDisabled: () => false },
      );
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error.kind).toBe('legacy_not_allowlisted');
      expect(dispatch).not.toHaveBeenCalled();
    });
  });
});
