/**
 * Agentic tool-calling loop for the BYOK in-editor copilot (Task 3).
 *
 * Drives an `LLMClient` (Task 2) over the live Hayba tool registry, dispatching
 * tool calls the SAME way an MCP client's `hayba_invoke` would, with the
 * Plan-Mode safety gate honoured on both sides:
 *
 *   - UE-bridged commands: C++ is the AUTHORITATIVE gate. When Plan Mode is on
 *     and a destructive command runs without an approved plan, `ProcessCommand`
 *     returns `{ status: 'plan_mode_required', hint }` (ok:true). The loop
 *     recognises that payload, emits a `plan_request` event and PAUSES — it is
 *     NOT counted as a tool failure and no further tools are dispatched.
 *   - TS-side handlers: many tools resolve entirely in Node and never reach the
 *     C++ gate, so the loop mirrors the C++ `IsDestructiveCommand` semantics via
 *     `isDestructiveToolName()` and pauses BEFORE dispatch when Plan Mode is on
 *     and the plan is not approved.
 *
 * The loop is an async generator so the SSE server (Task 4) can forward events
 * as frames and cancel mid-flight via an `AbortSignal`. The API key never
 * appears in any event — config is resolved inside the injected `LLMClient` and
 * is never echoed here.
 *
 * Dispatch seam: the real captured-tool map lives inside
 * `registerDeferredRouting` (src/tools/routing/register.ts) and is not cleanly
 * importable at module scope, so the loop takes an injectable
 * `dispatchTool(name, args)`. The default implementation routes through
 * `executeCommand` (UE bridge). Task 4 injects the full `hayba_invoke`-style
 * dispatch that also reaches TS-side captured handlers.
 */

import { z, type ZodRawShape, type ZodTypeAny } from 'zod';
import type {
  LLMClient,
  LLMContentBlock,
  LLMMessage,
  LLMTool,
  LLMToolCall,
  LLMStopReason,
} from '../agents/llm-client.js';
import { deriveSignature, getRawShape, listRecordedCommands } from '../tools/schema-registry.js';
import { getToolMeta } from '../tools/tool-meta-registry.js';
import { describeMeta } from '../tools/hayba-tool-meta.js';
import { NON_IDEMPOTENT, executeCommand } from '../tools/tool-executor.js';
import { isToolDisabled } from '../tools/disabled-tools-watcher.js';

// ---------------------------------------------------------------------------
// Destructive-name predicate — mirrors C++ IsDestructiveCommand semantics.
// C++ remains the authoritative gate for UE-bridged commands; this is used
// only for TS-side handlers that never reach ProcessCommand.
// ---------------------------------------------------------------------------

/**
 * Command names that are destructive but not already in NON_IDEMPOTENT (e.g.
 * idempotent-on-retry setters and the wildcard/exec escape hatches). Kept in
 * sync with the C++ DestructiveCommands set in HaybaMCPCommandHandler.cpp.
 */
const EXTRA_DESTRUCTIVE = new Set<string>([
  // Arbitrary code / wildcard invocation
  'python_run',
  'actor_call_function',
  'editor_run_console_command',
  // Setters / mutations that are safe to retry (so not in NON_IDEMPOTENT) but
  // still mutate scene/asset state and must be plan-gated.
  'actor_set_properties',
  'actor_set_visibility',
  'actor_snap_to_socket',
  'actor_tag',
  'object_set_property',
  'blueprint_add_component',
  'blueprint_add_variable',
  'blueprint_set_defaults',
  'ism_add_instance',
  'spline_add_point',
  'spline_set_point',
  'spline_remove_point',
  'data_set',
  'memory_clear',
  // PCG / landscape legacy aliases
  'create_graph',
  'execute_graph',
  'pcg_execute_graph',
  'import_landscape',
]);

/**
 * Faithful TS mirror of the C++ Plan-Mode gate. A name is destructive if it is
 * in NON_IDEMPOTENT (create/delete/import/… lifecycle ops), in the extra set
 * above, or matches a create/delete/add/remove/set mutation pattern.
 *
 * Pure reads (get/list/info/search/validate/export/focus/ping) are NOT gated —
 * matched here by NOT matching a mutation pattern.
 */
export function isDestructiveToolName(name: string): boolean {
  if (NON_IDEMPOTENT.has(name)) return true;
  if (EXTRA_DESTRUCTIVE.has(name)) return true;
  // Mutation verbs, matched as a segment (prefix, suffix, or *_verb_*).
  return /(^|_)(create|delete|add|remove|set|spawn|duplicate|import|rename|clear|destroy)(_|$)/.test(
    name,
  );
}

// ---------------------------------------------------------------------------
// zod raw shape -> minimal JSON schema (no heavy dep; reuses the unwrap logic
// that deriveSignature/schema-registry already established).
// ---------------------------------------------------------------------------

interface JsonSchema {
  type?: string;
  enum?: string[];
  items?: JsonSchema;
  description?: string;
  [k: string]: unknown;
}

function zodToJsonSchema(t: ZodTypeAny): { schema: JsonSchema; optional: boolean } {
  let optional = false;
  let inner: ZodTypeAny = t;
  while (
    inner instanceof z.ZodOptional ||
    inner instanceof z.ZodDefault ||
    inner instanceof z.ZodNullable
  ) {
    // ZodDefault also makes the field optional (a default is supplied when absent).
    if (
      inner instanceof z.ZodOptional ||
      inner instanceof z.ZodNullable ||
      inner instanceof z.ZodDefault
    )
      optional = true;
    inner = (inner as unknown as { _def: { innerType: ZodTypeAny } })._def.innerType;
  }
  while (inner instanceof z.ZodEffects) {
    inner = (inner as unknown as { _def: { schema: ZodTypeAny } })._def.schema;
  }

  let schema: JsonSchema;
  if (inner instanceof z.ZodString) schema = { type: 'string' };
  else if (inner instanceof z.ZodNumber) schema = { type: 'number' };
  else if (inner instanceof z.ZodBoolean) schema = { type: 'boolean' };
  else if (inner instanceof z.ZodEnum)
    schema = { type: 'string', enum: (inner as unknown as { _def: { values: string[] } })._def.values };
  else if (inner instanceof z.ZodArray)
    schema = {
      type: 'array',
      items: zodToJsonSchema((inner as unknown as { _def: { type: ZodTypeAny } })._def.type).schema,
    };
  else if (inner instanceof z.ZodTuple) schema = { type: 'array' };
  else if (inner instanceof z.ZodObject) {
    // Finding 4: emit nested properties one level deep (don't over-engineer;
    // deeper nesting is left flat). shapeToInputSchema is hoisted below.
    const nestedShape = (inner as unknown as { _def: { shape: () => ZodRawShape } })._def.shape();
    schema = shapeToInputSchema(nestedShape);
  }
  else if (inner instanceof z.ZodRecord) schema = { type: 'object' };
  else schema = {};

  const desc = (t as unknown as { _def?: { description?: string } })._def?.description
    ?? (inner as unknown as { _def?: { description?: string } })._def?.description;
  if (desc) schema.description = desc;
  return { schema, optional };
}

function shapeToInputSchema(shape: ZodRawShape): LLMTool['input_schema'] {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const [key, value] of Object.entries(shape)) {
    const { schema, optional } = zodToJsonSchema(value as ZodTypeAny);
    properties[key] = schema;
    if (!optional) required.push(key);
  }
  const out: LLMTool['input_schema'] = { type: 'object', properties };
  if (required.length > 0) out.required = required;
  return out;
}

// ---------------------------------------------------------------------------
// Tool-catalog derivation from the live registry.
// ---------------------------------------------------------------------------

/** Convert a glob (`actor_*`, `*`) to a RegExp. Only `*` is a wildcard. */
function globToRegex(glob: string): RegExp {
  const escaped = glob.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`);
}

export interface ToolCatalogOptions {
  /** Explicit disabled names (in addition to the disabled-tools watcher). */
  disabledTools?: Iterable<string>;
  /** Archetype `tool_filter` globs (agent-registry.ts). Omit = allow all. */
  archetypeFilter?: string[];
  /** Override the disabled predicate (defaults to isToolDisabled). Test seam. */
  isDisabled?: (name: string) => boolean;
  /** Override the recorded-command source. Test seam. */
  listCommands?: () => string[];
}

/**
 * Build the `LLMTool[]` offered to the model from the schema registry, filtered
 * by the disabled-tools list and the archetype `tool_filter`.
 */
export function buildToolCatalog(opts: ToolCatalogOptions = {}): LLMTool[] {
  const isDisabled = opts.isDisabled ?? isToolDisabled;
  const disabledExtra = new Set(opts.disabledTools ?? []);
  const filters = (opts.archetypeFilter ?? ['*']).map(globToRegex);
  const allowed = (name: string): boolean => filters.some((re) => re.test(name));
  const names = (opts.listCommands ?? listRecordedCommands)();

  const tools: LLMTool[] = [];
  for (const name of names) {
    if (disabledExtra.has(name) || isDisabled(name)) continue;
    if (!allowed(name)) continue;
    const shape = getRawShape(name);
    if (!shape) continue;
    const meta = getToolMeta(name);
    const sig = deriveSignature(name);
    const description = meta
      ? describeMeta(meta)
      : sig
        ? `Hayba command ${name} (returns ${sig.returns}, cost ${sig.cost}).`
        : `Hayba command ${name}.`;
    tools.push({ name, description, input_schema: shapeToInputSchema(shape) });
  }
  return tools;
}

// ---------------------------------------------------------------------------
// Loop contract
// ---------------------------------------------------------------------------

export type DispatchTool = (name: string, args: Record<string, unknown>) => Promise<unknown>;

/**
 * Identity of a plan-gated tool call: the tool name plus a stable hash of its
 * arguments. Approval is bound to THIS identity (C1) so a resumed turn cannot
 * launder a *different* destructive call through a single turn-wide approval.
 */
export interface ApprovedCall {
  name: string;
  argsHash: string;
}

/** Deterministic (sorted-key) JSON serialization — used as the args hash. */
function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  const obj = v as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(obj[k])).join(',') + '}';
}

/** Stable hash of a tool call's arguments (sorted-key JSON). */
export function argsHash(args: unknown): string {
  return stableStringify(args);
}

/** Default dispatch: route through the UE bridge (executeCommand). Task 4
 *  replaces this with a hayba_invoke-style dispatch that also reaches TS-side
 *  captured handlers. */
export const defaultDispatchTool: DispatchTool = (name, args) => executeCommand(name, args);

export type AgentDoneReason = 'end_turn' | 'max_steps' | 'token_budget' | 'aborted';

export type AgentEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'tool_call'; call: LLMToolCall }
  | { type: 'tool_result'; id: string; name: string; result: unknown; isError?: boolean }
  | { type: 'plan_request'; call: LLMToolCall; hint?: string; source: 'ts' | 'ue'; argsHash?: string }
  | { type: 'done'; reason: AgentDoneReason; stopReason?: LLMStopReason }
  | { type: 'error'; error: string; kind?: string };

export interface AgentLoopParams {
  client: LLMClient;
  system: string;
  messages: LLMMessage[];
  /** Tool catalog. If omitted, built from the registry with the filters below. */
  tools?: LLMTool[];
  disabledTools?: Iterable<string>;
  archetypeFilter?: string[];
  /** Plan-Mode gate for TS-side destructive tools (UE side is C++-authoritative). */
  planMode?: boolean;
  /**
   * @deprecated Turn-wide approval is unsafe (a resumed turn can emit different
   * destructive calls that all sail through). Use {@link approvedCall} to bind
   * the approval to a specific `{name, argsHash}` identity. Still honoured only
   * when `approvedCall` is absent, for backwards compatibility.
   */
  planApproved?: boolean;
  /**
   * Call-bound approval (C1). The TS-side gate passes exactly ONE destructive
   * call matching this `{name, argsHash}`; the approval is consumed on first
   * matching dispatch. Any other destructive call re-pauses with a fresh
   * `plan_request`. (C++ re-checks server-side independently — the UE Plan tab
   * remains authoritative for UE-bridged commands.)
   */
  approvedCall?: ApprovedCall;
  maxSteps?: number;
  /** Approximate token budget across the whole loop (chars/4 heuristic). */
  tokenBudget?: number;
  maxTokens?: number;
  dispatchTool?: DispatchTool;
  signal?: AbortSignal;
}

const DEFAULT_MAX_STEPS = 16;

/** chars/4 rough token estimate — good enough for a budget guard. */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Is a dispatch result the C++ Plan-Mode pause payload? */
function isPlanModeRequired(result: unknown): result is { status: string; hint?: string } {
  return (
    typeof result === 'object' &&
    result !== null &&
    (result as { status?: unknown }).status === 'plan_mode_required'
  );
}

/**
 * Run the agentic tool-calling loop. Yields normalized events; halts on
 * end_turn, maxSteps, token budget, abort, or a plan_request pause.
 */
export async function* runAgentLoop(
  params: AgentLoopParams,
): AsyncGenerator<AgentEvent, void, unknown> {
  const {
    client,
    system,
    planMode = false,
    planApproved = false,
    approvedCall,
    maxSteps = DEFAULT_MAX_STEPS,
    tokenBudget,
    maxTokens,
    signal,
  } = params;
  const dispatchTool = params.dispatchTool ?? defaultDispatchTool;
  // Call-bound approval is one-shot: consumed on the first matching dispatch.
  let approvalUsed = false;

  const tools =
    params.tools ??
    buildToolCatalog({
      disabledTools: params.disabledTools,
      archetypeFilter: params.archetypeFilter,
    });
  const allowedNames = new Set(tools.map((t) => t.name));

  // Working transcript. The assistant's tool_use turn and the tool_result turn
  // are pushed as structured content blocks so the protocol builders can transmit
  // them with fidelity (Anthropic content blocks / OpenAI tool_calls + tool msgs).
  const messages: LLMMessage[] = params.messages.map((m) => ({ ...m }));

  let steps = 0;
  let tokens = 0;

  while (true) {
    if (signal?.aborted) {
      yield { type: 'error', error: 'aborted', kind: 'aborted' };
      yield { type: 'done', reason: 'aborted' };
      return;
    }
    if (steps >= maxSteps) {
      yield { type: 'done', reason: 'max_steps' };
      return;
    }
    if (tokenBudget !== undefined && tokens >= tokenBudget) {
      yield { type: 'done', reason: 'token_budget' };
      return;
    }

    // ── One LLM turn (streamed) ──────────────────────────────────────────
    let content: string | null = null;
    let toolCalls: LLMToolCall[] = [];
    let stopReason: LLMStopReason = 'end_turn';

    try {
      for await (const ev of client.stream({ system, messages, tools, maxTokens, signal })) {
        if (signal?.aborted) {
          yield { type: 'error', error: 'aborted', kind: 'aborted' };
          yield { type: 'done', reason: 'aborted' };
          return;
        }
        if (ev.type === 'text_delta') {
          yield { type: 'text_delta', text: ev.text };
          tokens += estimateTokens(ev.text);
        } else if (ev.type === 'done') {
          content = ev.response.content;
          toolCalls = ev.response.toolCalls;
          stopReason = ev.response.stopReason;
        }
        // 'tool_call' stream events are consolidated in the 'done' response.
      }
    } catch (err) {
      const e = err as { kind?: string; message?: string };
      yield { type: 'error', error: e?.message ?? String(err), kind: e?.kind };
      return;
    }

    steps += 1;
    // Record the assistant turn as blocks: text (if any) followed by one
    // tool_use block per requested call, so ids are preserved for the results.
    const assistantBlocks: LLMContentBlock[] = [];
    if (content) {
      assistantBlocks.push({ type: 'text', text: content });
      tokens += estimateTokens(content);
    }
    for (const call of toolCalls) {
      assistantBlocks.push({ type: 'tool_use', id: call.id, name: call.name, input: call.input });
    }
    if (assistantBlocks.length > 0) {
      messages.push({ role: 'assistant', content: assistantBlocks });
    }

    // ── Halt when the model is done ──────────────────────────────────────
    if (stopReason !== 'tool_use' || toolCalls.length === 0) {
      yield { type: 'done', reason: 'end_turn', stopReason };
      return;
    }

    // ── Dispatch each requested tool ─────────────────────────────────────
    const toolResultBlocks: LLMContentBlock[] = [];
    for (const call of toolCalls) {
      if (signal?.aborted) {
        yield { type: 'error', error: 'aborted', kind: 'aborted' };
        yield { type: 'done', reason: 'aborted' };
        return;
      }
      yield { type: 'tool_call', call };

      // Filtered / disabled: refuse without dispatching. Feed the refusal back
      // so the model can adapt rather than silently stalling.
      if (!allowedNames.has(call.name)) {
        const result = {
          ok: false,
          error: `Tool "${call.name}" is not available (disabled or filtered out for this agent).`,
        };
        yield { type: 'tool_result', id: call.id, name: call.name, result, isError: true };
        toolResultBlocks.push({
          type: 'tool_result',
          tool_use_id: call.id,
          content: JSON.stringify(result),
          is_error: true,
        });
        continue;
      }

      // TS-side Plan-Mode gate (C++ is authoritative for UE commands, but this
      // catches TS handlers that never reach ProcessCommand). Approval is bound
      // to a specific {name, argsHash} (C1): a resumed turn may dispatch ONLY the
      // exact call that was approved, once. Any other destructive call — or a
      // second copy of the approved one — re-pauses with a fresh plan_request.
      if (planMode && isDestructiveToolName(call.name)) {
        const hash = argsHash(call.input);
        const matchesApproval =
          !approvalUsed &&
          approvedCall !== undefined &&
          approvedCall.name === call.name &&
          approvedCall.argsHash === hash;
        // Legacy turn-wide approval only when no call-bound approval was supplied.
        const legacyApproved = approvedCall === undefined && planApproved;
        if (matchesApproval) {
          approvalUsed = true; // one-shot consume
        } else if (!legacyApproved) {
          yield {
            type: 'plan_request',
            call,
            source: 'ts',
            argsHash: hash,
            hint: 'Plan Mode is ON. This destructive tool needs an approved plan before it runs.',
          };
          return;
        }
      }

      // Dispatch.
      let result: unknown;
      try {
        result = await dispatchTool(call.name, call.input);
      } catch (err) {
        const msg = (err as { message?: string })?.message ?? String(err);
        const errResult = { ok: false, error: msg };
        yield { type: 'tool_result', id: call.id, name: call.name, result: errResult, isError: true };
        toolResultBlocks.push({
          type: 'tool_result',
          tool_use_id: call.id,
          content: JSON.stringify(errResult),
          is_error: true,
        });
        continue;
      }

      // C++ Plan-Mode gate response: pause, NOT a failure, no further dispatch.
      if (isPlanModeRequired(result)) {
        yield {
          type: 'plan_request',
          call,
          source: 'ue',
          hint: (result as { hint?: string }).hint,
        };
        return;
      }

      yield { type: 'tool_result', id: call.id, name: call.name, result };
      const serialized = JSON.stringify(result);
      toolResultBlocks.push({ type: 'tool_result', tool_use_id: call.id, content: serialized });
      tokens += estimateTokens(serialized);
    }

    // Feed the batch of tool_result blocks back to the model and continue.
    messages.push({ role: 'user', content: toolResultBlocks });
  }
}
