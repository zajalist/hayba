import { beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const scripts = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts');

describe('survival harness raw transport helpers', () => {
  let results: Array<{ name: string; passed: boolean; elapsed_ms?: number }>;

  beforeAll(() => {
    const run = spawnSync('pwsh', [
      '-NoProfile', '-NonInteractive', '-File', join(scripts, 'test-survival-raw-helpers.ps1'),
      '-HarnessPath', join(scripts, 'test-editor-survival.ps1'),
    ], { encoding: 'utf8', timeout: 10_000, windowsHide: true });
    if (run.error) throw run.error;
    if (!run.stdout.trim()) throw new Error(`PowerShell helper tests produced no result: ${run.stderr}`);
    results = JSON.parse(run.stdout);
    expect(results).toHaveLength(4);
  }, 15_000);

  for (const scenario of ['endian_boundaries', 'fragmented_read', 'early_eof', 'stalled_deadline']) {
    it(scenario, () => {
      const result = results.find((item) => item.name === scenario);
      expect(result, scenario).toBeDefined();
      expect(result?.passed, JSON.stringify(result)).toBe(true);
    });
  }
});
