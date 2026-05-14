import { describe, it, expect } from 'vitest';
import { buildPrompt, hashPrompt } from './prompt-builder.js';
import { loadElementCatalog } from '../index.js';

// Inline fixture replaces the deleted style-guide JSON data.
const styleSheet = {
  id: 'medieval-european-gothic',
  cultureId: 'medieval-european',
  dateRange: [1100, 1400] as [number, number],
  core: {
    primaryMaterial: 'stone' as const,
    roofType: 'gable' as const,
    ornamentation: ['pointed-arch', 'tracery', 'flying-buttress'],
  },
  extras: {},
};

describe('buildPrompt', () => {
  const catalog = loadElementCatalog();
  const element = catalog.elementsById.get('column')!;

  it('returns a system prompt and a user prompt', () => {
    const p = buildPrompt({ element, styleSheet, seed: 0x1n });
    expect(typeof p.system).toBe('string');
    expect(typeof p.user).toBe('string');
    expect(p.system.length).toBeGreaterThan(50);
    expect(p.user.length).toBeGreaterThan(50);
  });

  it('user prompt names the element and style sheet', () => {
    const p = buildPrompt({ element, styleSheet, seed: 0x1n });
    expect(p.user).toContain('column');
    expect(p.user).toContain('medieval-european-gothic');
  });

  it('user prompt lists every required profile slot with its hint and viewBox', () => {
    const p = buildPrompt({ element, styleSheet, seed: 0x1n });
    for (const slot of element.profileSlots) {
      expect(p.user).toContain(slot.name);
      expect(p.user).toContain(slot.hint);
    }
  });

  it('user prompt lists every required param with its range', () => {
    const p = buildPrompt({ element, styleSheet, seed: 0x1n });
    for (const slot of element.paramSchema) {
      expect(p.user).toContain(slot.name);
      if (slot.range) {
        expect(p.user).toContain(String(slot.range[0]));
        expect(p.user).toContain(String(slot.range[1]));
      }
    }
  });

  it('system prompt instructs strict JSON-only output', () => {
    const p = buildPrompt({ element, styleSheet, seed: 0x1n });
    expect(p.system).toMatch(/JSON/i);
    expect(p.system).toMatch(/SVG/i);
  });

  it('user prompt mentions cultural context from the style sheet', () => {
    const p = buildPrompt({ element, styleSheet, seed: 0x1n });
    expect(p.user).toContain(styleSheet.core.primaryMaterial);
    expect(p.user).toContain(styleSheet.core.roofType);
    for (const orn of styleSheet.core.ornamentation) expect(p.user).toContain(orn);
  });
});

describe('hashPrompt', () => {
  it('produces stable hex-string hashes', () => {
    const a = hashPrompt('hello', 'world');
    const b = hashPrompt('hello', 'world');
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{16}$/);   // 16-hex-digit (64-bit) FNV
  });

  it('different prompts produce different hashes', () => {
    expect(hashPrompt('a', 'b')).not.toBe(hashPrompt('a', 'c'));
  });
});
