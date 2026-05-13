import { describe, expect, it } from 'vitest';
import { proposeDerivation } from './derivation.js';
import type { Phonology } from './phonology.js';
import type { PhonotacticSpec } from './phonotactics.js';
import type { NameGeneratorProfile } from './name-generator.js';

const ph: Phonology = {
  languageId: 'demo',
  phonemes: [
    { id: 'p', ipa: 'p', features: { manner: 'plosive' } },
    { id: 't', ipa: 't', features: { manner: 'plosive' } },
    { id: 'k', ipa: 'k', features: { manner: 'plosive' } },
    { id: 'a', ipa: 'a', features: { height: 'open' } },
    { id: 'o', ipa: 'o', features: { height: 'close-mid' } },
  ],
};
const pt: PhonotacticSpec = {
  phonologyId: 'demo', vowels: ['a', 'o'],
  syllable: { templates: ['CV'] },
};
const profile: NameGeneratorProfile = {
  syllableTemplate: 'CV', vowels: ['a', 'o'], onsetPool: ['p', 't', 'k'],
};

describe('proposeDerivation', () => {
  it('uses the deterministic fallback when no LLM is supplied', async () => {
    const r = await proposeDerivation({
      phonology: ph, phonotactics: pt, fallbackProfile: profile,
      gloss: 'mountain', seed: 123,
    });
    expect(r.source).toBe('fallback');
    expect(r.lexeme.lemma).toMatch(/^[ptkao]+$/);
  });

  it('accepts a valid LLM emission on first try', async () => {
    const r = await proposeDerivation({
      phonology: ph, phonotactics: pt, fallbackProfile: profile,
      gloss: 'river', seed: 7,
    }, async () => ({ lemma: 'kapo', etymology: 'from proto-X' }));
    expect(r.source).toBe('llm');
    expect(r.lexeme.lemma).toBe('kapo');
    expect(r.attempts).toBe(1);
  });

  it('retries on invalid emissions, then falls back', async () => {
    const r = await proposeDerivation({
      phonology: ph, phonotactics: pt, fallbackProfile: profile,
      gloss: 'storm', seed: 7, maxRetries: 2,
    }, async () => ({ lemma: 'ZZ' })); // out-of-inventory
    expect(r.source).toBe('fallback');
    expect(r.history.length).toBe(2);
  });
});
