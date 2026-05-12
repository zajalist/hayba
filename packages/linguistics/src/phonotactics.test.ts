import { describe, expect, it } from 'vitest';
import type { Phonology } from './phonology.js';
import { validatePhonotactics } from './phonotactics.js';

const demoPhonology: Phonology = {
  languageId: 'demo',
  phonemes: [
    { symbol: 'k', ipa: 'k', features: [] },
    { symbol: 't', ipa: 't', features: [] },
    { symbol: 'a', ipa: 'a', features: [] },
    { symbol: 'o', ipa: 'o', features: [] },
  ],
};

describe('validatePhonotactics', () => {
  it('accepts CVCV with CV template', () => {
    const ok = validatePhonotactics('kato', demoPhonology, {
      phonologyId: 'demo',
      vowels: ['a', 'o'],
      syllable: { templates: ['CV'] },
    });
    expect(ok).toBe(true);
  });

  it('rejects stray consonant clusters when template is CV', () => {
    const ok = validatePhonotactics('kkato', demoPhonology, {
      phonologyId: 'demo',
      vowels: ['a', 'o'],
      syllable: { templates: ['CV'] },
    });
    expect(ok).toBe(false);
  });
});
