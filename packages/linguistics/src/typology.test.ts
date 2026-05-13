import { describe, expect, it } from 'vitest';
import {
  TYPOLOGY_FEATURES,
  TYPOLOGY_PRESETS,
  getTypologyFeature,
  validateProfile,
  profileSummary,
} from './data/typology.js';

describe('TYPOLOGY_FEATURES catalogue invariants', () => {
  it('every feature has at least two options', () => {
    for (const f of TYPOLOGY_FEATURES) {
      expect(f.options.length, `${f.key} option count`).toBeGreaterThanOrEqual(2);
    }
  });

  it('every feature has a unique key', () => {
    const seen = new Set<string>();
    for (const f of TYPOLOGY_FEATURES) {
      expect(seen.has(f.key), `duplicate key ${f.key}`).toBe(false);
      seen.add(f.key);
    }
  });

  it('every option value is unique within its feature, and frequencies are in [0,1]', () => {
    for (const f of TYPOLOGY_FEATURES) {
      const seen = new Set<string>();
      for (const o of f.options) {
        expect(seen.has(o.value), `${f.key} duplicate option ${o.value}`).toBe(false);
        seen.add(o.value);
        if (o.frequency !== undefined) {
          expect(o.frequency).toBeGreaterThanOrEqual(0);
          expect(o.frequency).toBeLessThanOrEqual(1);
        }
      }
    }
  });

  it('covers the spec-mandated minimum 15 features', () => {
    expect(TYPOLOGY_FEATURES.length).toBeGreaterThanOrEqual(15);
  });
});

describe('getTypologyFeature', () => {
  it('returns the feature for a known key', () => {
    const f = getTypologyFeature('word_order');
    expect(f).toBeDefined();
    expect(f!.label).toMatch(/order/i);
  });

  it('returns undefined for unknown keys', () => {
    expect(getTypologyFeature('not_a_real_key')).toBeUndefined();
  });
});

describe('validateProfile', () => {
  it('returns an empty array for a valid profile', () => {
    expect(validateProfile({ word_order: 'SVO', tone: 'none' })).toEqual([]);
  });

  it('reports unknown keys', () => {
    const problems = validateProfile({ not_real: 'x' });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/unknown feature/);
  });

  it('reports invalid option values for known keys', () => {
    const problems = validateProfile({ word_order: 'XYZ' });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/invalid option for word_order/);
  });

  it('all bundled presets validate cleanly', () => {
    for (const [name, prof] of Object.entries(TYPOLOGY_PRESETS)) {
      expect(validateProfile(prof), `${name} should validate`).toEqual([]);
    }
  });
});

describe('profileSummary', () => {
  it('handles the empty profile', () => {
    expect(profileSummary({})).toBe('');
  });

  it('summarises a partial profile', () => {
    const s = profileSummary({ word_order: 'SVO', alignment: 'nom-acc', tone: 'contour' });
    expect(s).toContain('SVO');
    expect(s).toContain('nom-acc');
    expect(s).toContain('tonal');
  });

  it('describes the English preset compactly', () => {
    const s = profileSummary(TYPOLOGY_PRESETS.English!);
    expect(s).toContain('SVO');
    expect(s).toContain('nom-acc');
    expect(s).toContain('no gender');
    expect(s).toContain('no tone');
  });

  it('describes the Mandarin preset as tonal with classifiers', () => {
    const s = profileSummary(TYPOLOGY_PRESETS.Mandarin!);
    expect(s).toContain('SVO');
    expect(s).toContain('tonal');
  });
});
