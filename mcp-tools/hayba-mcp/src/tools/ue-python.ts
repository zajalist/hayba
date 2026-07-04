import { executeCommand } from './tool-executor.js';

/**
 * Shared plumbing for tools that are implemented as generated UE Python rather
 * than a dedicated C++ handler. `python_run` is the de-facto UE API surface, so
 * the ergonomic wrappers (introspection, PCG primitives, cook-and-wait) all
 * funnel through here. See docs/HANDOFF-mcp-agent-ergonomics-postmortem.md.
 *
 * Contract: the generated script prints exactly one line of the form
 *   HAYBA_JSON:{...}
 * via the _emit() helper in PY_PREAMBLE. We parse that line back into a value.
 */

const MARKER = 'HAYBA_JSON:';

/**
 * Python preamble injected ahead of every generated script. Provides:
 *   _emit(obj)  → prints the sentinel-tagged JSON result line
 *   _err(msg)   → emits {"ok": false, "error": msg}
 * Generated scripts should wrap their body in try/except and call _err on
 * failure so the TS side always gets a structured response.
 */
export const PY_PREAMBLE = [
  'import json as _json, unreal as unreal',
  'def _emit(_o):',
  '    print("' + MARKER + '" + _json.dumps(_o, default=str))',
  'def _err(_m):',
  '    _emit({"ok": False, "error": str(_m)})',
].join('\n');

export interface UePythonResult {
  ok?: boolean;
  tier?: number;
  stdout?: string;
  stderr?: string;
  error?: string;
}

/**
 * Run a generated Python script in UE and parse its single HAYBA_JSON line.
 * Throws with the captured stdout/stderr when the marker is absent (a Python
 * exception before _emit, or python_run itself failing).
 */
export async function runUePythonJson<T = unknown>(script: string, timeout?: number): Promise<T> {
  const full = `${PY_PREAMBLE}\n${script}`;
  const data = await executeCommand<UePythonResult>('python_run', { script: full }, timeout ? { timeout } : {});
  // Plan Mode gates python_run as a destructive command. Surface that clearly
  // instead of the misleading "no HAYBA_JSON result" (live-validation finding:
  // the gate response has ok:true + empty stdout and was swallowed here).
  const gated = data as UePythonResult & { status?: string; hint?: string };
  if (gated.status === 'plan_mode_required') {
    throw new Error(
      `plan approval required: this tool runs UE Python, which Plan Mode gates as destructive. ${gated.hint ?? 'Call hayba_propose_plan and have the user click Approve in the Plan tab (or disable Plan Mode in the Hayba settings panel).'}`,
    );
  }
  const stdout = data.stdout ?? '';
  const idx = stdout.lastIndexOf(MARKER);
  if (idx === -1) {
    const tail = stdout.slice(-800);
    const err = data.stderr ? `\nstderr: ${data.stderr.slice(-800)}` : '';
    throw new Error(`python produced no HAYBA_JSON result.\nstdout: ${tail}${err}`);
  }
  // Take from just after the marker to the end of that line.
  const rest = stdout.slice(idx + MARKER.length);
  const line = rest.split('\n', 1)[0].trim();
  try {
    return JSON.parse(line) as T;
  } catch (e) {
    throw new Error(`failed to parse python JSON result: ${e instanceof Error ? e.message : String(e)}\nline: ${line.slice(0, 800)}`);
  }
}

/** Safely embed an arbitrary string as a Python single-quoted literal. */
export function pyStr(s: string): string {
  return "'" + s.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n').replace(/\r/g, '') + "'";
}
