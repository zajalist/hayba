// Local safety layer applied to every tool call the brain asks this client
// to run: builds the public manifest sent to the brain, guards inbound
// tool-call requests before dispatch, and shapes results before they leave
// the machine (redacted, size-capped).

import { z, type ZodRawShape } from 'zod';
import type { Permissions, ToolManifestEntry } from '@hayba/brain-protocol';
import type { LLMTool } from '../agents/llm-client.js';
import { getRawShape } from '../tools/schema-registry.js';
import { redactBoundaryValue } from '../security/secret-redaction.js';
import { isDestructiveToolName } from '../chat/agent-loop.js';

export const TOOL_RESULT_CAP_BYTES = 32 * 1024;

export function buildHandsManifest(tools: LLMTool[]): ToolManifestEntry[] {
  return tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema }));
}

/** Explore exposes only known read-shaped commands. Unknown names fail closed. */
export function isExploreReadOnlyTool(name: string): boolean {
  return !isDestructiveToolName(name) &&
    /(?:^|_)(?:get|list|search|inspect|validate|query|read|describe|count|find|status|stats|info)(?:_|$)/.test(name);
}

export type GuardVerdict =
  | { ok: true }
  | { ok: false; code: 'unknown_tool' | 'invalid_args' | 'permission_denied' | 'read_only_mode'; message: string };

export interface GuardContext {
  manifest: ReadonlySet<string>;
  permissions: Permissions;
  mode: 'explore' | 'draft' | 'production';
  rawShape?: (name: string) => ZodRawShape | undefined;
}

export function guardInboundToolCall(name: string, args: Record<string, unknown>, ctx: GuardContext): GuardVerdict {
  if (!ctx.manifest.has(name)) {
    return { ok: false, code: 'unknown_tool', message: `${name} is not offered by this client` };
  }
  if (!ctx.permissions['tools.execute']) {
    return { ok: false, code: 'permission_denied', message: 'Tool execution is not permitted for Hayba Pro on this machine' };
  }
  if (name.startsWith('python_') && !ctx.permissions.python_run) {
    return { ok: false, code: 'permission_denied', message: 'Python tools need the local python_run permission' };
  }
  if (ctx.mode === 'explore' && !isExploreReadOnlyTool(name)) {
    return { ok: false, code: 'read_only_mode', message: `${name} mutates the project; Explore mode is read-only` };
  }
  const shape = (ctx.rawShape ?? ((n: string) => getRawShape(n) ?? undefined))(name);
  if (shape) {
    const parsed = z.object(shape).safeParse(args);
    if (!parsed.success) {
      const detail = parsed.error.issues.slice(0, 3).map((i) => `${i.path.join('.') || '(args)'}: ${i.message}`).join('; ');
      return { ok: false, code: 'invalid_args', message: detail };
    }
  }
  return { ok: true };
}

export function shapeToolResult(result: unknown): { result: unknown; truncated: boolean } {
  const redacted = redactBoundaryValue(result);
  const json = JSON.stringify(redacted) ?? 'null';
  const bytes = Buffer.byteLength(json);
  if (bytes <= TOOL_RESULT_CAP_BYTES) return { result: redacted, truncated: false };
  return {
    truncated: true,
    result: {
      truncated: true,
      original_bytes: bytes,
      note: 'Result exceeded 32 KB; request a narrower query.',
      preview: json.slice(0, TOOL_RESULT_CAP_BYTES - 512),
    },
  };
}
