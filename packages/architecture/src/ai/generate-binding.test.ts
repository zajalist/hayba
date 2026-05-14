import { describe, it, expect } from 'vitest';
import { generateBinding } from './generate-binding.js';
import { MockProvider } from './provider-mock.js';
import { loadElementCatalog } from '../index.js';

const catalog = loadElementCatalog();
const element = catalog.elementsById.get('column')!;
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

describe('generateBinding', () => {
  it('produces a valid binding draft via the mock provider', async () => {
    const r = await generateBinding({
      element, styleSheet, seed: 0x42n,
      provider: new MockProvider(),
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.draft.elementId).toBe('column');
      expect(r.draft.styleSheetId).toBe('medieval-european-gothic');
      expect(r.draft.seed).toBe(0x42n);
      expect(r.draft.provenance.source).toBe('ai');
      expect(r.draft.provenance.aiProvider).toBe('mock');
    }
  });

  it('returns the same draft twice for the same seed (mock determinism)', async () => {
    const a = await generateBinding({ element, styleSheet, seed: 0x111n, provider: new MockProvider() });
    const b = await generateBinding({ element, styleSheet, seed: 0x111n, provider: new MockProvider() });
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) {
      expect(JSON.stringify(a.draft.profiles)).toBe(JSON.stringify(b.draft.profiles));
      expect(JSON.stringify(a.draft.params)).toBe(JSON.stringify(b.draft.params));
    }
  });
});
