/**
 * Chat tool-dispatch seam (Task 4).
 *
 * The agent loop (`src/chat/agent-loop.ts`) takes an injectable
 * `dispatchTool(name, args)`. Its `defaultDispatchTool` routes ONLY through the
 * UE bridge (`executeCommand`), so it cannot reach the many tools whose handler
 * resolves entirely in Node (TS-side captured tools). The authoritative captured
 * map lives inside `registerDeferredRouting` (src/tools/routing/register.ts) and
 * is not importable at module scope.
 *
 * To give the sidecar chat server FULL tool coverage without changing the loop
 * contract, `registerDeferredRouting` publishes its captured map here via
 * `registerChatCapturedTools()`. The dispatcher built by
 * `createChatDispatcher()` then:
 *
 *   1. prefers the captured TS handler if present (unwrapping the MCP
 *      `{content:[{type:'text',text}]}` envelope back into structured data), else
 *   2. falls through to `executeCommand` (the UE plugin TCP bridge).
 *
 * This mirrors the `hayba_invoke` dispatch (register.ts) so the copilot reaches
 * exactly the tools an MCP client would, and it preserves the C++ Plan-Mode
 * `{status:'plan_mode_required'}` pause payload from UE-bridged commands (the
 * loop detects it and pauses). If the captured map has not been published yet
 * (e.g. deferred routing disabled), the dispatcher degrades to UE-bridge only.
 */

import type { DispatchTool } from './agent-loop.js';
import { executeCommand } from '../tools/tool-executor.js';

/** Minimal structural shape of a captured tool (see routing/register.ts CapturedTool). */
interface CapturedToolLike {
  handler: (...args: unknown[]) => unknown;
}

let capturedTools: Map<string, CapturedToolLike> | null = null;

/**
 * Publish the deferred-routing captured-tool map for the chat dispatcher.
 * Called once from `registerDeferredRouting`. Idempotent (last write wins).
 */
export function registerChatCapturedTools(map: Map<string, CapturedToolLike>): void {
  capturedTools = map;
}

/** Test/introspection seam: is a captured map currently published? */
export function hasChatCapturedTools(): boolean {
  return capturedTools !== null;
}

/**
 * Unwrap an MCP tool result (`{content:[{type:'text',text}]}`) back into
 * structured data so the model — and the loop's plan-mode detector — see the
 * same JSON a UE-bridge dispatch would return. Non-MCP results pass through.
 */
export function unwrapMcpResult(result: unknown): unknown {
  if (
    result &&
    typeof result === 'object' &&
    Array.isArray((result as { content?: unknown }).content)
  ) {
    const content = (result as { content: Array<Record<string, unknown>> }).content;
    const first = content[0];
    if (first && first.type === 'text' && typeof first.text === 'string') {
      try {
        return JSON.parse(first.text);
      } catch {
        return first.text;
      }
    }
  }
  return result;
}

/**
 * Build the full-coverage dispatcher injected into `runAgentLoop`. Prefers a
 * captured TS handler; otherwise dispatches through the UE bridge.
 *
 * @param deps.captured  Override the published captured map (test seam).
 * @param deps.execute   Override the UE-bridge executor (test seam).
 */
export function createChatDispatcher(deps: {
  captured?: Map<string, CapturedToolLike> | null;
  execute?: (name: string, args: Record<string, unknown>) => Promise<unknown>;
} = {}): DispatchTool {
  const execute = deps.execute ?? executeCommand;
  return async (name, args) => {
    const map = deps.captured !== undefined ? deps.captured : capturedTools;
    const t = map?.get(name);
    if (t) {
      return unwrapMcpResult(await Promise.resolve(t.handler(args)));
    }
    return execute(name, args);
  };
}
