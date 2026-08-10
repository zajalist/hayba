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

import { executeCommand } from '../tools/tool-executor.js';

export const MAX_VALIDATOR_PROBE_STDOUT_BYTES = 16 * 1024;

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
    const data = await executeCommand<Record<string, unknown>>('python_run', { script }, { timeout: timeoutMs });
    if (typeof data.stdout !== 'string' || Buffer.byteLength(data.stdout, 'utf8') > MAX_VALIDATOR_PROBE_STDOUT_BYTES) {
      return { ok: false, stdout: '' };
    }
    return { ok: true, stdout: data.stdout };
  } catch {
    return { ok: false, stdout: '' };
  }
};

/**
 * Run a counter script and read back one integer from one bounded stdout JSON
 * object. Unreal Python never owns a scratch path, so a failed/timed-out probe
 * cannot leave stale evidence for the next validation pass.
 *
 * Returns `null` when the count could not be established — callers must treat
 * that as "don't fire", never as zero.
 */
export async function probeCount(
  probe: UeProbe | null,
  opts: { script: string; key: string; timeoutMs: number },
): Promise<number | null> {
  if (!probe) return null;
  const resp = await probe(opts.script, opts.timeoutMs);
  if (!resp.ok) return null;
  if (Buffer.byteLength(resp.stdout, 'utf8') > MAX_VALIDATOR_PROBE_STDOUT_BYTES) return null;
  try {
    const parsed: unknown = JSON.parse(resp.stdout.trim());
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const value = (parsed as Record<string, unknown>)[opts.key];
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
  } catch {
    return null;
  }
}
