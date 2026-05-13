import { describe, it, expect } from 'vitest';
import { validateFootprintShape, validateTypology } from './validate.js';

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
