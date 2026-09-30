import { beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const scripts = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts');
const scenarios = ['outside_pie', 'expected_pie', 'start_stop_proofs', 'pie_unexpected_success',
  'pie_wrong_code', 'pie_missing_code', 'pie_stdout', 'pie_nonce_echo', 'missing_nonce', 'wrong_nonce',
  'pie_malformed_ok', 'pie_malformed_code', 'pie_top_stdout', 'pie_nonce_in_error',
  'outside_refusal', 'unexpected_pie', 'expected_pie_absent', 'wrong_map', 'dirty_state',
  'failed_native_read', 'failed_correlation', 'failed_ping'];

describe('survival harness policy-aware health proofs', () => {
  let results: Array<{ name: string; passed: boolean }>;
  let exitStatus: number | null;
  let diagnostics: string;
  beforeAll(() => {
    const run = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-File',
      join(scripts, 'test-survival-health-probes.ps1'), '-HarnessPath',
      join(scripts, 'test-editor-survival.ps1')], { encoding: 'utf8', timeout: 10_000, windowsHide: true });
    if (run.error) throw run.error;
    if (!run.stdout.trim()) throw new Error(`Health proof tests produced no result: ${run.stderr}`);
    results = JSON.parse(run.stdout);
    exitStatus = run.status;
    diagnostics = run.stderr;
    expect(results).toHaveLength(scenarios.length);
  }, 15_000);
  for (const scenario of scenarios) {
    it(scenario, () => {
      const result = results.find((item) => item.name === scenario);
      expect(result, scenario).toBeDefined();
      expect(result?.passed, JSON.stringify(result)).toBe(true);
    });
  }
  it('completes successfully without unexpected diagnostics', () => {
    expect(exitStatus, diagnostics).toBe(0);
    expect(diagnostics).toBe('');
  });
});
