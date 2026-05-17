import { describe, it, expect } from 'vitest';
import type { Culture, Era, Material, Ornament, Rule, TagAxis } from './schema-v2.js';

describe('schema-v2 shapes', () => {
  it('Culture composes Era[], Material[], Ornament[], TagAxis[], Rule[]', () => {
    const c: Culture = {
      id: 'carolingian', name: 'Carolingian', region: 'Frankish Europe', climate: 'temperate',
      tagAxes: [], materials: [], ornaments: [], rules: [], eras: [],
    };
    expect(c.id).toBe('carolingian');
  });

  it('Rule has priority, conditions.tagMatches, assigns', () => {
    const r: Rule = {
      id: 'temple-uses-stone', priority: 100,
      conditions: { scenario: 'temple', tagMatches: { climate: 'temperate' } },
      assigns: { materialId: 'limestone', ornamentIds: ['acanthus'], weight: 1 },
    };
    expect(r.priority).toBe(100);
  });
});
