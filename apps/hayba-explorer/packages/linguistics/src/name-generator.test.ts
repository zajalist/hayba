import { describe, expect, it } from 'vitest';
import type { Phonology } from './phonology.js';
import { generatePhonotacticName } from './name-generator.js';

const phonology: Phonology = {
  languageId: 'testlang',
  phonemes: [
    { id: 'p', ipa: 'p', features: { place: 'bilabial', manner: 'stop', voicing: 'voiceless' } },
    { id: 't', ipa: 't', features: { place: 'alveolar', manner: 'stop', voicing: 'voiceless' } },
    { id: 'a', ipa: 'a', features: { height: 'open', backness: 'front' } },
    { id: 'o', ipa: 'o', features: { height: 'close-mid', backness: 'back' } },
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
