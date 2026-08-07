import { z, type ZodRawShape } from 'zod';
import { getRawShape } from '../../schema-registry.js';
import { listAgentCallableLegacyCommands } from '../../../legacy-commands/index.js';

/**
 * Built once at module load from sidecar.json. Every entry with
 * agent_callable:true is admitted; aliases are first-class names in the
 * sidecar so we don't need to flatten them here. Update the sidecar to
 * change the allowlist — there is intentionally no other knob.
 *
 * See the postmortem at
 * `docs/superpowers/specs/2026-05-23-pcg-landscape-mcp-postmortem.md` §3.3
 * for the rationale behind the ue_legacy fallthrough.
 */
const LEGACY_ALLOWLIST: ReadonlySet<string> = listAgentCallableLegacyCommands();

/**
 * Back-compat re-export. The hardcoded set was the original PR #228 surface;
 * it now derives from sidecar.json so the schema authoring loop is single-source.
 */
export const UE_LEGACY_ALLOWLIST: ReadonlySet<string> = LEGACY_ALLOWLIST;

export const invokeSchema = {
  name: z.string().min(1),
  args: z.record(z.unknown()).default({}),
  via: z.enum(['ts', 'ue_legacy']).optional().default('ts')
    .describe('Dispatch route. "ts" (default) looks the tool up in the TS captured map. "ue_legacy" calls executeCommand(name, args) directly against the UE plugin — only commands marked agent_callable:true in legacy-commands/sidecar.json are accepted.'),
};

export type InvokeResult =
  | { ok: true; result: unknown }
  | { ok: false; error: { kind: 'validation'; issues: unknown; accepted_params?: string[] } }
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
  // UE-legacy route: when via:'ue_legacy' is set, dispatch the raw command
  // through the UE bridge. This is the safety hatch that makes a legacy
  // command reachable from hayba_invoke even when no TS wrapper has been
  // written yet — without it, the agent would hit unknown_tool and reach
  // for python_run, which was the trigger for the 2026-05-23 PCG/landscape
  // postmortem.
  if (via === 'ue_legacy') {
    if (!LEGACY_ALLOWLIST.has(args.name)) {
      return { ok: false, error: { kind: 'legacy_not_allowlisted', name: args.name } };
    }
    const legacy = ctx.dispatchLegacy ?? ctx.dispatch;
    const result = await legacy(args.name, args.args ?? {});
    return { ok: true, result };
  }
  const shape: ZodRawShape | null = getRawShape(args.name);
  if (!shape) {
    // ts → ue_legacy fallthrough: the caller asked for the default route but no
    // TS wrapper exists. Rather than dead-end on unknown_tool (which historically
    // pushed agents toward python_run — see the 2026-05-23 PCG/landscape
    // postmortem), transparently try the legacy route when the command is
    // allow-listed. Only when neither route knows the command do we error.
    if (LEGACY_ALLOWLIST.has(args.name)) {
      const legacy = ctx.dispatchLegacy ?? ctx.dispatch;
      const result = await legacy(args.name, args.args ?? {});
      return { ok: true, result };
    }
    return { ok: false, error: { kind: 'unknown_tool', name: args.name } };
  }
  // .strict(): an unknown/misnamed argument is a loud validation error naming
  // the key AND the params the tool actually takes. zod's default strip mode
  // silently deleted such keys here, which produced a whole class of field
  // defects that looked like broken tools — test_list {filter} returning all
  // 7111 engine tests, editor_pie_screenshot {path} polling a file that was
  // never checked, ui_set_slot_layout {anchors} applying everything except the
  // anchors. One loud round-trip beats hours of "the tool ignores its param".
  const parse = z.object(shape).strict().safeParse(args.args);
  if (!parse.success) {
    return {
      ok: false,
      error: { kind: 'validation', issues: parse.error.issues, accepted_params: Object.keys(shape) },
    };
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
