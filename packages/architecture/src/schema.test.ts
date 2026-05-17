import { describe, it, expectTypeOf } from 'vitest';
import type {
  FeatureBundle, RoofType, PrimaryMaterial, FootprintShape,
  Typology, StyleSheet, StyleGuide,
  Element, ProfileSlot, ParamSlot, ElementBinding, ElementGraphRef,
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

describe('element schema types', () => {
  it('ProfileSlot constrains hint to the four allowed values', () => {
    const slots: ProfileSlot[] = [
      { name: 'shaft', description: 'half-profile', hint: 'symmetric-half' },
      { name: 'cap',   description: 'closed top',   hint: 'closed-path' },
      { name: 'curve', description: 'open arc',     hint: 'open-path' },
      { name: 'tile',  description: 'tileable',     hint: 'tileable' },
    ];
    expectTypeOf(slots[0].hint).toEqualTypeOf<'closed-path' | 'open-path' | 'symmetric-half' | 'tileable'>();
  });

  it('ParamSlot supports number, integer, and enum kinds', () => {
    const slots: ParamSlot[] = [
      { name: 'shaft_h', kind: 'number',  range: [1.5, 8.0], default: 3.0 },
      { name: 'segs',    kind: 'integer', range: [8, 64],    default: 32 },
      { name: 'fluting', kind: 'enum',    choices: ['none', 'shallow', 'deep'], default: 'shallow' },
    ];
    expectTypeOf(slots[0].kind).toEqualTypeOf<'number' | 'integer' | 'enum'>();
  });

  it('Element bundles slots + paramSchema + generator ref', () => {
    const el: Element = {
      id: 'column',
      category: 'connector',
      graph: { kind: 'kernel-fn', module: './kernel/elements/column.js', export: 'columnGraph' },
      profileSlots: [
        { name: 'shaft', description: 'half-profile', hint: 'symmetric-half' },
      ],
      paramSchema: [
        { name: 'shaft_height_m', kind: 'number', range: [1.5, 8.0], default: 3.0 },
      ],
    };
    expectTypeOf(el.category).toEqualTypeOf<'connector' | 'ornament'>();
  });

  it('ElementBinding carries profiles, params, seed, provenance', () => {
    const b: ElementBinding = {
      elementId: 'column',
      styleSheetId: 'medieval-european-gothic',
      seed: 1n,
      profiles: { shaft: '<svg/>' },
      params:   { shaft_height_m: 4.0 },
      provenance: { source: 'human', createdAt: '2026-05-13T00:00:00Z' },
    };
    expectTypeOf(b.seed).toEqualTypeOf<bigint>();
    expectTypeOf(b.provenance.source).toEqualTypeOf<'ai' | 'human'>();
  });
});
