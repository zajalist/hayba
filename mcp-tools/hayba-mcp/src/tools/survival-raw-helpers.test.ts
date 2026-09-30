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
