import { z } from 'zod';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ToolHandler } from '../types.js';
import { ensureConnected } from '../../tcp-client.js';
import type { HaybaToolMeta } from '../hayba-tool-meta.js';
import { scanPythonForCrashers, crashGuardMessage } from '../guards/known-crashers.js';
import { errorResult } from '../tool-result.js';

/**
 * When python_run output exceeds this many characters, spill the full payload
 * to a temp file and return a head + the path, instead of letting the transport
 * layer truncate it mid-output. See HANDOFF postmortem P1.
 */
const STDOUT_SPILL_THRESHOLD = 12_000;


export const meta: HaybaToolMeta = {
  cost: 'high',
  effects: ['runs_arbitrary_python', 'unknown_side_effects'],
  when: "executing a Python script via UE's PythonScriptPlugin for tasks not exposed by other commands",
  not_when: 'an existing actor_/asset_/blueprint_ command can do the job — prefer those',
};

export const schema = z.object({
  script: z.string().min(1),
  allow_unsafe: z.boolean().optional(),
});

/**
 * Wrap a user-supplied python script so its `print(...)` output surfaces in
 * `editor_stream_log` via `unreal.log_warning`.
 *
 * Background: the UE python handler returns `stdout: "None"` because UE's
 * embedded interpreter doesn't redirect sys.stdout back to the calling
 * process. The cleanest TS-only fix is to override the builtin `print` so
 * every print call routes through `unreal.log_warning`, which already shows
 * up in the LogPython warning stream — surfaced to MCP via
 * `editor_stream_log`.
 *
 * The wrapper preserves the user's script verbatim inside an `exec()` so
 * indentation, top-level `return`, etc. behave exactly as before. Errors in
 * the user script propagate as before (UE handler captures them into
 * stderr/error fields).
 */
export function wrapScriptForPrintRedirect(userScript: string): string {
  // We deliberately keep this string literal — no f-string interpolation of
  // user content, no eval. The user script is passed as data via a Python
  // triple-quoted string and `exec`'d with a fresh globals dict that has
  // print pre-bound to log_warning.
  const escaped = userScript
    .replace(/\\/g, '\\\\')
    .replace(/"""/g, '\\"\\"\\"');
  return [
    'import unreal as _hayba_unreal',
    'def _hayba_print(*args, **kwargs):',
    '    sep = kwargs.get("sep", " ")',
    '    _hayba_unreal.log_warning(sep.join(str(a) for a in args))',
    '_hayba_user_globals = {"__name__": "__main__", "print": _hayba_print, "unreal": _hayba_unreal}',
    `_hayba_user_src = """${escaped}"""`,
    'exec(compile(_hayba_user_src, "<python_run>", "exec"), _hayba_user_globals)',
  ].join('\n');
}

export const pythonRunHandler: ToolHandler = async (args) => {
  const parsed = schema.safeParse(args);
  if (!parsed.success) {
    return errorResult(`Validation error: ${parsed.error.message}`);
  }
  // Crash guardrail: refuse known editor-crashing calls unless explicitly
  // overridden with allow_unsafe. Returns guidance + a safe alternative.
  if (!(parsed.data as { allow_unsafe?: boolean }).allow_unsafe) {
    const hit = scanPythonForCrashers((parsed.data as { script: string }).script);
    if (hit) {
      return errorResult(crashGuardMessage(hit));
    }
  }
  try {
    const client = await ensureConnected();
    // Send the raw script. The UE handler now captures print()/stderr itself
    // (it injects a capturing print into the user code's exec globals) and
    // returns them in the stdout/stderr fields. Wrapping here too would
    // double-exec and route print to the log stream instead of the return value
    // — see the 2026-06-18 python_run stdout investigation. wrapScriptForPrintRedirect
    // stays exported for callers that explicitly want log-stream routing.
    const payload: Record<string, unknown> = {
      ...(parsed.data as Record<string, unknown>),
    };
    const resp = await client.send('python_run', payload);
    const data = (resp.data ?? {}) as Record<string, unknown>;
    if (!resp.ok) {
      if (data.tier === 3) {
        return errorResult(
          `Tier 3 (filesystem/subprocess) access blocked. Set bAllowUnsafePython=true in plugin settings or pass allow_unsafe:true to override (DANGEROUS). Underlying error: ${resp.error ?? 'unknown'}`,
          { tier: 3 },
        );
      }
      return errorResult(`python_run failed: ${resp.error ?? 'unknown error'}`);
    }
    const text = JSON.stringify(resp.data, null, 2);
    if (text.length > STDOUT_SPILL_THRESHOLD) {
      // Auto-spill: write the full payload to a temp file and return a head +
      // path so large dumps (pin lists, asset inventories) survive intact
      // instead of being truncated downstream.
      try {
        const dir = join(tmpdir(), 'hayba-python');
        mkdirSync(dir, { recursive: true });
        const file = join(dir, `python_run-${Date.now()}.json`);
        writeFileSync(file, text);
        const head = text.slice(0, STDOUT_SPILL_THRESHOLD);
        return {
          content: [{
            type: 'text',
            text: `${head}\n\n…[output truncated: ${text.length} chars]\nFull output written to: ${file}\nRead that file to get the complete result.`,
          }],
        };
      } catch {
        // Spill failed — fall through to returning the (large) text as-is.
      }
    }
    return { content: [{ type: 'text', text }] };
  } catch (e: unknown) {
    return errorResult(`python_run error: ${e instanceof Error ? e.message : String(e)}`);
  }
};
