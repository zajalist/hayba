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
    if (inner instanceof z.ZodOptional || inner instanceof z.ZodNullable) optional = true;
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
  else if (inner instanceof z.ZodObject) schema = { type: 'object' };
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

/** Default dispatch: route through the UE bridge (executeCommand). Task 4
 *  replaces this with a hayba_invoke-style dispatch that also reaches TS-side
 *  captured handlers. */
export const defaultDispatchTool: DispatchTool = (name, args) => executeCommand(name, args);

export type AgentDoneReason = 'end_turn' | 'max_steps' | 'token_budget' | 'aborted';

export type AgentEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'tool_call'; call: LLMToolCall }
  | { type: 'tool_result'; id: string; name: string; result: unknown; isError?: boolean }
  | { type: 'plan_request'; call: LLMToolCall; hint?: string; source: 'ts' | 'ue' }
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
  planApproved?: boolean;
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
    maxSteps = DEFAULT_MAX_STEPS,
    tokenBudget,
    maxTokens,
    signal,
  } = params;
  const dispatchTool = params.dispatchTool ?? defaultDispatchTool;

  const tools =
    params.tools ??
    buildToolCatalog({
      disabledTools: params.disabledTools,
      archetypeFilter: params.archetypeFilter,
    });
  const allowedNames = new Set(tools.map((t) => t.name));

  // Working transcript — LLMMessage only supports user/assistant string content,
  // so tool results are fed back as a user message carrying serialized JSON.
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
      for await (const ev of client.stream({ system, messages, tools, maxTokens })) {
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
    if (content) {
      messages.push({ role: 'assistant', content });
      tokens += estimateTokens(content);
    }

    // ── Halt when the model is done ──────────────────────────────────────
    if (stopReason !== 'tool_use' || toolCalls.length === 0) {
      yield { type: 'done', reason: 'end_turn', stopReason };
      return;
    }

    // ── Dispatch each requested tool ─────────────────────────────────────
    const resultsForModel: Array<Record<string, unknown>> = [];
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
        resultsForModel.push({ tool: call.name, id: call.id, ...result });
        continue;
      }

      // TS-side Plan-Mode gate (C++ is authoritative for UE commands, but this
      // catches TS handlers that never reach ProcessCommand). Pause, no dispatch.
      if (planMode && !planApproved && isDestructiveToolName(call.name)) {
        yield {
          type: 'plan_request',
          call,
          source: 'ts',
          hint: 'Plan Mode is ON. This destructive tool needs an approved plan before it runs.',
        };
        return;
      }

      // Dispatch.
      let result: unknown;
      try {
        result = await dispatchTool(call.name, call.input);
      } catch (err) {
        const msg = (err as { message?: string })?.message ?? String(err);
        const errResult = { ok: false, error: msg };
        yield { type: 'tool_result', id: call.id, name: call.name, result: errResult, isError: true };
        resultsForModel.push({ tool: call.name, id: call.id, ...errResult });
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
      resultsForModel.push({ tool: call.name, id: call.id, result });
      tokens += estimateTokens(JSON.stringify(result));
    }

    // Feed the batch of tool results back to the model and continue the loop.
    messages.push({
      role: 'user',
      content: `Tool results:\n${JSON.stringify(resultsForModel, null, 2)}`,
    });
  }
}
