// Single-source tool registrar. Collapses the previously-triplicated tool
// registration (server.tool + remember + reg) and the standard handler
// pass-through wrapper into ONE descriptor per tool.
//
// Before this, adding/editing a tool meant editing 3-4 scattered places:
//   1. server.tool('name', appendMeta(desc, meta), {shape}, async (p) => {...})
//   2. remember('name', meta)
//   3. reg('name', {shape}, cost, returns)   (in recordEagerSchemas)
//   4. the wrapper file under src/tools/<domain>/<tool>.ts
// — which is exactly the duplication that has caused drift.
//
// A ToolDescriptor declares the tool once. Two registrar entry points consume
// it, mirroring the historic two-phase timing exactly:
//
//   recordToolSchema(d)   — recordSchema(name, {shape, cost, returns}).
//     Runs ALWAYS (Code Mode on or off), like the old reg(...) calls inside
//     recordEagerSchemas — so get_tool_signature can derive params at runtime
//     regardless of whether the tool is eagerly registered.
//
//   registerTool(server, session, d) — server.tool(...) + remember(name, meta).
//     Runs ONLY in the eager block (config.codeMode === false), like the old
//     hand-written server.tool/remember sites.
//
// server.tool gets appendMeta(description, meta) + the standard handler wrapper,
// which reproduces the historic pass-through exactly:
//   - niche set  → return withNicheBriefing(niche, session, r)
//   - niche unset → return { content: r.content, isError: r.isError }
//
// This is purely DRY/locality: ZERO behavior change vs. the hand-written sites.

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { z } from 'zod';
import { appendMeta, isSceneMutating } from './hayba-tool-meta.js';
import type { HaybaToolMeta } from './hayba-tool-meta.js';
import { withValidationNudge } from './tool-result.js';
import { isUnderEvidenceContract, withEvidenceWarning } from './response-evidence.js';
import { recordSchema, type Cost } from './schema-registry.js';
import { registerToolMeta } from './tool-meta-registry.js';
import { appendNicheBriefing } from './niche-briefing.js';
import type { RichToolHandler, RichToolResult, ToolHandler, ToolResult, SessionManager } from './types.js';

export type ToolDescriptor = {
  /** MCP tool name, e.g. "material_create". */
  name: string;
  /** Human description (registrar appends meta via appendMeta when `meta` set). */
  description: string;
  /** Zod raw shape used both for server.tool validation and the schema registry. */
  schema: z.ZodRawShape;
  /**
   * Optional wire-only shape accepted by McpServer.
   *
   * Most tools use `schema` for both transport validation and their published
   * signature. A very small compatibility surface accepts deprecated aliases
   * at the wire while deliberately documenting only the canonical spelling.
   * Keeping that exception on the descriptor makes it data too; it no longer
   * requires a hand-written `server.tool(...)` site beside a separate `reg()`.
   */
  wireSchema?: z.ZodRawShape;
  /** Tool meta — drives appendMeta(description) and the cost-lookup registry. */
  meta: HaybaToolMeta;
  /**
   * The wrapper-file handler: (args, session) => Promise<ToolResult>.
   *
   * RichToolResult is allowed so a tool can return an image block. Without it,
   * anything that hands back a picture had to be hand-registered — which is how
   * editor_capture_viewport ended up outside every policy this registrar
   * applies. The cross-cutting helpers below only ever read and append TEXT
   * blocks, so an image block passes through them untouched.
   */
  handler: ToolHandler | RichToolHandler;
  /** Cost tier recorded in the schema registry (fallback catalog). */
  cost: Cost;
  /** Return-shape doc recorded in the schema registry (fallback catalog). */
  returns: string;
  /**
   * When set, the result is passed through appendNicheBriefing(niche, ...) —
   * reproducing the historic withNicheBriefing wrap (e.g. niche: 'material').
   * When unset, the standard { content, isError } pass-through is used.
   */
  niche?: string;
};

/**
 * Declare a ToolDescriptor with the handler's params inferred from its schema.
 *
 * A bare `ToolDescriptor` object literal types `handler` as ToolHandler, whose
 * args are Record<string, unknown> — so moving a tool from the inline
 * server.tool(name, schema, handler) form onto a descriptor silently lost the
 * zod-derived parameter types the handler body was written against, and the
 * only way back was a cast per call site.
 *
 * Wrapping the literal keeps that inference: `handler` sees the shape its own
 * `schema` describes. The return type is erased to ToolDescriptor so descriptors
 * with different schemas still live in one array.
 */
export function defineTool<S extends z.ZodRawShape>(d: {
  name: string;
  description: string;
  schema: S;
  wireSchema?: z.ZodRawShape;
  meta: HaybaToolMeta;
  cost: Cost;
  returns: string;
  niche?: string;
  handler: (
    // zod 4 removed z.objectOutputType; inferring through ZodObject is
    // the supported way to get the parsed shape's output type.
    args: z.infer<z.ZodObject<S>>,
    session: SessionManager,
  ) => Promise<ToolResult>;
}): ToolDescriptor {
  return d as unknown as ToolDescriptor;
}

/**
 * Record a descriptor's Zod shape + cost + return doc into the schema registry.
 * Runs unconditionally (independent of Code Mode), matching the old reg(...)
 * calls in recordEagerSchemas. The registry feeds get_tool_signature.
 */
export function recordToolSchema(d: ToolDescriptor): void {
  recordSchema(d.name, { shape: d.schema, cost: d.cost, returns: d.returns });
}

/**
 * Fully materialized MCP registration produced from one descriptor.
 *
 * This value is consumed by both eager registration and deferred capture. The
 * latter used to discover tools by executing the eager-registration routine
 * against a fake server whose `.tool()` method intercepted each call. Making
 * the registration itself a value removes that timing-sensitive shim: capture
 * can now build its map without touching any server object at all.
 */
export interface MaterializedTool {
  name: string;
  description: string;
  schema: z.ZodRawShape;
  handler: (params: Record<string, unknown>) => Promise<RichToolResult>;
}

export function materializeTool(
  session: SessionManager,
  d: ToolDescriptor,
): MaterializedTool {
  const niche = d.niche;
  const nudge = isSceneMutating(d.meta.effects);
  const evidence = isUnderEvidenceContract(d.meta.effects);
  return {
    name: d.name,
    description: appendMeta(d.description, d.meta),
    schema: d.wireSchema ?? d.schema,
    handler: async (params: Record<string, unknown>): Promise<RichToolResult> => {
      const r = await d.handler(params, session);
      const shaped = niche
        ? appendNicheBriefing(niche, session, r)
        : { content: r.content, isError: r.isError };
      const checked = evidence ? withEvidenceWarning(shaped) : shaped;
      return nudge ? withValidationNudge(checked) : checked;
    },
  };
}

/**
 * Eagerly register one tool from a descriptor: server.tool(...) with the
 * appendMeta'd description + the standard handler wrapper, plus remember(name).
 * Call only inside the eager (Code Mode off) block, matching the old
 * hand-written server.tool/remember sites.
 */
export function registerTool(
  server: McpServer,
  session: SessionManager,
  d: ToolDescriptor,
): void {
  const tool = materializeTool(session, d);
  server.tool(
    tool.name,
    tool.description,
    tool.schema,
    tool.handler,
  );
  registerToolMeta(d.name, d.meta);
}
