// python_run-backed tool factory (`pyTemplate`).
//
// The roadmap ships *hundreds* of small UE tools as generated Python rather
// than dedicated C++ handlers (see hayba-introspect.ts / pcg-primitives.ts for
// the hand-written shape this generalizes). Each of those tools is the SAME
// five steps: zod-validate params → buildScript(params) → runUePythonJson →
// wrap the parsed result → wrap thrown errors. This factory declares that shape
// ONCE so a python-backed tool is *data*, not boilerplate.
//
// A PyToolDescriptor produces:
//   makePyToolHandler(d)  → the (params) => Promise<ToolResult> handler.
//   toToolDescriptor(d)   → the canonical ToolDescriptor (handler + default
//                           meta synthesized), so a factory tool flows through
//                           the EXISTING registrar (registerTool /
//                           recordToolSchema) and is indistinguishable from a
//                           hand-written one to get_tool_signature / Code-Mode.
//   registerPyTool(...)   → record schema + server.tool + appendMeta + remember
//                           from that single descriptor.
//
// Why route through register-tool.ts rather than re-implementing server.tool:
// the registration conventions (appendMeta'd description, the niche/pass-through
// handler wrapper, registerToolMeta for cost lookup, recordSchema for live
// signatures) already live in ONE place. The factory adapts PyToolDescriptor →
// ToolDescriptor and reuses them verbatim, so there is zero registration drift.

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { HaybaToolMeta } from './hayba-tool-meta.js';
import { runUePythonJson } from './ue-python.js';
import { okResult, errorResult } from './tool-result.js';
import {
  registerTool,
  recordToolSchema,
  type ToolDescriptor,
} from './register-tool.js';
import type { Cost } from './schema-registry.js';
import type { ToolResult, SessionManager } from './types.js';

/**
 * Declarative description of a python_run-backed tool. Everything needed to
 * build the handler AND register the tool, declared once.
 *
 * `buildScript` receives the *parsed* (validated + defaulted) params and returns
 * the Python BODY only — PY_PREAMBLE (`_emit`/`_err`) is auto-prepended by
 * runUePythonJson, so the body should call `_emit({...})` on success and `_err`
 * on failure, exactly like the hand-written tools.
 */
export interface PyToolDescriptor<S extends z.ZodRawShape = z.ZodRawShape> {
  /** MCP tool name, e.g. "pcg_add_node". */
  name: string;
  /** Human description (appendMeta appends the meta block at registration). */
  description: string;
  /** Cost tier — recorded in the schema registry and drives the default meta. */
  cost: Cost;
  /** Return-shape doc recorded in the schema registry (get_tool_signature). */
  returns: string;
  /** Zod raw shape — validates params AND feeds the schema registry. */
  schema: S;
  /** Build the Python body from validated params. Calls _emit/_err. */
  buildScript: (params: z.infer<z.ZodObject<S>>) => string;
  /** Full tool meta. When omitted, a minimal meta is synthesized from `cost`. */
  meta?: HaybaToolMeta;
  /** Override the python_run timeout (ms). Defaults to runUePythonJson's. */
  timeoutMs?: number;
}

/**
 * A python-tool handler. Accepts the raw params and (optionally) the session so
 * it is assignable to the canonical ToolHandler, while remaining callable as a
 * bare `(params) => Promise<ToolResult>` for direct/unit-test use.
 */
export type PyToolHandler = (
  params: Record<string, unknown>,
  session?: SessionManager,
) => Promise<ToolResult>;

/** Synthesize a minimal meta for descriptors that don't supply their own. */
function defaultPyMeta(cost: Cost): HaybaToolMeta {
  return { cost, effects: [], when: '', not_when: '' };
}

/**
 * Build the runtime handler for a python-backed tool. The handler:
 *   1. validates params against the zod schema (errorResult on failure),
 *   2. runs runUePythonJson(buildScript(parsedParams), timeoutMs),
 *   3. returns the parsed result via okResult,
 *   4. returns errorResult on any thrown error (missing marker, bad JSON,
 *      transport failure, or a throw inside buildScript).
 */
export function makePyToolHandler<S extends z.ZodRawShape>(
  d: PyToolDescriptor<S>,
): PyToolHandler {
  const validator = z.object(d.schema);
  return async (params: Record<string, unknown>): Promise<ToolResult> => {
    const parsed = validator.safeParse(params);
    if (!parsed.success) {
      return errorResult(`Invalid params for ${d.name}: ${parsed.error.message}`);
    }
    try {
      const script = d.buildScript(parsed.data);
      const result = await runUePythonJson(script, d.timeoutMs);
      return okResult(result);
    } catch (e) {
      return errorResult(`${d.name} error: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
}

/**
 * Adapt a PyToolDescriptor to the canonical ToolDescriptor consumed by the
 * existing registrar. The synthesized handler + meta make a factory tool
 * indistinguishable from a hand-written STANDARD_DESCRIPTORS entry — so it can
 * also be spliced directly into that list if a caller prefers the list path.
 */
export function toToolDescriptor<S extends z.ZodRawShape>(
  d: PyToolDescriptor<S>,
): ToolDescriptor {
  return {
    name: d.name,
    description: d.description,
    schema: d.schema,
    meta: d.meta ?? defaultPyMeta(d.cost),
    handler: makePyToolHandler(d),
    cost: d.cost,
    returns: d.returns,
  };
}

/**
 * Register one python-backed tool from a single descriptor: records the schema
 * (so get_tool_signature works regardless of Code Mode) AND does the eager
 * server.tool + appendMeta + remember. This is the standalone / Code-Mode-off
 * path. Callers that mirror index.ts's two-phase split can instead use
 * recordToolSchema(toToolDescriptor(d)) (always) + registerTool(...) (eager).
 */
export function registerPyTool<S extends z.ZodRawShape>(
  server: McpServer,
  session: SessionManager,
  d: PyToolDescriptor<S>,
): void {
  const td = toToolDescriptor(d);
  recordToolSchema(td);
  registerTool(server, session, td);
}
