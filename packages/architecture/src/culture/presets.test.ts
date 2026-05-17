import { describe, it, expect } from 'vitest';
import { MATERIAL_PRESETS, ORNAMENT_PRESETS, TAG_AXIS_PRESETS, seedCulture } from './presets.js';

describe('presets', () => {
  it('has at least 8 material presets with required fields', () => {
    expect(MATERIAL_PRESETS.length).toBeGreaterThanOrEqual(8);
    for (const m of MATERIAL_PRESETS) {
      expect(m.id).toMatch(/^[a-z][a-z0-9-]*$/);
      expect(typeof m.color).toBe('string');
      expect(m.properties.durability).toBeGreaterThanOrEqual(0);
    }
  });

  it('has at least 6 tag axis presets with kebab-case ids and values', () => {
    expect(TAG_AXIS_PRESETS.length).toBeGreaterThanOrEqual(6);
    for (const a of TAG_AXIS_PRESETS) {
      expect(a.id).toMatch(/^[a-z][a-z0-9-]*$/);
      expect(a.values.length).toBeGreaterThan(0);
      for (const v of a.values) expect(v.id).toMatch(/^[a-z][a-z0-9-]*$/);
    }
  });

  it('has at least 15 ornament presets', () => {
    expect(ORNAMENT_PRESETS.length).toBeGreaterThanOrEqual(15);
    for (const o of ORNAMENT_PRESETS) {
      expect(o.id).toMatch(/^[a-z][a-z0-9-]*$/);
      expect(o.referenceImagePaths).toEqual([]);
      expect(o.scenarioWeights).toEqual({});
    }
  });

  it('seedCulture returns a valid Culture with provided fields filled', () => {
    const c = seedCulture({ id: 'test', name: 'Test', region: 'X', climate: 'temperate' });
    expect(c.id).toBe('test');
    expect(c.name).toBe('Test');
    expect(c.region).toBe('X');
    expect(c.climate).toBe('temperate');
    expect(c.materials.length).toBeGreaterThan(0);
    expect(c.tagAxes.length).toBeGreaterThan(0);
    expect(c.ornaments.length).toBeGreaterThan(0);
    expect(c.eras).toEqual([]);
    expect(c.rules).toEqual([]);
  });

  it('seedCulture deep-copies preset arrays (mutating returned arrays does not affect presets)', () => {
    const c = seedCulture({ id: 'a', name: 'A', region: 'R', climate: 'temperate' });
    const before = MATERIAL_PRESETS.length;
    c.materials.pop();
    expect(MATERIAL_PRESETS.length).toBe(before);
  });
});
