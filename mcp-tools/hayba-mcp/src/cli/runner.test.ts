import { describe, it, expect, vi } from 'vitest';
import { runSpec } from './runner.js';
import { EXIT_OK, EXIT_STEP_FAILED, EXIT_UE_UNREACHABLE } from './exit-codes.js';
import type { CliSpec } from './spec.js';

function spec(steps: CliSpec['steps']): CliSpec {
  return { version: 1, steps };
}

describe('runSpec', () => {
  it('returns EXIT_OK and runs every step in order when all succeed', async () => {
    const calls: Array<{ cmd: string; params: Record<string, unknown> }> = [];
    const execute = vi.fn(async (cmd: string, params: Record<string, unknown>) => {
      calls.push({ cmd, params });
      return { ok: true };
    });

    const result = await runSpec(spec([{ cmd: 'ping' }, { cmd: 'actor_spawn', params: { class: 'Foo' } }]), {
      checkReachable: async () => ({ reachable: true, detail: '' }),
      execute,
    });

    expect(result.exitCode).toBe(EXIT_OK);
    expect(result.stepsRun).toBe(2);
    expect(result.stepsTotal).toBe(2);
    expect(calls).toEqual([
      { cmd: 'ping', params: {} },
      { cmd: 'actor_spawn', params: { class: 'Foo' } },
    ]);
  });

  it('returns EXIT_UE_UNREACHABLE and never calls execute when UE is unreachable', async () => {
    const execute = vi.fn();

    const result = await runSpec(spec([{ cmd: 'ping' }]), {
      checkReachable: async () => ({ reachable: false, detail: 'no editor on port 52342' }),
      execute,
    });

    expect(result.exitCode).toBe(EXIT_UE_UNREACHABLE);
    expect(result.message).toMatch(/no editor on port 52342/);
    expect(result.stepsRun).toBe(0);
    expect(execute).not.toHaveBeenCalled();
  });

  it('returns EXIT_STEP_FAILED at the first failing step and stops — later steps never run', async () => {
    const calls: string[] = [];
    const execute = vi.fn(async (cmd: string) => {
      calls.push(cmd);
      if (cmd === 'boom') throw new Error('UE said no');
      return { ok: true };
    });

    const result = await runSpec(spec([{ cmd: 'ping' }, { cmd: 'boom' }, { cmd: 'never_reached' }]), {
      checkReachable: async () => ({ reachable: true, detail: '' }),
      execute,
    });

    expect(result.exitCode).toBe(EXIT_STEP_FAILED);
    expect(result.stepsRun).toBe(1); // one step (ping) completed before the failure
    expect(result.failedStep).toEqual({ index: 1, cmd: 'boom', error: 'UE said no' });
    expect(calls).toEqual(['ping', 'boom']); // never_reached must not have been called
  });

  it('includes the step name in the failure message when provided', async () => {
    const execute = vi.fn(async () => {
      throw new Error('nope');
    });

    const result = await runSpec(spec([{ cmd: 'weird_cmd', name: 'build lighting' }]), {
      checkReachable: async () => ({ reachable: true, detail: '' }),
      execute,
    });

    expect(result.message).toMatch(/build lighting/);
    expect(result.message).toMatch(/weird_cmd/);
  });

  it('logs a progress line per step via the injected logger', async () => {
    const lines: string[] = [];
    const execute = vi.fn(async () => ({ ok: true }));

    await runSpec(spec([{ cmd: 'a' }, { cmd: 'b' }]), {
      checkReachable: async () => ({ reachable: true, detail: '' }),
      execute,
      log: (msg) => lines.push(msg),
    });

    expect(lines).toEqual(['[1/2] a', '[2/2] b']);
  });
});
