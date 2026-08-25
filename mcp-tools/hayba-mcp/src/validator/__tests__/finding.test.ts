import { describe, it, expect } from 'vitest';
import {
  compareFindings,
  countBySeverity,
  fromConstraintResult,
  fromContentFinding,
  fromUiFinding,
  fromValidatorFinding,
  type Finding,
} from '../finding.js';

const base = (over: Partial<Finding> = {}): Finding => ({
  ruleId: 'r', category: 'general', severity: 'info', message: 'm', hint: 'h', ...over,
});

describe('Finding ordering', () => {
  it('sorts errors before warnings before info, then by rule id', () => {
    const sorted = [
      base({ ruleId: 'b', severity: 'info' }),
      base({ ruleId: 'a', severity: 'error' }),
      base({ ruleId: 'a', severity: 'info' }),
      base({ ruleId: 'z', severity: 'warning' }),
    ].sort(compareFindings);

    expect(sorted.map(f => `${f.severity}:${f.ruleId}`)).toEqual([
      'error:a', 'warning:z', 'info:a', 'info:b',
    ]);
  });

  it('counts every severity, including the ones with no findings', () => {
    expect(countBySeverity([base({ severity: 'error' }), base({ severity: 'error' })]))
      .toEqual({ error: 2, warning: 0, info: 0 });
  });
});

describe('adapters', () => {
  it('carries a validator finding across without losing its record fields', () => {
    const f = fromValidatorFinding({
      ruleId: 'pcg_asset_not_found',
      severity: 'error',
      message: 'no such asset',
      hint: 'check the path',
      refs: ['docs/pcg.md'],
      context: { path: '/Game/Nope' },
      timestamp: '2026-08-24T00:00:00.000Z',
      toolName: 'pcg_execute',
      resolved: true,
      resolvedAt: '2026-08-24T00:01:00.000Z',
    });

    // The timestamp is the stable record id used by resolve/clear, so an
    // adapter that dropped it would silently orphan every resolved finding.
    expect(f.timestamp).toBe('2026-08-24T00:00:00.000Z');
    expect(f.resolved).toBe(true);
    expect(f.data).toEqual({ path: '/Game/Nope' });
    expect(f.refs).toEqual(['docs/pcg.md']);
  });

  it('maps the per-category subject field onto one name', () => {
    const ui = fromUiFinding({
      ruleId: 'ui_touch_target', category: 'ui', severity: 'warning',
      widget: 'BtnConfirm', message: 'too small', hint: 'grow it', data: { px: 22 },
    });
    const content = fromContentFinding({
      ruleId: 'content_texture_memory', category: 'asset', severity: 'warning',
      asset: '/Game/T_Rock', message: 'heavy', hint: 'compress it', data: { kb: 8192 },
    });

    expect(ui.subject).toBe('BtnConfirm');
    expect(content.subject).toBe('/Game/T_Rock');
    expect(content.category).toBe('asset');
  });

  it('keeps the sign of a PLUMB margin, so the direction survives', () => {
    const f = fromConstraintResult({
      name: 'counter_height', primitive: 'min_clearance', ok: false, hard: true,
      magnitude: 0.28, value_m: -0.28, fix: { translate: [0, 0, 0.28] },
      detail: '62cm < 90cm',
    }, { category: 'general', subject: 'SM_Counter' });

    // -0.28 means 28cm SHORT. An unsigned magnitude cannot say which way.
    expect(f.measurement?.value).toBe(-0.28);
    expect(f.measurement?.fix?.translate).toEqual([0, 0, 0.28]);
    expect(f.severity).toBe('error');
    expect(f.message).toBe('62cm < 90cm');
  });

  it('reports a soft constraint as a warning, not an error', () => {
    const f = fromConstraintResult({
      name: '', primitive: 'prefer_against_wall', ok: false, hard: false,
      magnitude: 0.4, value_m: -0.4,
    });

    expect(f.severity).toBe('warning');
    // An anonymous constraint falls back to its primitive for an id rather
    // than producing a finding with an empty ruleId.
    expect(f.ruleId).toBe('prefer_against_wall');
  });
});
