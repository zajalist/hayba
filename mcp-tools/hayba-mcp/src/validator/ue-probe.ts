// The one thing validator rules need from UE: run a small python script and
// read back a number.
//
// Rules used to receive a raw `UETcpClient` and call `.send('python_run', …)`
// themselves. That handed every rule the whole transport surface to satisfy a
// single narrow need, forced three call sites to hand-roll their own
// `ensureConnected().catch(() => null)`, and meant unit-testing a rule required
// stubbing a TCP client. A rule now receives a `UeProbe` — one function — and
// the live implementation goes through the ToolExecutor seam like everything
// else, so it inherits the retry and timeout policy.

import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { executeCommand } from '../tools/tool-executor.js';

export interface ProbeResult {
  ok: boolean;
  /** Whatever the script printed. Empty string when the call failed. */
  stdout: string;
}

/** Run a python script inside the editor. Never throws — a dead editor is a
 *  "skip this rule" signal, not an error worth surfacing to the user. */
export type UeProbe = (script: string, timeoutMs: number) => Promise<ProbeResult>;

/** The production probe. Routed through `executeCommand` rather than a bare
 *  TCP send so validator follow-ups obey the same timeout/retry rules as
 *  ordinary tool calls. */
export const liveUeProbe: UeProbe = async (script, timeoutMs) => {
  try {
    const data = await executeCommand<Record<string, unknown>>(
      'python_run',
      { script, allow_unsafe: true },
      { timeout: timeoutMs },
    );
    return { ok: true, stdout: typeof data.stdout === 'string' ? data.stdout : '' };
  } catch {
    return { ok: false, stdout: '' };
  }
};

/**
 * Run a counter script and read back one integer.
 *
 * The scripts write their result to a JSON file under the project's `.scratch`
 * and also `print()` it. The file is preferred (it survives stdout truncation
 * on large scripts) with the printed value as fallback; the file is always
 * unlinked so a stale count from a previous run can never be misread as fresh.
 *
 * Returns `null` when the count could not be established — callers must treat
 * that as "don't fire", never as zero.
 */
export async function probeCount(
  probe: UeProbe | null,
  opts: { script: string; fileName: string; key: string; scratchDir: string; timeoutMs: number },
): Promise<number | null> {
  if (!probe) return null;
  const resp = await probe(opts.script, opts.timeoutMs);
  if (!resp.ok) return null;

  const outPath = join(opts.scratchDir, opts.fileName);
  if (existsSync(outPath)) {
    try {
      const parsed = JSON.parse(readFileSync(outPath, 'utf-8')) as Record<string, unknown>;
      const n = Number(parsed[opts.key]);
      if (Number.isFinite(n)) return n;
    } catch {
      // Fall through to the stdout fallback.
    } finally {
      try { unlinkSync(outPath); } catch { /* swallow */ }
    }
  }

  const m = resp.stdout.match(new RegExp(`"${opts.key}"\\s*:\\s*(-?\\d+)`));
  return m ? Number(m[1]) : null;
}
