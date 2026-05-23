import { z } from 'zod';
import type { ToolHandler } from '../types.js';
import { ensureConnected } from '../../tcp-client.js';
import type { HaybaToolMeta } from '../hayba-tool-meta.js';

// TODO: wire into registerTools with RateLimiter + ToolCache + appendMeta wrapper

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
    return { content: [{ type: 'text', text: `Validation error: ${parsed.error.message}` }], isError: true };
  }
  try {
    const client = await ensureConnected();
    const wrapped = wrapScriptForPrintRedirect(parsed.data.script);
    const payload: Record<string, unknown> = {
      ...(parsed.data as Record<string, unknown>),
      script: wrapped,
    };
    const resp = await client.send('python_run', payload);
    const data = (resp.data ?? {}) as Record<string, unknown>;
    if (!resp.ok) {
      if (data.tier === 3) {
        return {
          content: [{
            type: 'text',
            text: `Tier 3 (filesystem/subprocess) access blocked. Set bAllowUnsafePython=true in plugin settings or pass allow_unsafe:true to override (DANGEROUS). Underlying error: ${resp.error ?? 'unknown'}`,
          }],
          isError: true,
        };
      }
      return { content: [{ type: 'text', text: `python_run failed: ${resp.error ?? 'unknown error'}` }], isError: true };
    }
    return { content: [{ type: 'text', text: JSON.stringify(resp.data, null, 2) }] };
  } catch (e: unknown) {
    return { content: [{ type: 'text', text: `python_run error: ${e instanceof Error ? e.message : String(e)}` }], isError: true };
  }
};
