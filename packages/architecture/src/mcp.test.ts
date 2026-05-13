import { describe, it, expect } from 'vitest';
import {
  listStyleGuides, getStyleGuideTool, getTypologyTool, validateStyleGuideTool,
  listStyleGuides as _ls, getStyleGuideTool as _gs, getTypologyTool as _gt,
} from './mcp.js';

describe('architecture_list_style_guides', () => {
  it('returns metadata for all 11 seed guides', () => {
    const out = listStyleGuides();
    expect(out.guides).toHaveLength(11);
    expect(out.guides[0]).toMatchObject({
      id: expect.any(String),
      cultureId: expect.any(String),
      dateRange: expect.any(Array),
      typologyCount: expect.any(Number),
    });
  });

  it('output is byte-identical across calls', () => {
    expect(JSON.stringify(listStyleGuides())).toBe(JSON.stringify(listStyleGuides()));
  });
});

describe('architecture_get_style_guide', () => {
  it('returns the full guide for a known id', () => {
    const out = getStyleGuideTool({ id: 'medieval-european-gothic' });
    expect('guide' in out).toBe(true);
    if ('guide' in out) {
      expect(out.guide.styleSheet.core.primaryMaterial).toBe('stone');
    }
  });

  it('returns not_found error for unknown id', () => {
    const out = getStyleGuideTool({ id: 'nonexistent' });
    expect(out).toEqual({ error: 'not_found', id: 'nonexistent' });
  });

  it('is deterministic across calls', () => {
    const a = JSON.stringify(getStyleGuideTool({ id: 'medieval-european-gothic' }));
    const b = JSON.stringify(getStyleGuideTool({ id: 'medieval-european-gothic' }));
    expect(a).toBe(b);
  });
});

describe('architecture_get_typology', () => {
  it('returns typology for known id', () => {
    const out = getTypologyTool({ id: 'peasant_home' });
    expect('typology' in out).toBe(true);
    if ('typology' in out) {
      expect(out.typology.id).toBe('peasant_home');
      expect(out.typology.footprint.kind).toBe('rectangle');
    }
  });

  it('returns not_found for unknown id', () => {
    const out = getTypologyTool({ id: 'castle' });
    expect(out).toEqual({ error: 'not_found', id: 'castle' });
  });
});

describe('architecture_validate_style_guide', () => {
  const valid = {
    id: 'test-guide',
    styleSheet: {
      id: 'test-sheet', cultureId: 'medieval-european', dateRange: [1000, 1200],
      core: { primaryMaterial: 'stone', roofType: 'gable', ornamentation: [] },
      extras: {},
    },
    typologyWeights: [{ typologyId: 'peasant_home', weight: 1 }],
  };

  it('returns ok=true for a well-formed guide with known typology refs', () => {
    expect(validateStyleGuideTool({ json: valid })).toEqual({ ok: true });
  });

  it('returns ok=true even if typology refs are unknown — refs are A1 registry concern only', () => {
    const bad = { ...valid, typologyWeights: [{ typologyId: 'unknown_t', weight: 1 }] };
    // Structural validation passes; ref check is run by the registry, not by this tool.
    expect(validateStyleGuideTool({ json: bad })).toEqual({ ok: true });
  });

  it('returns structured errors for a malformed input', () => {
    const out = validateStyleGuideTool({
      json: { id: '', styleSheet: { id: 's' }, typologyWeights: 'not-an-array' },
    });
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.errors.length).toBeGreaterThanOrEqual(2);
      for (const e of out.errors) {
        expect(typeof e.path).toBe('string');
        expect(typeof e.message).toBe('string');
      }
    }
  });

  it('surfaces ALL errors (not first-fail)', () => {
    const out = validateStyleGuideTool({
      json: {
        id: '',
        styleSheet: {
          id: '', cultureId: '', dateRange: 'bad',
          core: { primaryMaterial: 'plasma', roofType: 'tepee', ornamentation: [] },
          extras: { broken: 42 },
        },
        typologyWeights: [],
      },
    });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.errors.length).toBeGreaterThanOrEqual(5);
  });
});

describe('determinism — byte-identical JSON across calls', () => {
  it('list_style_guides', () => {
    expect(JSON.stringify(_ls())).toBe(JSON.stringify(_ls()));
  });
  it('get_style_guide on every seed id', () => {
    const ids = _ls().guides.map(g => g.id);
    for (const id of ids) {
      expect(JSON.stringify(_gs({ id }))).toBe(JSON.stringify(_gs({ id })));
    }
  });
  it('get_typology on every seed typology', () => {
    const seen = new Set<string>();
    for (const meta of _ls().guides) {
      const g = _gs({ id: meta.id });
      if ('guide' in g) {
        for (const w of g.guide.typologyWeights) seen.add(w.typologyId);
      }
    }
    expect(seen.size).toBeGreaterThan(0);
    for (const id of seen) {
      expect(JSON.stringify(_gt({ id }))).toBe(JSON.stringify(_gt({ id })));
    }
  });
});
