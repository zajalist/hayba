/**
 * Refusal layer for commands/python patterns known to crash or wedge the UE
 * editor. On a hit we return guidance that names a safe alternative instead of
 * taking the editor down. Grounded in repeated incidents — see
 * docs/HANDOFF-mcp-agent-ergonomics-postmortem.md (P2) and project memory.
 */

export interface CrashGuardHit {
  pattern: string;
  reason: string;
  alternative: string;
}

/** Python substrings that have crashed the editor, with safe alternatives. */
const PYTHON_CRASHERS: CrashGuardHit[] = [
  {
    pattern: 'set_lod_build_settings',
    reason: 'set_lod_build_settings crashes the editor and does not update bounds',
    alternative: 'use GeometryScript append_box/transform_mesh + copy_mesh_to_static_mesh to rebuild geometry',
  },
  {
    pattern: 'build_scale3d',
    reason: 'build_scale3d crashes the editor and does not update bounds',
    alternative: 'use GeometryScript append_box/transform_mesh + copy_mesh_to_static_mesh',
  },
  // World-switching from python_run kills the editor: python_run runs on the
  // game thread mid-tick (TCP drain), and a map load/create tears down the
  // current UWorld / swaps GWorld under the in-flight tick → the engine asserts
  // `CurrentGWorld == EditorContext.World()` (EditorEngine.cpp:1745). The SEH
  // guard catches the first access violation but cannot reconcile the desync, so
  // the assert on a later tick is unavoidable. Confirmed repro (2026-07-05
  // HANDOFF-mcp-worldswitch-crash-guardrail). Structural — never do this here.
  ...([
    'new_blank_map',
    'new_map_from_template',
    'load_map',
    'new_level',
    'load_level',
  ].map((p): CrashGuardHit => ({
    pattern: p,
    reason:
      `world-switching from python_run ('${p}') tears down GWorld mid-tick and crashes the editor with the EditorEngine.cpp:1745 assert (GWorld/EditorContext desync); the SEH guard cannot recover it`,
    alternative:
      'switch or create maps from the editor UI (or a deferred editor_open_map command that schedules the load outside the command tick) — never load/create a map from python_run',
  }))),
];

/**
 * Scan a python script for known-crash calls.
 * Returns the first hit, or null if the script looks safe.
 * Callers may bypass with an explicit allow flag.
 */
export function scanPythonForCrashers(script: string): CrashGuardHit | null {
  for (const c of PYTHON_CRASHERS) {
    if (script.includes(c.pattern)) return c;
  }
  return null;
}

/** Build the user-facing refusal text for a crash-guard hit. */
export function crashGuardMessage(hit: CrashGuardHit): string {
  return [
    `Blocked: "${hit.pattern}" is a known editor-crasher (${hit.reason}).`,
    `Safe alternative: ${hit.alternative}.`,
    `If you are certain and accept the risk, re-run with allow_unsafe:true.`,
  ].join('\n');
}
