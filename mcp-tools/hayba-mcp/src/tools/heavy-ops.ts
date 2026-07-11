/**
 * Heavy-operation registry.
 *
 * These UE commands run synchronously on the editor game thread and can block
 * it for tens of seconds (gigabyte gltf imports, world-partition level saves,
 * full PCG generates, landscape imports, asset re-index). While one is in
 * flight the plugin's TCP listener stops accepting connections, so a naive
 * tool call either hangs with no signal or hits ECONNREFUSED and reads as a
 * crash. The executor treats commands in this set specially:
 *   - a dedicated, generous "heavy" timeout tier (not the normal cost tier), and
 *   - NEVER auto-retrying on transport failure (retrying a busy editor
 *     compounds the stall, and these ops are effectively non-idempotent).
 *
 * The set is extensible at runtime via {@link addHeavyOp} so new blocking
 * commands (or aliases) can be registered without editing this file.
 */

/** Dedicated timeout for heavy ops (ms). Generous because a large import /
 *  world-partition save legitimately runs for minutes on the game thread. */
export const HEAVY_OP_TIMEOUT_MS = 300_000;

const HEAVY_OPS = new Set<string>([
  // Asset import — a large gltf/fbx import blocks the game thread for the
  // whole cook/import, and re-running would create duplicate assets.
  'asset_import',
  // Landscape import (both the C++ handler name and the alias used by callers).
  'landscape_import',
  'import_landscape',
  // Level save — world-partition saves serialise every dirty actor on the
  // game thread and hold the port for tens of seconds.
  'level_save',
  'save_current_level',
  // PCG generate — a full graph execution on a large volume stalls the editor.
  'pcg_execute_graph',
  'hayba_execute_pcg_graph',
  // Asset re-index — a full asset-registry rescan / embedding rebuild.
  'hayba_asset_reindex',
  'asset_reindex',
]);

/** Register an additional command as a heavy (game-thread-blocking) op. */
export function addHeavyOp(cmd: string): void {
  HEAVY_OPS.add(cmd);
}

/** Unregister a runtime-added heavy op. Returns true if it was present.
 *  (Built-in defaults can be removed too; primarily for test isolation.) */
export function removeHeavyOp(cmd: string): boolean {
  return HEAVY_OPS.delete(cmd);
}

/** True when `cmd` is known to block the UE game thread. */
export function isHeavyOp(cmd: string): boolean {
  return HEAVY_OPS.has(cmd);
}

/** Snapshot of the current heavy-op set (for diagnostics / tests). */
export function listHeavyOps(): string[] {
  return [...HEAVY_OPS].sort();
}
