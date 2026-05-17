// Fire-and-forget mirror of every MCP tool call into the UE Tool Stream panel.
// Wraps server.tool() once so every subsequent registration is captured
// without per-call-site changes. UE handles `ui_tool_stream` by recording the
// entry into its module-level history buffer and pushing into the live panel.

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ensureConnected } from '../tcp-client.js';
import { isToolDisabled } from './disabled-tools-watcher.js';

function preview(value: unknown, max: number): string {
  if (value == null) return '';
  let str: string;
  try {
    str = typeof value === 'string' ? value : JSON.stringify(value);
  } catch {
    str = String(value);
  }
  return str.length > max ? str.slice(0, max) : str;
}

// One conversation turn = one Claude reply. Back-to-back tool calls inside
// the same reply finish within sub-second of each other; a gap of multiple
// seconds means Claude has handed control back to the user, replied, and is
// now starting a fresh turn. 3s is generous for slow tools without merging
// distinct user prompts.
const NEW_TURN_GAP_MS = 3000;
let lastMirrorTimestamp = 0;

async function mirror(toolName: string, params: unknown, result: unknown): Promise<void> {
  try {
    const client = await ensureConnected();

    const now = Date.now();
    const shouldStartNewTurn = lastMirrorTimestamp > 0 && (now - lastMirrorTimestamp) > NEW_TURN_GAP_MS;
    lastMirrorTimestamp = now;
    if (shouldStartNewTurn) {
      await client.send('ui_tool_stream_new_turn', {}, 1500).catch(() => {});
    }

    // Stringify defensively — UE expects three string fields.
    await client.send('ui_tool_stream', {
      tool: toolName,
      params: preview(params, 2000),
      result: preview(result, 4000),
    }, 1500);
  } catch {
    // UE editor closed, port unreachable, etc. — silent: the tool itself
    // already succeeded, mirroring is best-effort observability.
  }
}

/**
 * Install the wrapper once, before any tool is registered. Every subsequent
 * call to `server.tool(name, ..., handler)` is intercepted so the handler's
 * result is mirrored to UE after it resolves.
 */
export function installToolStreamMirror(server: McpServer): void {
  const orig = (server.tool as Function).bind(server);
  (server as any).tool = (...args: unknown[]) => {
    if (args.length < 2) return orig(...args);
    const name = args[0] as string;
    const handler = args[args.length - 1] as Function;
    if (typeof handler !== 'function') return orig(...args);

    const wrapped = async (params: unknown, ...rest: unknown[]) => {
      // MCP panel gate: if the user disabled this tool, short-circuit with a
      // clear status. Meta-tools (list_tool_categories / get_tool_signature)
      // are never gated themselves — they handle disabled-state internally.
      if (isToolDisabled(name) && name !== 'list_tool_categories' && name !== 'get_tool_signature') {
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              status: 'tool_disabled',
              tool: name,
              hint: 'This tool is disabled in the Hayba MCP panel — ask the user to re-enable it.',
            }, null, 2),
          }],
          isError: true,
        };
      }
      const result = await handler(params, ...rest);
      // Extract the text content the tool returned, when available — that's
      // what users care about in the stream. Fall back to the full object.
      let resultForMirror: unknown = result;
      if (result && typeof result === 'object') {
        const r = result as { content?: Array<{ type?: string; text?: string }> };
        if (Array.isArray(r.content)) {
          const text = r.content
            .filter(c => c?.type === 'text' && typeof c.text === 'string')
            .map(c => c.text)
            .join('\n');
          if (text) resultForMirror = text;
        }
      }
      mirror(name, params, resultForMirror).catch(() => {});
      return result;
    };

    args[args.length - 1] = wrapped;
    return orig(...args);
  };
}
