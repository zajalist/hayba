import { describe, it, expectTypeOf } from 'vitest';
import type {
  FeatureBundle, RoofType, PrimaryMaterial, FootprintShape,
  Typology, StyleSheet, StyleGuide,
} from './schema.js';

describe('schema types', () => {
  it('FeatureBundle accepts string and string[] values', () => {
    const bundle: FeatureBundle = { roof: 'gable', tags: ['rural', 'old'] };
    expectTypeOf(bundle).toMatchTypeOf<Readonly<Record<string, string | readonly string[]>>>();
  });

  it('FootprintShape is a discriminated union of 5 kinds', () => {
    const kinds: FootprintShape['kind'][] =
      ['rectangle', 'linear-row', 'L-shape', 'U-shape', 'courtyard'];
    expectTypeOf(kinds).toMatchTypeOf<Array<FootprintShape['kind']>>();
  });

  it('Typology has the expected required fields', () => {
    const t: Typology = {
      id: 'peasant_home',
      footprint: { kind: 'rectangle', aspectRatio: [1, 2], areaRange: [25, 80] },
      storyRange: [1, 2],
      fenestrationDensity: [0.05, 0.15],
    };
    expectTypeOf(t.id).toBeString();
    expectTypeOf(t.storyRange).toEqualTypeOf<[number, number]>();
  });

  it('StyleSheet carries cultureId, dateRange, core, extras', () => {
    const s: StyleSheet = {
      id: 'test',
      cultureId: 'medieval-european',
      dateRange: [1140, 1400],
      core: { primaryMaterial: 'stone', roofType: 'gable', ornamentation: [] },
      extras: {},
    };
    expectTypeOf(s.cultureId).toBeString();
    expectTypeOf(s.dateRange).toEqualTypeOf<[number, number]>();
  });

  it('StyleGuide embeds StyleSheet by value and lists typology weights', () => {
    const g: StyleGuide = {
      id: 'test-guide',
      styleSheet: {
        id: 'test-sheet', cultureId: 'c', dateRange: [0, 1],
        core: { primaryMaterial: 'timber', roofType: 'thatch', ornamentation: [] },
        extras: {},
      },
      typologyWeights: [{ typologyId: 'peasant_home', weight: 1 }],
    };
    expectTypeOf(g.styleSheet).toMatchTypeOf<StyleSheet>();
    expectTypeOf(g.typologyWeights).toEqualTypeOf<ReadonlyArray<{ typologyId: string; weight: number }>>();
  });
});
