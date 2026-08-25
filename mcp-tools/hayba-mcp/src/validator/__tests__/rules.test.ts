import { describe, expect, it } from 'vitest';
import { RULES, rulesById, rulesForTool, type ValidatorRule } from '../rules.js';

describe('rules catalog', () => {
  // The floor is here to catch an accidental truncation of the catalogue, not
  // to assert a target size. It was 10 while four rules had no evaluator; the
  // useful guarantee is the one below -- every rule that is listed can fire.
  it('seeds a non-empty rule catalogue', () => {
    expect(RULES.length).toBeGreaterThanOrEqual(7);
  });

  it('each rule has every required field', () => {
    for (const r of RULES) {
      expect(r.id).toBeTruthy();
      expect(['error', 'warning', 'info']).toContain(r.severity);
      expect(typeof r.message).toBe('string');
      expect(r.message.length).toBeGreaterThan(0);
      expect(typeof r.hint).toBe('string');
      expect(r.hint.length).toBeGreaterThan(0);
      // trigger is either 'manual' or { after_tool: ... }
      if (r.trigger !== 'manual') {
        expect(r.trigger).toHaveProperty('after_tool');
      }
    }
  });

  it('rule ids are unique', () => {
    const ids = RULES.map(r => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  // These tests used to assert that ten specific rule ids were present,
  // including four that had no evaluator and could never fire. That pinned the
  // dishonesty in place: the Configure panel listed checks the product would
  // never run, and the suite defended it.
  //
  // The inverted assertion is the useful one. A rule that cannot fire must not
  // be catalogued, because the catalogue is what users read as a promise.
  it('every catalogued rule can actually fire', async () => {
    const { installToolHooks } = await import('../tool-hooks.js');
    installToolHooks();

    // dangling_lifetime_callback_in_python_run is enforced before execution in
    // tools/python-run-validator-wrap.ts rather than through an evaluator, so
    // it is live without one.
    const ENFORCED_ELSEWHERE = new Set(['dangling_lifetime_callback_in_python_run']);

    const dead = RULES
      .filter(r => !r.evaluate && !ENFORCED_ELSEWHERE.has(r.id))
      .map(r => r.id);

    expect(dead).toEqual([]);
  });

  it('rulesForTool returns all rules whose after_tool matches', () => {
    const matches = rulesForTool('hayba_execute_pcg_graph');
    const ids = matches.map(r => r.id);
    expect(ids).toContain('pcg_zero_instances_after_execute');
    expect(ids).toContain('pcg_execute_no_component_in_world');
    expect(ids).toContain('pcg_asset_not_found');
  });

  it('rulesById builds a lookup map of the catalog', () => {
    const map = rulesById();
    for (const r of RULES) {
      expect(map.get(r.id)?.id).toBe(r.id);
    }
  });

  it('manual rules are not returned by rulesForTool', () => {
    const manualRule = RULES.find(r => r.trigger === 'manual') as ValidatorRule;
    expect(manualRule).toBeDefined();
    for (const r of rulesForTool(manualRule.id)) {
      // manual rules should never show up regardless of tool name
      expect(r.id).not.toBe(manualRule.id);
    }
  });
});
