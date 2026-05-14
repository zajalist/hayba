import { describe, it, expect } from 'vitest';
import { MockProvider } from './provider-mock.js';
import { buildPrompt } from './prompt-builder.js';
import { loadElementCatalog, loadRegistry } from '../index.js';

const catalog = loadElementCatalog();
const reg = loadRegistry();
const element = catalog.elementsById.get('column')!;
const styleSheet = reg.styleGuidesById.get('medieval-european-gothic')!.styleSheet;

describe('MockProvider', () => {
  it('returns a non-empty rawText response', async () => {
    const provider = new MockProvider();
    const p = buildPrompt({ element, styleSheet, seed: 0x1n });
    const r = await provider.generate({ element, styleSheet, seed: 0x1n }, p);
    expect(r.rawText.length).toBeGreaterThan(50);
    expect(r.provider).toBe('mock');
    expect(r.model).toBe('mock-deterministic');
  });

  it('is deterministic for the same (element, styleSheet, seed)', async () => {
    const provider = new MockProvider();
    const p = buildPrompt({ element, styleSheet, seed: 0x1n });
    const a = await provider.generate({ element, styleSheet, seed: 0x1n }, p);
    const b = await provider.generate({ element, styleSheet, seed: 0x1n }, p);
    expect(a.rawText).toBe(b.rawText);
  });

  it('different seeds may produce different output (sanity)', async () => {
    const provider = new MockProvider();
    const p1 = buildPrompt({ element, styleSheet, seed: 0x1n });
    const p2 = buildPrompt({ element, styleSheet, seed: 0x2n });
    const a = await provider.generate({ element, styleSheet, seed: 0x1n }, p1);
    const b = await provider.generate({ element, styleSheet, seed: 0x2n }, p2);
    expect(a.rawText).not.toBe(b.rawText);
  });

  it('output includes every required profile slot key', async () => {
    const provider = new MockProvider();
    const p = buildPrompt({ element, styleSheet, seed: 0x1n });
    const r = await provider.generate({ element, styleSheet, seed: 0x1n }, p);
    for (const slot of element.profileSlots) {
      expect(r.rawText).toContain(`"${slot.name}"`);
    }
  });

  it('output includes every required param key', async () => {
    const provider = new MockProvider();
    const p = buildPrompt({ element, styleSheet, seed: 0x1n });
    const r = await provider.generate({ element, styleSheet, seed: 0x1n }, p);
    for (const slot of element.paramSchema) {
      expect(r.rawText).toContain(`"${slot.name}"`);
    }
  });
});
