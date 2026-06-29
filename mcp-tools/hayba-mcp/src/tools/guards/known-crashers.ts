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
