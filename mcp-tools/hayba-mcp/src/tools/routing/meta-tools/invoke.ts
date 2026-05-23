import { z, type ZodRawShape } from 'zod';
import { getRawShape } from '../../schema-registry.js';

/**
 * Legacy UE commands that are safe to call via `hayba_invoke({ via: 'ue_legacy' })`.
 *
 * These are dispatched directly to the UE plugin via the TCP bridge, bypassing
 * the TS captured-tools map. Add a command here only when it is known to be
 * game-thread-safe (or marshals to the game thread internally) and has stable
 * params. See the postmortem at
 * `docs/superpowers/specs/2026-05-23-pcg-landscape-mcp-postmortem.md` §3.3.
 */
export const UE_LEGACY_ALLOWLIST = new Set<string>([
  'landscape_import',
  'describe_assets',
  'pcg_create_graph',
  'pcg_execute_graph',
  'pcg_export_graph',
  'pcg_list_assets',
  'pcg_validate_graph',
  'pcg_read_node_output',
]);

export const invokeSchema = {
  name: z.string().min(1),
  args: z.record(z.unknown()).default({}),
  via: z.enum(['ts', 'ue_legacy']).optional().default('ts')
    .describe('Dispatch route. "ts" (default) looks the tool up in the TS captured map. "ue_legacy" calls executeCommand(name, args) directly against the UE plugin — only allowlisted commands accepted (see UE_LEGACY_ALLOWLIST).'),
};

export type InvokeResult =
  | { ok: true; result: unknown }
  | { ok: false; error: { kind: 'validation'; issues: unknown } }
  | { ok: false; error: { kind: 'tool_disabled'; name: string } }
  | { ok: false; error: { kind: 'unknown_tool'; name: string } }
  | { ok: false; error: { kind: 'legacy_not_allowlisted'; name: string } };

export interface InvokeCtx {
  dispatch: (cmd: string, args: Record<string, unknown>) => Promise<unknown>;
  dispatchLegacy?: (cmd: string, args: Record<string, unknown>) => Promise<unknown>;
  isDisabled: (name: string) => boolean;
}

export async function invokeHandler(
  args: { name: string; args: Record<string, unknown>; via?: 'ts' | 'ue_legacy' },
  ctx: InvokeCtx,
): Promise<InvokeResult> {
  const via = args.via ?? 'ts';
  if (ctx.isDisabled(args.name)) {
    return { ok: false, error: { kind: 'tool_disabled', name: args.name } };
  }
  if (via === 'ue_legacy') {
    if (!UE_LEGACY_ALLOWLIST.has(args.name)) {
      return { ok: false, error: { kind: 'legacy_not_allowlisted', name: args.name } };
    }
    const legacy = ctx.dispatchLegacy ?? ctx.dispatch;
    const result = await legacy(args.name, args.args ?? {});
    return { ok: true, result };
  }
  const shape: ZodRawShape | null = getRawShape(args.name);
  if (!shape) {
    return { ok: false, error: { kind: 'unknown_tool', name: args.name } };
  }
  const parse = z.object(shape).safeParse(args.args);
  if (!parse.success) {
    return { ok: false, error: { kind: 'validation', issues: parse.error.issues } };
  }
  const result = await ctx.dispatch(args.name, parse.data as Record<string, unknown>);
  return { ok: true, result };
}

export const meta = {
  cost: 'medium' as const,
  effects: ['variable'],
  when: 'You need to call a tool that exists in an unloaded pack as a one-off, or you need to reach a UE-only legacy handler (set via:"ue_legacy").',
  not_when: 'You will call this tool repeatedly — load its pack instead.',
  pack: 'core',
};
