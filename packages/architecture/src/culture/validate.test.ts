import { describe, it, expect } from 'vitest';
import { validateCulture } from './validate.js';
import { seedCulture } from './presets.js';
import type { Era } from '../schema-v2.js';

function defaultsFixture(): Era['defaults'] {
  return {
    roofType: 'gabled',
    proportions: { columnSlenderness: 1, storyHeight: 1, doorAspect: 1 },
    palette: ['#aaaaaa'],
    ornamentDensity: 'moderate',
    technique: '',
  };
}

describe('validateCulture', () => {
  it('returns ok=true for a clean seeded culture', () => {
    const r = validateCulture(seedCulture({ id: 'foo', name: 'Foo', region: 'R', climate: 'temperate' }));
    expect(r.ok).toBe(true);
    expect(r.issues).toEqual([]);
  });

  it('flags rule referencing unknown material', () => {
    const c = seedCulture({ id: 'foo', name: 'Foo', region: 'R', climate: 'temperate' });
    c.rules.push({ id: 'r1', priority: 1, conditions: { tagMatches: {} }, assigns: { materialId: 'nope' } });
    const r = validateCulture(c);
    expect(r.ok).toBe(false);
    expect(r.issues.some(i => i.path.includes('rules[0].assigns.materialId'))).toBe(true);
  });

  it('flags rule referencing unknown ornament', () => {
    const c = seedCulture({ id: 'foo', name: 'Foo', region: 'R', climate: 'temperate' });
    c.rules.push({ id: 'r1', priority: 1, conditions: { tagMatches: {} }, assigns: { ornamentIds: ['nope'] } });
    const r = validateCulture(c);
    expect(r.issues.some(i => i.path.includes('rules[0].assigns.ornamentIds[0]'))).toBe(true);
  });

  it('flags era with inverted dateRange as error', () => {
    const c = seedCulture({ id: 'foo', name: 'Foo', region: 'R', climate: 'temperate' });
    c.eras.push({ id: 'e1', name: 'E1', dateRange: [800, 700], defaults: defaultsFixture(), typologyMix: {}, rules: [] });
    const r = validateCulture(c);
    expect(r.issues.some(i => i.severity === 'error' && i.path === 'eras[0].dateRange')).toBe(true);
  });

  it('flags overlapping eras as warning, not error', () => {
    const c = seedCulture({ id: 'foo', name: 'Foo', region: 'R', climate: 'temperate' });
    c.eras.push(
      { id: 'a', name: 'A', dateRange: [600, 800], defaults: defaultsFixture(), typologyMix: {}, rules: [] },
      { id: 'b', name: 'B', dateRange: [750, 900], defaults: defaultsFixture(), typologyMix: {}, rules: [] },
    );
    const r = validateCulture(c);
    expect(r.issues.some(i => i.severity === 'warning' && i.message.toLowerCase().includes('overlap'))).toBe(true);
    expect(r.issues.every(i => i.severity !== 'error')).toBe(true);
  });

  it('flags rule.tagMatches with unknown axis', () => {
    const c = seedCulture({ id: 'foo', name: 'Foo', region: 'R', climate: 'temperate' });
    c.rules.push({ id: 'r1', priority: 1, conditions: { tagMatches: { ghost: 'x' } }, assigns: {} });
    expect(validateCulture(c).issues.some(i => i.path.includes('rules[0].conditions.tagMatches.ghost'))).toBe(true);
  });

  it('flags rule.tagMatches with known axis but unknown value', () => {
    const c = seedCulture({ id: 'foo', name: 'Foo', region: 'R', climate: 'temperate' });
    c.rules.push({ id: 'r1', priority: 1, conditions: { tagMatches: { climate: 'fake-climate' } }, assigns: {} });
    expect(validateCulture(c).issues.some(i => i.path.includes('rules[0].conditions.tagMatches.climate'))).toBe(true);
  });

  it('flags non-kebab-case ids', () => {
    const c = seedCulture({ id: 'Foo Culture', name: 'F', region: 'R', climate: 'temperate' });
    expect(validateCulture(c).issues.some(i => i.path === 'id')).toBe(true);
  });

  it('flags duplicate material ids', () => {
    const c = seedCulture({ id: 'foo', name: 'Foo', region: 'R', climate: 'temperate' });
    c.materials.push({ ...c.materials[0] });
    expect(validateCulture(c).issues.some(i => i.path.startsWith('materials[') && i.message.toLowerCase().includes('duplicate'))).toBe(true);
  });

  it('flags invalid hex in palette', () => {
    const c = seedCulture({ id: 'foo', name: 'Foo', region: 'R', climate: 'temperate' });
    const d = defaultsFixture(); d.palette = ['notahex'];
    c.eras.push({ id: 'e', name: 'E', dateRange: [0, 100], defaults: d, typologyMix: {}, rules: [] });
    expect(validateCulture(c).issues.some(i => i.message.toLowerCase().includes('hex'))).toBe(true);
  });

  it('accepts contiguous non-overlapping eras without warning', () => {
    const c = seedCulture({ id: 'foo', name: 'Foo', region: 'R', climate: 'temperate' });
    c.eras.push(
      { id: 'a', name: 'A', dateRange: [600, 800], defaults: defaultsFixture(), typologyMix: {}, rules: [] },
      { id: 'b', name: 'B', dateRange: [800, 900], defaults: defaultsFixture(), typologyMix: {}, rules: [] },
    );
    expect(validateCulture(c).issues).toEqual([]);
  });
});
