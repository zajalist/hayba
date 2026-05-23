import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  appendFinding,
  listFindings,
  markResolved,
  clearHistory,
  setHistoryPath,
  getHistoryPath,
} from '../history.js';
import type { ValidatorFinding } from '../rules.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'validator-hist-'));
  setHistoryPath(join(tmpDir, 'history.jsonl'));
});

afterEach(() => {
  setHistoryPath(null);
  rmSync(tmpDir, { recursive: true, force: true });
});

function mkFinding(overrides: Partial<ValidatorFinding> = {}): ValidatorFinding {
  return {
    ruleId: 'pcg_zero_instances_after_execute',
    severity: 'warning',
    message: 'test',
    hint: 'test',
    timestamp: new Date().toISOString(),
    toolName: 'pcg_execute_graph',
    ...overrides,
  };
}

describe('history', () => {
  it('append then list round-trips a finding', async () => {
    const f = mkFinding();
    await appendFinding(f);
    const all = await listFindings();
    expect(all).toHaveLength(1);
    expect(all[0].ruleId).toBe(f.ruleId);
  });

  it('respects limit option', async () => {
    for (let i = 0; i < 5; i++) {
      await appendFinding(mkFinding({ timestamp: `2026-05-23T00:00:0${i}Z` }));
    }
    const all = await listFindings({ limit: 3 });
    expect(all).toHaveLength(3);
  });

  it('hides resolved findings by default and surfaces them with includeResolved', async () => {
    const ts = '2026-05-23T00:00:00.000Z';
    await appendFinding(mkFinding({ timestamp: ts }));
    await markResolved(ts, true);

    const def = await listFindings();
    expect(def).toHaveLength(0);

    const withResolved = await listFindings({ includeResolved: true });
    expect(withResolved).toHaveLength(1);
    expect(withResolved[0].resolved).toBe(true);
    expect(withResolved[0].resolvedAt).toBeDefined();
  });

  it('markResolved(false) restores a finding', async () => {
    const ts = '2026-05-23T00:00:00.001Z';
    await appendFinding(mkFinding({ timestamp: ts }));
    await markResolved(ts, true);
    await markResolved(ts, false);
    const all = await listFindings();
    expect(all).toHaveLength(1);
    expect(all[0].resolved).toBe(false);
  });

  it('clearHistory returns count and empties file', async () => {
    await appendFinding(mkFinding({ timestamp: '2026-05-23T00:00:00.002Z' }));
    await appendFinding(mkFinding({ timestamp: '2026-05-23T00:00:00.003Z' }));
    const { removed } = await clearHistory();
    expect(removed).toBe(2);
    const all = await listFindings({ includeResolved: true });
    expect(all).toHaveLength(0);
  });

  it('filters by ruleIds and severities', async () => {
    await appendFinding(mkFinding({ timestamp: 'a', ruleId: 'pcg_asset_not_found', severity: 'error' }));
    await appendFinding(mkFinding({ timestamp: 'b', ruleId: 'pcg_zero_instances_after_execute', severity: 'warning' }));
    await appendFinding(mkFinding({ timestamp: 'c', ruleId: 'pcg_zero_instances_after_execute', severity: 'warning' }));

    const errs = await listFindings({ severities: ['error'] });
    expect(errs.map(f => f.timestamp)).toEqual(['a']);

    const justZero = await listFindings({ ruleIds: ['pcg_zero_instances_after_execute'] });
    expect(justZero).toHaveLength(2);
  });

  it('getHistoryPath honours the override', () => {
    expect(getHistoryPath()).toBe(join(tmpDir, 'history.jsonl'));
  });
});
