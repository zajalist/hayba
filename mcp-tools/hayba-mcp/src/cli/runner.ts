// mcp_server/src/cli/runner.ts
import type { CliSpec } from './spec.js';
import { EXIT_OK, EXIT_STEP_FAILED, EXIT_UE_UNREACHABLE } from './exit-codes.js';

export interface ReachabilityCheck {
  reachable: boolean;
  /** Human-readable explanation, only meaningful when reachable === false. */
  detail: string;
}

export interface RunnerDeps {
  /** Pre-flight: is UE reachable at all, before spending a step on it. */
  checkReachable: () => Promise<ReachabilityCheck>;
  /** Send one command over the same seam every MCP tool uses
   *  (tool-executor's `executeCommand`). Rejects on failure. */
  execute: (cmd: string, params: Record<string, unknown>) => Promise<Record<string, unknown>>;
  /** Progress line per step. Defaults to a no-op so tests stay quiet. */
  log?: (message: string) => void;
}

export interface FailedStep {
  index: number;
  cmd: string;
  error: string;
}

export interface RunResult {
  exitCode: number;
  message: string;
  /** Number of steps that completed successfully before stopping. */
  stepsRun: number;
  stepsTotal: number;
  failedStep?: FailedStep;
}

/**
 * Execute a validated spec's steps in order against UE, stopping at the
 * first failure. Never throws — every outcome, including an unreachable UE
 * or a failing step, comes back as a {@link RunResult} with an exit code the
 * caller can hand straight to `process.exit`.
 */
export async function runSpec(spec: CliSpec, deps: RunnerDeps): Promise<RunResult> {
  const log = deps.log ?? (() => {});
  const total = spec.steps.length;

  const reachability = await deps.checkReachable();
  if (!reachability.reachable) {
    return {
      exitCode: EXIT_UE_UNREACHABLE,
      message: `UE unreachable — ${reachability.detail}`,
      stepsRun: 0,
      stepsTotal: total,
    };
  }

  for (let i = 0; i < total; i++) {
    const step = spec.steps[i];
    const label = step.name ?? step.cmd;
    log(`[${i + 1}/${total}] ${label}`);
    try {
      await deps.execute(step.cmd, step.params ?? {});
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      return {
        exitCode: EXIT_STEP_FAILED,
        message: `step ${i + 1}/${total} ("${label}", cmd="${step.cmd}") failed: ${errMsg}`,
        stepsRun: i,
        stepsTotal: total,
        failedStep: { index: i, cmd: step.cmd, error: errMsg },
      };
    }
  }

  return {
    exitCode: EXIT_OK,
    message: `all ${total} step${total === 1 ? '' : 's'} completed`,
    stepsRun: total,
    stepsTotal: total,
  };
}
