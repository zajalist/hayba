import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setConfigPath, setRuleDisabled, type Strictness } from '../config.js';
import { runCategoryRules, type RunnableRule } from '../run-category-rules.js';
import type { Finding } from '../finding.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'run-rules-'));
  setConfigPath(join(dir, 'config.json'));
});
afterEach(() => {
  setConfigPath(null);
  rmSync(dir, { recursive: true, force: true });
});

interface FakeCtx {
  value: number;
}

interface FakeRule extends RunnableRule<FakeCtx> {
  /** Stands in for UI's `needsLayout` / content's `needs`. */
  needsData: boolean;
  evaluate: (ctx: FakeCtx) => Finding[];
}

function rule(id: string, over: Partial<FakeRule> = {}): FakeRule {
  return {
    id,
    category: 'general',
    minStrictness: 'relaxed',
    needsData: false,
    evaluate: () => [
      { ruleId: id, category: 'general', severity: 'warning', message: `${id} fired`, hint: '' },
    ],
    ...over,
  };
}

function run(rules: FakeRule[], opts: { strictness?: Strictness; ruleIds?: string[]; dataPresent?: boolean } = {}) {
  return runCategoryRules({
    rules,
    byId: new Map(rules.map((r) => [r.id, r])),
    ruleIds: opts.ruleIds,
    ctx: { value: 1 },
    strictness: opts.strictness ?? 'standard',
    hasNothingToCheck: (r) => r.needsData && !(opts.dataPresent ?? false),
  });
}

describe('runCategoryRules', () => {
  it('evaluates rules and counts findings by severity', () => {
    const out = run([
      rule('a'),
      rule('b', {
        evaluate: () => [
          { ruleId: 'b', category: 'general', severity: 'error', message: 'bad', hint: '' },
        ],
      }),
    ]);
    expect(out.evaluated).toBe(2);
    expect(out.counts).toEqual({ error: 1, warning: 1, info: 0 });
  });

  it('sorts findings by severity, then rule id', () => {
    const mk = (id: string, severity: Finding['severity']) =>
      rule(id, { evaluate: () => [{ ruleId: id, category: 'general', severity, message: '', hint: '' }] });
    const out = run([mk('z', 'info'), mk('b', 'error'), mk('a', 'error'), mk('m', 'warning')]);
    expect(out.findings.map((f) => f.ruleId)).toEqual(['a', 'b', 'm', 'z']);
  });

  // The property the whole extraction exists to protect: three different
  // reasons a rule didn't run, none of them reported as "passed".
  it('reports a rule with no data as skipped, not as evaluated', () => {
    const out = run([rule('needs-it', { needsData: true }), rule('fine')]);
    expect(out.skipped).toEqual(['needs-it']);
    expect(out.evaluated).toBe(1);
    expect(out.findings.map((f) => f.ruleId)).toEqual(['fine']);
  });

  it('reports a disabled rule as disabled, not as evaluated', () => {
    setRuleDisabled('off', true);
    const out = run([rule('off'), rule('on')]);
    expect(out.disabled).toEqual(['off']);
    expect(out.evaluated).toBe(1);
  });

  it('reports a rule above the configured strictness as below-strictness', () => {
    const out = run([rule('strict-only', { minStrictness: 'strict' }), rule('always')], {
      strictness: 'relaxed',
    });
    expect(out.belowStrictness).toEqual(['strict-only']);
    expect(out.evaluated).toBe(1);
  });

  it('never counts a skipped rule in evaluated, whatever the reason', () => {
    setRuleDisabled('off', true);
    const out = run([
      rule('off'),
      rule('strict-only', { minStrictness: 'strict' }),
      rule('needs-it', { needsData: true }),
    ], { strictness: 'relaxed' });
    expect(out.evaluated).toBe(0);
    expect(out.findings).toEqual([]);
    expect([...out.disabled, ...out.belowStrictness, ...out.skipped].sort()).toEqual([
      'needs-it',
      'off',
      'strict-only',
    ]);
  });

  it('surfaces a throwing rule as an info finding without losing the others', () => {
    const boom = rule('boom', {
      evaluate: () => {
        throw new Error('kaboom');
      },
    });
    const out = run([boom, rule('survivor')]);
    const thrown = out.findings.find((f) => f.ruleId === 'boom');
    expect(thrown?.severity).toBe('info');
    expect(thrown?.hint).toBe('kaboom');
    // The point: one broken rule must not cost the caller every other finding.
    expect(out.findings.map((f) => f.ruleId)).toContain('survivor');
  });

  it('narrows the run to ruleIds and ignores unknown ids', () => {
    const out = run([rule('a'), rule('b'), rule('c')], { ruleIds: ['b', 'nope'] });
    expect(out.evaluated).toBe(1);
    expect(out.findings.map((f) => f.ruleId)).toEqual(['b']);
  });
});
