import { describe, it, expect } from 'vitest';
import {
  validateFootprintShape, validateTypology, validateStyleSheet,
  validateStyleGuide, validateStyleGuideRefs,
  validateElement, validateElementBinding,
} from './validate.js';

describe('validateFootprintShape', () => {
  it('accepts a well-formed rectangle', () => {
    const errs = validateFootprintShape(
      { kind: 'rectangle', aspectRatio: [1, 2], areaRange: [25, 100] },
      '/footprint',
    );
    expect(errs).toEqual([]);
  });

  it('rejects unknown kind', () => {
    const errs = validateFootprintShape({ kind: 'pentagon' } as unknown, '/footprint');
    expect(errs).toHaveLength(1);
    expect(errs[0].path).toBe('/footprint/kind');
    expect(errs[0].message).toMatch(/unknown footprint kind/i);
  });

  it('rejects reversed aspect ratio', () => {
    const errs = validateFootprintShape(
      { kind: 'rectangle', aspectRatio: [3, 1], areaRange: [25, 100] },
      '/footprint',
    );
    expect(errs.some(e => e.path === '/footprint/aspectRatio')).toBe(true);
  });

  it('rejects non-array input', () => {
    const errs = validateFootprintShape('not an object' as unknown, '/footprint');
    expect(errs).toHaveLength(1);
    expect(errs[0].path).toBe('/footprint');
  });

  it('surfaces multiple errors for a malformed L-shape', () => {
    const errs = validateFootprintShape(
      { kind: 'L-shape', wingDepth: [5, 2], courtyardFraction: [-1, 0.5] },
      '/footprint',
    );
    expect(errs.length).toBeGreaterThanOrEqual(2);
  });
});

describe('validateTypology', () => {
  const valid = {
    id: 'peasant_home',
    footprint: { kind: 'rectangle', aspectRatio: [1, 2], areaRange: [25, 80] },
    storyRange: [1, 2],
    fenestrationDensity: [0.05, 0.15],
  };

  it('accepts a well-formed typology', () => {
    expect(validateTypology(valid, '/typology')).toEqual([]);
  });

  it('rejects empty id', () => {
    const errs = validateTypology({ ...valid, id: '' }, '/typology');
    expect(errs.some(e => e.path === '/typology/id')).toBe(true);
  });

  it('rejects missing footprint', () => {
    const { footprint: _footprint, ...rest } = valid;
    const errs = validateTypology(rest, '/typology');
    expect(errs.some(e => e.path.startsWith('/typology/footprint'))).toBe(true);
  });

  it('rejects story range with min > max', () => {
    const errs = validateTypology({ ...valid, storyRange: [3, 1] }, '/typology');
    expect(errs.some(e => e.path === '/typology/storyRange')).toBe(true);
  });

  it('rejects fenestrationDensity > 1', () => {
    const errs = validateTypology({ ...valid, fenestrationDensity: [0.05, 1.5] }, '/typology');
    expect(errs.some(e => e.path.startsWith('/typology/fenestrationDensity'))).toBe(true);
  });

  it('accepts optional pathfindingHints record', () => {
    const errs = validateTypology(
      { ...valid, pathfindingHints: { footTraffic: 'high' } }, '/typology',
    );
    expect(errs).toEqual([]);
  });
});

describe('validateStyleSheet', () => {
  const valid = {
    id: 'medieval-european-gothic',
    cultureId: 'medieval-european',
    dateRange: [1140, 1400],
    core: {
      primaryMaterial: 'stone',
      roofType: 'gable',
      ornamentation: ['pointed-arch', 'flying-buttress'],
    },
    extras: { stainedGlass: 'present' },
  };

  it('accepts a well-formed sheet', () => {
    expect(validateStyleSheet(valid, '/sheet')).toEqual([]);
  });

  it('rejects unknown roofType', () => {
    const bad = { ...valid, core: { ...valid.core, roofType: 'tepee' } };
    const errs = validateStyleSheet(bad, '/sheet');
    expect(errs.some(e => e.path === '/sheet/core/roofType')).toBe(true);
  });

  it('rejects unknown primaryMaterial', () => {
    const bad = { ...valid, core: { ...valid.core, primaryMaterial: 'plasma' } };
    const errs = validateStyleSheet(bad, '/sheet');
    expect(errs.some(e => e.path === '/sheet/core/primaryMaterial')).toBe(true);
  });

  it('rejects extras with non-string-non-array value', () => {
    const bad = { ...valid, extras: { count: 42 } };
    const errs = validateStyleSheet(bad, '/sheet');
    expect(errs.some(e => e.path === '/sheet/extras/count')).toBe(true);
  });

  it('accepts extras with string[] values', () => {
    const ok = { ...valid, extras: { tags: ['rural', 'old'] } };
    expect(validateStyleSheet(ok, '/sheet')).toEqual([]);
  });

  it('rejects dateRange with negative endYear smaller than startYear', () => {
    const bad = { ...valid, dateRange: [1400, 1140] };
    const errs = validateStyleSheet(bad, '/sheet');
    expect(errs.some(e => e.path === '/sheet/dateRange')).toBe(true);
  });
});

describe('validateStyleGuide', () => {
  const sheet = {
    id: 's1', cultureId: 'c', dateRange: [0, 100],
    core: { primaryMaterial: 'timber', roofType: 'thatch', ornamentation: [] },
    extras: {},
  };
  const valid = {
    id: 'g1',
    styleSheet: sheet,
    typologyWeights: [
      { typologyId: 'peasant_home', weight: 1 },
      { typologyId: 'townhouse',    weight: 2.5 },
    ],
  };

  it('accepts a well-formed guide', () => {
    expect(validateStyleGuide(valid, '/g')).toEqual([]);
  });

  it('rejects empty typologyWeights', () => {
    const errs = validateStyleGuide({ ...valid, typologyWeights: [] }, '/g');
    expect(errs.some(e => e.path === '/g/typologyWeights')).toBe(true);
  });

  it('rejects zero/negative weight', () => {
    const bad = {
      ...valid,
      typologyWeights: [{ typologyId: 'peasant_home', weight: 0 }],
    };
    const errs = validateStyleGuide(bad, '/g');
    expect(errs.some(e => e.path === '/g/typologyWeights/0/weight')).toBe(true);
  });

  it('rejects malformed embedded styleSheet', () => {
    const bad = { ...valid, styleSheet: { ...sheet, core: { ...sheet.core, roofType: 'X' } } };
    const errs = validateStyleGuide(bad, '/g');
    expect(errs.some(e => e.path === '/g/styleSheet/core/roofType')).toBe(true);
  });
});

describe('validateStyleGuideRefs', () => {
  const sheet = {
    id: 's', cultureId: 'c', dateRange: [0, 1],
    core: { primaryMaterial: 'timber', roofType: 'thatch', ornamentation: [] },
    extras: {},
  };
  const guide = {
    id: 'g', styleSheet: sheet,
    typologyWeights: [{ typologyId: 'peasant_home', weight: 1 }],
  };

  it('returns no errors when all typology refs resolve', () => {
    expect(validateStyleGuideRefs(guide as never, new Set(['peasant_home']), '/g')).toEqual([]);
  });

  it('reports dangling typology references', () => {
    const errs = validateStyleGuideRefs(guide as never, new Set(['townhouse']), '/g');
    expect(errs).toHaveLength(1);
    expect(errs[0].path).toBe('/g/typologyWeights/0/typologyId');
    expect(errs[0].message).toMatch(/peasant_home/);
  });
});

describe('validateElement', () => {
  const valid = {
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

  it('accepts a well-formed element', () => {
    expect(validateElement(valid, '/element')).toEqual([]);
  });

  it('rejects unknown category', () => {
    const errs = validateElement({ ...valid, category: 'mystery' }, '/element');
    expect(errs.some(e => e.path === '/element/category')).toBe(true);
  });

  it('rejects unknown profile hint', () => {
    const bad = { ...valid, profileSlots: [{ name: 'x', description: '', hint: 'wonky' }] };
    const errs = validateElement(bad, '/element');
    expect(errs.some(e => e.path === '/element/profileSlots/0/hint')).toBe(true);
  });

  it('rejects param range with min > max', () => {
    const bad = { ...valid, paramSchema: [{ name: 'h', kind: 'number', range: [8, 1], default: 3 }] };
    const errs = validateElement(bad, '/element');
    expect(errs.some(e => e.path.startsWith('/element/paramSchema/0/range'))).toBe(true);
  });

  it('rejects enum slot with no choices', () => {
    const bad = { ...valid, paramSchema: [{ name: 'fluting', kind: 'enum', default: 'shallow' }] };
    const errs = validateElement(bad, '/element');
    expect(errs.some(e => e.path === '/element/paramSchema/0/choices')).toBe(true);
  });
});

describe('validateElementBinding', () => {
  const element = {
    id: 'column',
    category: 'connector',
    graph: { kind: 'kernel-fn', module: './kernel/elements/column.js', export: 'columnGraph' },
    profileSlots: [{ name: 'shaft', description: '', hint: 'symmetric-half' }],
    paramSchema: [{ name: 'shaft_height_m', kind: 'number', range: [1.5, 8.0], default: 3.0 }],
  } as const;

  const valid = {
    elementId: 'column',
    styleSheetId: 'medieval-european-gothic',
    seed: 0x1234n,
    profiles: { shaft: '<svg viewBox="0 0 200 1000"><path d="M0 0L100 0L100 1000L0 1000Z"/></svg>' },
    params: { shaft_height_m: 4.5 },
    provenance: { source: 'human', createdAt: '2026-05-13T00:00:00Z' },
  };

  it('accepts a well-formed binding', () => {
    expect(validateElementBinding(valid, element as never, '/b')).toEqual([]);
  });

  it('rejects missing required profile slot', () => {
    const bad = { ...valid, profiles: {} };
    const errs = validateElementBinding(bad, element as never, '/b');
    expect(errs.some(e => e.path === '/b/profiles/shaft')).toBe(true);
  });

  it('rejects param out of declared range', () => {
    const bad = { ...valid, params: { shaft_height_m: 100 } };
    const errs = validateElementBinding(bad, element as never, '/b');
    expect(errs.some(e => e.path === '/b/params/shaft_height_m')).toBe(true);
  });

  it('rejects elementId mismatch', () => {
    const bad = { ...valid, elementId: 'cornice' };
    const errs = validateElementBinding(bad, element as never, '/b');
    expect(errs.some(e => e.path === '/b/elementId')).toBe(true);
  });

  it('rejects unknown provenance source', () => {
    const bad = { ...valid, provenance: { ...valid.provenance, source: 'unicorn' } };
    const errs = validateElementBinding(bad, element as never, '/b');
    expect(errs.some(e => e.path === '/b/provenance/source')).toBe(true);
  });
});
