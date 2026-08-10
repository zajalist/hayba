import { z, type ZodRawShape } from 'zod';
import { getRawShape } from '../../schema-registry.js';
import { listAgentCallableLegacyCommands } from '../../../legacy-commands/index.js';
import { resolveAliases } from '../../param-aliases.js';
import { TOOL_ALIASES } from '../../tool-aliases.js';
import {
  IdempotencyLedger,
  IdempotencyLedgerError,
  isVerifiedSuccessReceipt,
} from '../idempotency-ledger.js';

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
  args: z.record(z.string(), z.unknown()).default({}),
  via: z.enum(['ts', 'ue_legacy']).optional().default('ts')
    .describe('Dispatch route. "ts" (default) looks the tool up in the TS captured map. "ue_legacy" calls executeCommand(name, args) directly against the UE plugin — only commands marked agent_callable:true in legacy-commands/sidecar.json are accepted.'),
  idempotency_key: z.string().min(1).max(256).optional()
    .describe('Retry identity for a mutation. This is envelope metadata, never forwarded as a tool parameter. Requires an authenticated MCP principal; receipts are process-local and expire.'),
};

export type InvokeResult =
  | { ok: true; result: unknown }
  | { ok: false; error: { kind: 'validation'; issues: unknown; accepted_params?: string[] } }
  | { ok: false; error: { kind: 'tool_disabled'; name: string } }
  | { ok: false; error: { kind: 'unknown_tool'; name: string } }
  | { ok: false; error: { kind: 'legacy_not_allowlisted'; name: string } }
  | { ok: false; error: {
      kind: 'idempotency_unavailable' | 'idempotency_invalid' | 'idempotency_conflict' | 'idempotency_capacity' | 'idempotency_wait_cancelled';
      message: string;
      reference?: string;
      scope: 'process_lifetime';
    } };

export interface InvokeIdempotencyContext {
  ledger: IdempotencyLedger;
  /** Derived only from SDK-validated authInfo. Never use sessionId or args. */
  authenticatedPrincipal?: string;
  waitSignal?: AbortSignal;
}

export interface InvokeCtx {
  dispatch: (cmd: string, args: Record<string, unknown>) => Promise<unknown>;
  dispatchLegacy?: (cmd: string, args: Record<string, unknown>) => Promise<unknown>;
  isDisabled: (name: string) => boolean;
  idempotency?: InvokeIdempotencyContext;
}

export async function invokeHandler(
  args: { name: string; args: Record<string, unknown>; via?: 'ts' | 'ue_legacy'; idempotency_key?: string },
  ctx: InvokeCtx,
): Promise<InvokeResult> {
  const via = args.via ?? 'ts';
  if (ctx.isDisabled(args.name)) {
    return { ok: false, error: { kind: 'tool_disabled', name: args.name } };
  }

  // Fold historical/expected param-name aliases onto their canonical key
  // before ANY dispatch route sees the args — see param-aliases.ts / issue
  // #339. Applies uniformly to the legacy route (no zod schema to normalise
  // against downstream) and the ts route (normalised BEFORE the strict parse
  // below, so the canonical shape used for that parse — and for
  // get_tool_signature's docs — never changes).
  const toolAliases = TOOL_ALIASES[args.name];
  let rawArgs = args.args ?? {};
  if (toolAliases) {
    const resolved = resolveAliases(rawArgs, toolAliases);
    if (!resolved.ok) {
      return {
        ok: false,
        error: { kind: 'validation', issues: [{ message: resolved.error }] },
      };
    }
    rawArgs = resolved.args;
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
    return await dispatchWithOptionalIdempotency(args, rawArgs, ctx, legacy);
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
      return await dispatchWithOptionalIdempotency(args, rawArgs, ctx, legacy);
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
  const parse = z.object(shape).strict().safeParse(rawArgs);
  if (!parse.success) {
    return {
      ok: false,
      error: { kind: 'validation', issues: parse.error.issues, accepted_params: Object.keys(shape) },
    };
  }
  return await dispatchWithOptionalIdempotency(
    args,
    parse.data as Record<string, unknown>,
    ctx,
    ctx.dispatch,
  );
}

async function dispatchWithOptionalIdempotency(
  envelope: { name: string; via?: 'ts' | 'ue_legacy'; idempotency_key?: string },
  validatedArgs: Record<string, unknown>,
  ctx: InvokeCtx,
  dispatch: (cmd: string, args: Record<string, unknown>) => Promise<unknown>,
): Promise<InvokeResult> {
  const key = envelope.idempotency_key;
  if (!key) {
    return { ok: true, result: await dispatch(envelope.name, validatedArgs) };
  }

  const authenticatedPrincipal = ctx.idempotency?.authenticatedPrincipal;
  if (!ctx.idempotency || !authenticatedPrincipal) {
    return {
      ok: false,
      error: {
        kind: 'idempotency_unavailable',
        message: 'Idempotency requires an authenticated MCP principal; this transport supplied none. See #379 for authenticated transport support.',
        scope: 'process_lifetime',
      },
    };
  }

  try {
    const result = await ctx.idempotency.ledger.run(
      {
        principal: authenticatedPrincipal,
        tool: envelope.name,
        key,
        // `via` changes which implementation runs, so it belongs in the
        // fingerprint even though the logical tool owns the keyed slot.
        request: { via: envelope.via ?? 'ts', args: validatedArgs },
        waitSignal: ctx.idempotency.waitSignal,
      },
      () => dispatch(envelope.name, validatedArgs),
      isVerifiedSuccessReceipt,
    );
    return { ok: true, result };
  } catch (error) {
    if (!(error instanceof IdempotencyLedgerError)) throw error;
    return {
      ok: false,
      error: {
        kind: error.code,
        message: error.message,
        ...(error.reference ? { reference: error.reference } : {}),
        scope: 'process_lifetime',
      },
    };
  }
}

export const meta = {
  cost: 'medium' as const,
  effects: ['variable'],
  when: 'You need to call a tool that exists in an unloaded pack as a one-off, or you need to reach a UE-only legacy handler (set via:"ue_legacy").',
  not_when: 'You will call this tool repeatedly — load its pack instead.',
  pack: 'core',
};
