// mcp-tools/hayba-mcp/src/tools/mcp-response.ts
//
// Every Hayba MCP tool returns the same envelope: a single text content
// block holding the handler's result as pretty-printed JSON. That wrapper
// was hand-written at ~15 registration sites in register.ts (and more
// across the per-domain tool files). toMcpResponse() is the one place the
// envelope shape lives now; registerJsonTool() folds the wrapper into tool
// registration so a meta-tool reads as name + description + schema + the
// bound handler — no `async (args) => ({ content: [...] })` boilerplate.

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { z } from 'zod';

/** The MCP content-block envelope every Hayba tool returns. */
export interface McpToolResponse {
  content: Array<{ type: 'text'; text: string }>;
}

/** Wrap any JSON-serialisable handler result in the standard MCP envelope. */
export function toMcpResponse(result: unknown): McpToolResponse {
  return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
}

/**
 * Register a tool whose handler returns a plain JSON-serialisable value.
 * `run` receives the validated args (type it on the lambda — `A` is
 * inferred from there); its result is wrapped via toMcpResponse.
 *
 * The `server.tool` call is escape-hatched the same way the deferred
 * registry path in register.ts is: the SDK's callback typing is bypassed
 * so the schema stays the single source of runtime validation while the
 * call site keeps compile-time typing on the handler args.
 */
export function registerJsonTool<A extends Record<string, unknown>>(
  server: McpServer,
  name: string,
  description: string,
  schema: z.ZodRawShape,
  run: (args: A) => Promise<unknown> | unknown,
): void {
  (server as unknown as { tool: (...a: unknown[]) => void }).tool(
    name,
    description,
    schema,
    async (args: A) => toMcpResponse(await run(args)),
  );
}
