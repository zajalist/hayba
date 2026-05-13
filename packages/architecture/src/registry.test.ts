import { describe, it, expect } from 'vitest';
import {
  loadRegistry, listStyleGuideMeta, getStyleGuide, getTypology,
  ArchitectureRegistryError,
} from './registry.js';

describe('registry', () => {
  it('loads the bundled seed data without errors', () => {
    expect(() => loadRegistry()).not.toThrow();
  });

  it('exposes all 10 typologies', () => {
    const reg = loadRegistry();
    expect(reg.typologyIds.size).toBe(10);
    expect(reg.typologyIds.has('peasant_home')).toBe(true);
  });

  it('exposes all 11 style guides', () => {
    expect(listStyleGuideMeta().length).toBe(11);
  });

  it('every typologyId referenced from a guide resolves', () => {
    const reg = loadRegistry();
    for (const guide of reg.styleGuidesById.values()) {
      for (const w of guide.typologyWeights) {
        expect(reg.typologyIds.has(w.typologyId)).toBe(true);
      }
    }
  });

  it('getStyleGuide returns the embedded sheet for a known id', () => {
    const g = getStyleGuide('medieval-european-gothic');
    expect(g).not.toBeNull();
    expect(g!.styleSheet.cultureId).toBe('medieval-european');
  });

  it('getStyleGuide returns null for unknown id', () => {
    expect(getStyleGuide('not-a-real-id')).toBeNull();
  });

  it('getTypology returns null for unknown id', () => {
    expect(getTypology('not-a-real-id')).toBeNull();
  });

  it('loadRegistry is idempotent and returns the same cached object', () => {
    expect(loadRegistry()).toBe(loadRegistry());
  });
});
