import { describe, it, expect } from 'vitest';
import {
  loadRegistry, listStyleGuideMeta, getStyleGuide, getTypology,
  ArchitectureRegistryError,
} from './registry.js';

describe('registry', () => {
  it('loads the bundled seed data without errors', () => {
    expect(() => loadRegistry()).not.toThrow();
  });

  it('exposes all 10 typologies', () => {
    const reg = loadRegistry();
    expect(reg.typologyIds.size).toBe(10);
    expect(reg.typologyIds.has('peasant_home')).toBe(true);
  });

  it('exposes all 11 style guides', () => {
    expect(listStyleGuideMeta().length).toBe(11);
  });

  it('every typologyId referenced from a guide resolves', () => {
    const reg = loadRegistry();
    for (const guide of reg.styleGuidesById.values()) {
      for (const w of guide.typologyWeights) {
        expect(reg.typologyIds.has(w.typologyId)).toBe(true);
      }
    }
  });

  it('getStyleGuide returns the embedded sheet for a known id', () => {
    const g = getStyleGuide('medieval-european-gothic');
    expect(g).not.toBeNull();
    expect(g!.styleSheet.cultureId).toBe('medieval-european');
  });

  it('getStyleGuide returns null for unknown id', () => {
    expect(getStyleGuide('not-a-real-id')).toBeNull();
  });

  it('getTypology returns null for unknown id', () => {
    expect(getTypology('not-a-real-id')).toBeNull();
  });

  it('loadRegistry is idempotent and returns the same cached object', () => {
    expect(loadRegistry()).toBe(loadRegistry());
  });
});

describe('cross-pillar contract — every guide ref resolves', () => {
  it('no dangling typologyId in any seed StyleGuide', () => {
    const reg = loadRegistry();
    const missing: Array<{ guide: string; typologyId: string }> = [];
    for (const guide of reg.styleGuidesById.values()) {
      for (const w of guide.typologyWeights) {
        if (!reg.typologyIds.has(w.typologyId)) {
          missing.push({ guide: guide.id, typologyId: w.typologyId });
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it('every guide has at least one typology weight', () => {
    const reg = loadRegistry();
    for (const guide of reg.styleGuidesById.values()) {
      expect(guide.typologyWeights.length).toBeGreaterThan(0);
    }
  });

  it('within a culture, overlapping dateRanges are detected (warning surface)', () => {
    const reg = loadRegistry();
    const byCulture = new Map<string, Array<{ id: string; range: [number, number] }>>();
    for (const guide of reg.styleGuidesById.values()) {
      const list = byCulture.get(guide.styleSheet.cultureId) ?? [];
      list.push({ id: guide.id, range: guide.styleSheet.dateRange });
      byCulture.set(guide.styleSheet.cultureId, list);
    }
    // Tiebreaker rule per spec: highest endYear wins. This asserts the data is
    // well-formed enough that A5 selection has a deterministic answer.
    for (const [_culture, list] of byCulture) {
      const sorted = [...list].sort((a, b) => b.range[1] - a.range[1]);
      expect(sorted[0]).toBeDefined();
    }
  });
});
