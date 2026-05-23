import { describe, expect, it } from 'vitest';
import { RULES, rulesById, rulesForTool, type ValidatorRule } from '../rules.js';

describe('rules catalog', () => {
  it('seeds at least 10 rules', () => {
    expect(RULES.length).toBeGreaterThanOrEqual(10);
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

  it('contains the five canonical Section F rule ids', () => {
    const ids = new Set(RULES.map(r => r.id));
    for (const required of [
      'pcg_zero_instances_after_execute',
      'pcg_surface_source_not_landscape',
      'unreal_landscape_placeholder',
      'tcp_socket_to_self_in_python_run',
      'actor_position_drift_after_user_edit',
    ]) {
      expect(ids.has(required)).toBe(true);
    }
  });

  it('contains the five other AI-floppy postmortem rules', () => {
    const ids = new Set(RULES.map(r => r.id));
    for (const required of [
      'pcg_execute_no_component_in_world',
      'pcg_asset_not_found',
      'landscape_import_no_landscape_in_world',
      'actor_spawn_class_not_found',
      'asset_browse_describe_assets_missing',
    ]) {
      expect(ids.has(required)).toBe(true);
    }
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
