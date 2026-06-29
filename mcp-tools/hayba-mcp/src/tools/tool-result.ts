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
  const payload: Record<string, unknown> = { ok: false, error: message, ...extra };
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    isError: true,
  };
}
