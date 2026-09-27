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
  /** `args` are the schema-parsed arguments (defaults applied, unknown keys dropped): dispatch these, never the raw ones. */
  | { ok: true; args: Record<string, unknown> }
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
  // The console's `py` command is python_run by another name.
  if (name === 'editor_run_console_command' && !ctx.permissions.python_run && isPythonConsoleCommand(args.command)) {
    return { ok: false, code: 'permission_denied', message: 'The py console command needs the local python_run permission' };
  }
  if (ctx.mode === 'explore' && !isExploreReadOnlyTool(name)) {
    return { ok: false, code: 'read_only_mode', message: `${name} mutates the project; Explore mode is read-only` };
  }
  const shape = (ctx.rawShape ?? ((n: string) => getRawShape(n) ?? undefined))(name);
  if (!shape) return { ok: true, args };
  const parsed = z.object(shape).safeParse(args);
  if (!parsed.success) {
    const detail = parsed.error.issues.slice(0, 3).map((i) => `${i.path.join('.') || '(args)'}: ${i.message}`).join('; ');
    return { ok: false, code: 'invalid_args', message: detail };
  }
  return { ok: true, args: parsed.data as Record<string, unknown> };
}

function isPythonConsoleCommand(command: unknown): boolean {
  return typeof command === 'string' && /^\s*py(?:\.\w+)?(?:\s|$)/i.test(command);
}

const omittedImage = () => ({ omitted: 'image' });
const LONG_STRING_BYTES = 4 * 1024;
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;
const BASE64URL_RE = /^[A-Za-z0-9_-]+={0,2}$/;
/** MIME (RFC 2045) and PEM wrap base64 at these widths; any other line layout is text. */
const MIME_LINE_WIDTHS = [64, 76];

function isStrictBase64Line(s: string): boolean {
  if (BASE64_RE.test(s)) return s.length % 4 === 0;
  // base64url may drop its padding, which leaves any length but 1 (mod 4).
  return BASE64URL_RE.test(s) && (s.includes('=') ? s.length % 4 === 0 : s.length % 4 !== 1);
}

/**
 * Strict base64 on the RAW string: one unbroken line, or standard base64 wrapped
 * with `\r?\n` exactly every 64 or 76 characters. Spaces or irregular line breaks
 * mean text — a long newline-separated list of actor names or /Game paths is
 * made of base64-legal characters but is not a binary payload.
 */
function isStrictBase64(s: string): boolean {
  if (!/[\r\n]/.test(s)) return isStrictBase64Line(s);
  const lines = s.split(/\r?\n/);
  if (lines.at(-1) === '') lines.pop(); // one trailing line break
  const width = lines[0].length;
  if (!MIME_LINE_WIDTHS.includes(width)) return false;
  const last = lines[lines.length - 1];
  if (last.length === 0 || last.length > width) return false;
  if (!lines.slice(0, -1).every((l) => l.length === width)) return false;
  const joined = lines.join('');
  return BASE64_RE.test(joined) && joined.length % 4 === 0;
}

function isBinaryString(s: string): boolean {
  if (/^data:image\//i.test(s)) return true;
  if (s.length <= LONG_STRING_BYTES) return false;
  return isStrictBase64(s);
}

/**
 * Screenshots and other binary payloads never leave the machine (they would leak
 * scene imagery and blow the size cap as a useless base64 preview): MCP image
 * content blocks, `image_base64` fields, `data:image/...` URLs and any long
 * base64 string become `{ omitted: 'image' }`. `ancestors` guards against cycles.
 */
export function stripBinaryPayloads(value: unknown, ancestors: WeakSet<object> = new WeakSet()): unknown {
  if (typeof value === 'string') return isBinaryString(value) ? omittedImage() : value;
  if (value === null || typeof value !== 'object') return value;
  if (ancestors.has(value)) return undefined;
  if (!Array.isArray(value) && (value as { type?: unknown }).type === 'image') return omittedImage();
  ancestors.add(value);
  let out: unknown;
  if (Array.isArray(value)) out = value.map((v) => stripBinaryPayloads(v, ancestors));
  else {
    const obj: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) obj[k] = k === 'image_base64' ? omittedImage() : stripBinaryPayloads(v, ancestors);
    out = obj;
  }
  ancestors.delete(value);
  return out;
}

export function shapeToolResult(result: unknown): { result: unknown; truncated: boolean } {
  const redacted = redactBoundaryValue(stripBinaryPayloads(result));
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
