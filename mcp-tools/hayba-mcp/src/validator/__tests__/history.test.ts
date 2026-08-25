import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
import type { FindingRecord } from '../history.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'validator-hist-'));
  setHistoryPath(join(tmpDir, 'history.jsonl'));
});

afterEach(() => {
  setHistoryPath(null);
  rmSync(tmpDir, { recursive: true, force: true });
});

function mkFinding(overrides: Partial<FindingRecord> = {}): FindingRecord {
  return {
    ruleId: 'pcg_zero_instances_after_execute',
    category: 'pcg',
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

describe('records written before the verdict collapse', () => {
  // A user upgrading has a history file full of the old shape. Losing it to a
  // refactor would be a worse outcome than the refactor is worth, so the read
  // side adapts instead of the write side rewriting.
  const legacyLine = JSON.stringify({
    ruleId: 'pcg_asset_not_found',
    severity: 'error',
    message: 'no such asset',
    hint: 'check the path',
    context: { assetPath: '/Game/Missing' },
    timestamp: '2026-01-01T00:00:00.000Z',
    toolName: 'pcg_execute_graph',
  });

  it('still load, with context read as data', async () => {
    writeFileSync(getHistoryPath(), legacyLine + '\n', 'utf-8');

    const [f] = await listFindings({ includeResolved: true });

    expect(f?.ruleId).toBe('pcg_asset_not_found');
    expect(f?.data).toEqual({ assetPath: '/Game/Missing' });
    // The old shape had no category at all; `general` is the honest answer
    // rather than guessing a subsystem from the rule id.
    expect(f?.category).toBe('general');
    expect('context' in (f as object)).toBe(false);
  });

  it('can still be resolved by timestamp after adapting', async () => {
    writeFileSync(getHistoryPath(), legacyLine + '\n', 'utf-8');

    // The timestamp is the record id. If migration dropped or changed it, a
    // user could see a finding but never clear it.
    expect(await markResolved('2026-01-01T00:00:00.000Z', true)).toBe(true);
    expect(await listFindings()).toEqual([]);
  });

  it('do not disturb records already in the new shape', async () => {
    const modern = JSON.stringify(mkFinding({ category: 'landscape', data: { n: 1 } }));
    writeFileSync(getHistoryPath(), modern + '\n', 'utf-8');

    const [f] = await listFindings({ includeResolved: true });
    expect(f?.category).toBe('landscape');
    expect(f?.data).toEqual({ n: 1 });
  });
});
