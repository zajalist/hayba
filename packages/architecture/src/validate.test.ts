import { describe, it, expect } from 'vitest';
import { validateFootprintShape } from './validate.js';

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
