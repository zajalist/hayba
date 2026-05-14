import { describe, it, expect } from 'vitest';
import { resolveRules } from './resolve.js';
import { seedCulture } from './presets.js';
import type { Era } from '../schema-v2.js';

function defaults(): Era['defaults'] {
  return {
    roofType: 'gabled',
    proportions: { columnSlenderness: 1, storyHeight: 1, doorAspect: 1 },
    palette: ['#aaaaaa'],
    ornamentDensity: 'moderate',
    technique: '',
  };
}

function makeCulture() {
  const c = seedCulture({ id: 'k', name: 'K', region: 'R', climate: 'temperate' });
  c.eras.push({ id: 'e', name: 'E', dateRange: [0, 100], defaults: defaults(), typologyMix: {}, rules: [] });
  return c;
}

describe('resolveRules', () => {
  it('returns {} when no rule matches', () => {
    expect(resolveRules(makeCulture(), 'e', 'temple', {})).toEqual({});
  });

  it('returns {} when eraId is unknown', () => {
    expect(resolveRules(makeCulture(), 'bogus', 'temple', {})).toEqual({});
  });

  it('selects rule by scenario match', () => {
    const c = makeCulture();
    c.rules.push({ id: 'r1', priority: 10, conditions: { scenario: 'temple', tagMatches: {} }, assigns: { materialId: 'limestone' } });
    expect(resolveRules(c, 'e', 'temple', {})).toEqual({ materialId: 'limestone' });
  });

  it('higher priority wins', () => {
    const c = makeCulture();
    c.rules.push(
      { id: 'a', priority: 10, conditions: { scenario: 'temple', tagMatches: {} }, assigns: { materialId: 'oak' } },
      { id: 'b', priority: 20, conditions: { scenario: 'temple', tagMatches: {} }, assigns: { materialId: 'limestone' } },
    );
    expect(resolveRules(c, 'e', 'temple', {}).materialId).toBe('limestone');
  });

  it('era rule shadows culture rule of the same id', () => {
    const c = makeCulture();
    c.rules.push({ id: 'r1', priority: 10, conditions: { scenario: 'temple', tagMatches: {} }, assigns: { materialId: 'oak' } });
    c.eras[0].rules.push({ id: 'r1', priority: 10, conditions: { scenario: 'temple', tagMatches: {} }, assigns: { materialId: 'mudbrick' } });
    expect(resolveRules(c, 'e', 'temple', {}).materialId).toBe('mudbrick');
  });

  it('era rule with new id appends, does not shadow', () => {
    const c = makeCulture();
    c.rules.push({ id: 'culture-rule', priority: 10, conditions: { scenario: 'temple', tagMatches: {} }, assigns: { materialId: 'oak' } });
    c.eras[0].rules.push({ id: 'era-rule', priority: 5, conditions: { scenario: 'temple', tagMatches: {} }, assigns: { materialId: 'mudbrick' } });
    // Higher priority culture rule wins
    expect(resolveRules(c, 'e', 'temple', {}).materialId).toBe('oak');
  });

  it('tagMatches must equal; missing condition is wildcard', () => {
    const c = makeCulture();
    c.rules.push({ id: 'r1', priority: 10, conditions: { tagMatches: { climate: 'arid' } }, assigns: { materialId: 'mudbrick' } });
    expect(resolveRules(c, 'e', 'temple', { climate: 'arid' }).materialId).toBe('mudbrick');
    expect(resolveRules(c, 'e', 'temple', { climate: 'temperate' })).toEqual({});
    expect(resolveRules(c, 'e', 'temple', {})).toEqual({});
  });

  it('priority tie-breaks: culture rule wins over era rule', () => {
    const c = makeCulture();
    c.rules.push({ id: 'a', priority: 10, conditions: { scenario: 'temple', tagMatches: {} }, assigns: { materialId: 'oak' } });
    c.eras[0].rules.push({ id: 'b', priority: 10, conditions: { scenario: 'temple', tagMatches: {} }, assigns: { materialId: 'mudbrick' } });
    expect(resolveRules(c, 'e', 'temple', {}).materialId).toBe('oak');
  });

  it('is deterministic across repeated calls', () => {
    const c = makeCulture();
    c.rules.push({ id: 'a', priority: 10, conditions: { scenario: 'temple', tagMatches: {} }, assigns: { materialId: 'oak' } });
    const r1 = resolveRules(c, 'e', 'temple', {});
    const r2 = resolveRules(c, 'e', 'temple', {});
    expect(r1).toEqual(r2);
  });
});
