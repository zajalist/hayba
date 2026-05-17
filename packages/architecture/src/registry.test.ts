import { describe, it, expect } from 'vitest';
import {
  loadRegistry, getTypology,
  buildRegistry, ArchitectureRegistryError,
  _resetRegistryCacheForTests,
} from './registry.js';

const validTypology = {
  id: 'peasant_home',
  footprint: { kind: 'rectangle', aspectRatio: [1, 2], areaRange: [25, 80] },
  storyRange: [1, 2],
  fenestrationDensity: [0.05, 0.15],
};

describe('buildRegistry error paths', () => {
  it('throws on duplicate typology ids', () => {
    expect(() => buildRegistry([validTypology, validTypology]))
      .toThrow(ArchitectureRegistryError);
  });

  it('error carries the structured ValidationError list', () => {
    try {
      buildRegistry([validTypology, validTypology]);
      expect.fail('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(ArchitectureRegistryError);
      expect((e as ArchitectureRegistryError).errors.length).toBeGreaterThan(0);
    }
  });
});

describe('_resetRegistryCacheForTests', () => {
  it('drops the cache so the next loadRegistry rebuilds', () => {
    const before = loadRegistry();
    _resetRegistryCacheForTests();
    const after = loadRegistry();
    expect(before).not.toBe(after);
    expect(after.typologyIds.size).toBe(before.typologyIds.size);
  });
});

describe('registry', () => {
  it('loads the bundled typology data without errors', () => {
    expect(() => loadRegistry()).not.toThrow();
  });

  it('exposes all 10 typologies', () => {
    const reg = loadRegistry();
    expect(reg.typologyIds.size).toBe(10);
    expect(reg.typologyIds.has('peasant_home')).toBe(true);
  });

  it('getTypology returns null for unknown id', () => {
    expect(getTypology('not-a-real-id')).toBeNull();
  });

  it('loadRegistry is idempotent and returns the same cached object', () => {
    expect(loadRegistry()).toBe(loadRegistry());
  });
});
