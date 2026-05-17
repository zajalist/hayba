import { describe, it, expect } from 'vitest';
import {
  getTypologyTool, validateStyleGuideTool,
} from './mcp.js';

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

  it('returns ok=true for a well-formed guide', () => {
    expect(validateStyleGuideTool({ json: valid })).toEqual({ ok: true });
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
