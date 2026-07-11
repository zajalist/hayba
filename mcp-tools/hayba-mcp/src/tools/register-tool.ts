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
import { recordSchema, type Cost } from './schema-registry.js';
import { registerToolMeta } from './tool-meta-registry.js';
import { appendNicheBriefing } from './niche-briefing.js';
import type { ToolHandler, ToolResult, SessionManager } from './types.js';

export type ToolDescriptor = {
  /** MCP tool name, e.g. "material_create". */
  name: string;
  /** Human description (registrar appends meta via appendMeta when `meta` set). */
  description: string;
  /** Zod raw shape used both for server.tool validation and the schema registry. */
  schema: z.ZodRawShape;
  /** Tool meta — drives appendMeta(description) and the cost-lookup registry. */
  meta: HaybaToolMeta;
  /** The wrapper-file handler: (args, session) => Promise<ToolResult>. */
  handler: ToolHandler;
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
 * Record a descriptor's Zod shape + cost + return doc into the schema registry.
 * Runs unconditionally (independent of Code Mode), matching the old reg(...)
 * calls in recordEagerSchemas. The registry feeds get_tool_signature.
 */
export function recordToolSchema(d: ToolDescriptor): void {
  recordSchema(d.name, { shape: d.schema, cost: d.cost, returns: d.returns });
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
  const niche = d.niche;
  // Scene-mutating tools get a post-mutation validation nudge appended to their
  // successful result — see withValidationNudge. Decided ONCE here from the
  // tool's declared effects so it's DRY across every registered tool.
  const nudge = isSceneMutating(d.meta.effects);
  server.tool(
    d.name,
    appendMeta(d.description, d.meta),
    d.schema,
    async (params: Record<string, unknown>): Promise<ToolResult> => {
      const r = await d.handler(params, session);
      const shaped = niche
        ? appendNicheBriefing(niche, session, r)
        : { content: r.content, isError: r.isError };
      return nudge ? withValidationNudge(shaped) : shaped;
    },
  );
  registerToolMeta(d.name, d.meta);
}
