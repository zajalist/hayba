/**
 * Canonical MCP tool-result helpers.
 *
 * The canonical shape for all tool results is:
 *   { content: [{ type: 'text', text: string }], isError?: boolean }
 *
 * For errors the text block MUST be a JSON object:
 *   { ok: false, error: <message>, ...extra }
 *
 * These helpers are the single source of truth for that contract.
 * Adopt them only in wrappers whose error shape diverges from the canonical
 * one — do not churn every handler. Image content blocks (editor_capture_viewport)
 * are exempt and must not be routed through the text-only helpers here.
 */

import type { ToolResult } from './types.js';
import { VALIDATION_NUDGE } from './hayba-tool-meta.js';

/**
 * Append the post-mutation validation nudge to a successful tool result as an
 * ADDITIONAL text content block. Additive by design: the tool's original
 * content block(s) are left untouched (existing result shape is preserved), the
 * nudge rides alongside as a trailing `type:'text'` block the agent will read.
 *
 * Applied centrally at the registration seam (register-tool.ts) keyed off the
 * tool's scene-mutating `effects`, so it is DRY — not pasted into 40 handlers.
 * No-ops on error results (isError) and on non-text results (e.g. image blocks
 * from editor_capture_viewport), so nothing that already carries a validation
 * signal or a screenshot is disturbed.
 */
export function withValidationNudge(result: ToolResult): ToolResult {
  if (result.isError) return result;
  if (!Array.isArray(result.content)) return result;
  // Idempotent: never stack two nudges (a handler that already appended one).
  const already = result.content.some(
    (c) => c.type === 'text' && typeof c.text === 'string' && c.text.includes(VALIDATION_NUDGE),
  );
  if (already) return result;
  return {
    ...result,
    content: [
      ...result.content,
      { type: 'text' as const, text: VALIDATION_NUDGE },
    ],
  };
}

/**
 * Wrap a successful data payload as a canonical ToolResult text block.
 * The caller is responsible for keeping the externally-visible success
 * shape stable — this helper does not change what callers see.
 */
export function okResult(data: unknown): ToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
  };
}

/**
 * Return a canonical error result.  Serializes
 *   { ok: false, error: message, ...extra }
 * as the single text block, with isError: true.
 *
 * @param message  Human-readable error message.
 * @param extra    Optional extra fields merged into the payload
 *                 (e.g. { code: 'tier3', tier: 3 }).
 */
export function errorResult(
  message: string,
  extra?: Record<string, unknown>,
): ToolResult {
  const payload: Record<string, unknown> = { ...extra, ok: false, error: message };
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    isError: true,
  };
}
