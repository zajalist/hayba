import { beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const scripts = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts');

describe('survival harness raw transport helpers', () => {
  let results: Array<{ name: string; passed: boolean; elapsed_ms?: number }>;
  let exitStatus: number | null;
  let diagnostics: string;

  beforeAll(() => {
    const run = spawnSync('pwsh', [
      '-NoProfile', '-NonInteractive', '-File', join(scripts, 'test-survival-raw-helpers.ps1'),
      '-HarnessPath', join(scripts, 'test-editor-survival.ps1'),
      '-InvokerPath', join(scripts, 'invoke-tcp-command.ps1'),
    ], { encoding: 'utf8', timeout: 10_000, windowsHide: true });
    if (run.error) throw run.error;
    if (!run.stdout.trim()) throw new Error(`PowerShell helper tests produced no result: ${run.stderr}`);
    results = JSON.parse(run.stdout);
    exitStatus = run.status;
    diagnostics = run.stderr;
    expect(results).toHaveLength(11);
  }, 15_000);

  for (const scenario of ['endian_boundaries', 'fragmented_read', 'early_eof', 'stalled_deadline',
    'invoker_fragmented_read', 'invoker_early_eof', 'invoker_stalled_deadline',
    'truncated_header_halfclose', 'truncated_body_halfclose', 'delayed_peer_eof', 'nonclosing_peer_deadline']) {
    it(scenario, () => {
      const result = results.find((item) => item.name === scenario);
      expect(result, scenario).toBeDefined();
      expect(result?.passed, JSON.stringify(result)).toBe(true);
    });
  }
  it('completes the subprocess successfully without unexpected diagnostics', () => {
    expect(exitStatus, diagnostics).toBe(0);
    expect(diagnostics).toBe('');
  });
});

describe('survival harness client admission and closure probes', () => {
  const scenarios = [
    'flood_admission_and_capacity', 'limit_admission_and_capacity', 'limit_reset_capacity',
    'slowloris_admitted_expiry', 'slowloris_premature_close', 'uncorrelated_admission_cleanup',
    'slowloris_delayed_successful_drip_rejected', 'slowloris_delayed_successful_drip_gap_recorded',
    'overflow_response_is_not_rejection', 'expired_holders_are_not_capacity_proof', 'flood_deadline_is_not_rejection',
    'slowloris_default_limits', 'limit_minimum_client_count', 'null_close_task_is_not_closure',
    'unrelated_error_is_not_closure', 'early_close_completion_timestamp', 'socket_timeout_is_not_closure',
    'wrapped_reset_is_close_evidence', 'wrapped_aborted_is_close_evidence',
  ];
  let results: Array<{ name: string; passed: boolean; elapsed_ms?: number }>;
  let exitStatus: number | null;
  let diagnostics: string;

  beforeAll(() => {
    const run = spawnSync('pwsh', [
      '-NoProfile', '-NonInteractive', '-File', join(scripts, 'test-survival-client-probes.ps1'),
      '-HarnessPath', join(scripts, 'test-editor-survival.ps1'),
    ], { encoding: 'utf8', timeout: 20_000, windowsHide: true });
    if (run.error) throw run.error;
    if (!run.stdout.trim()) throw new Error(`PowerShell client probes produced no result: ${run.stderr}`);
    results = JSON.parse(run.stdout);
    exitStatus = run.status;
    diagnostics = run.stderr;
    expect(results).toHaveLength(scenarios.length);
  }, 25_000);

  for (const scenario of scenarios) {
    it(scenario, () => {
      const result = results.find((item) => item.name === scenario);
      expect(result, scenario).toBeDefined();
      expect(result?.passed, JSON.stringify(result)).toBe(true);
    });
  }
  it('completes the subprocess successfully without unexpected diagnostics', () => {
    expect(exitStatus, diagnostics).toBe(0);
    expect(diagnostics).toBe('');
  });
});
