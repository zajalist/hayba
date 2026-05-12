import { describe, expect, it } from 'vitest';
import type { Phonology } from './phonology.js';
import { generatePhonotacticName } from './name-generator.js';

const phonology: Phonology = {
  languageId: 'testlang',
  phonemes: [
    { symbol: 'p', ipa: 'p', features: [] },
    { symbol: 't', ipa: 't', features: [] },
    { symbol: 'a', ipa: 'a', features: [] },
    { symbol: 'o', ipa: 'o', features: [] },
  ],
};

describe('generatePhonotacticName', () => {
  it('is deterministic for the same seed', () => {
    const name = generatePhonotacticName({
      phonology,
      phonotactics: {
        phonologyId: 'testlang',
        vowels: ['a', 'o'],
        syllable: { templates: ['CV'] },
      },
      profile: {
        syllableTemplate: 'CV',
        vowels: ['a', 'o'],
        onsetPool: ['p', 't'],
      },
      syllableCount: 2,
      seed: 4242,
      category: 'person',
    });
    const again = generatePhonotacticName({
      phonology,
      phonotactics: {
        phonologyId: 'testlang',
        vowels: ['a', 'o'],
        syllable: { templates: ['CV'] },
      },
      profile: {
        syllableTemplate: 'CV',
        vowels: ['a', 'o'],
        onsetPool: ['p', 't'],
      },
      syllableCount: 2,
      seed: 4242,
      category: 'person',
    });
    expect(name).toBe(again);
    expect(name.length).toBeGreaterThan(3);
  });
});
