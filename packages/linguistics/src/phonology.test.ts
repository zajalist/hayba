import { describe, expect, it } from 'vitest';
import {
  tokenize,
  validatePhonology,
  getPhonemeById,
  findPhonemeByIpa,
  phonemesWithFeatures,
  vowels,
  consonants,
} from './phonology.js';
import type { Phonology } from './phonology.js';

const sample: Phonology = {
  languageId: 'sample',
  phonemes: [
    { id: 'p',  ipa: 'p',  features: { place: 'bilabial', manner: 'stop', voicing: 'voiceless' } },
    { id: 'b',  ipa: 'b',  features: { place: 'bilabial', manner: 'stop', voicing: 'voiced' } },
    { id: 'm',  ipa: 'm',  features: { place: 'bilabial', manner: 'nasal', voicing: 'voiced' } },
    { id: 'ts', ipa: 'ts', features: { place: 'alveolar', manner: 'affricate', voicing: 'voiceless' } },
    { id: 'a',  ipa: 'a',  features: { height: 'open', backness: 'front', roundness: 'unrounded' } },
    { id: 'i',  ipa: 'i',  features: { height: 'close', backness: 'front', roundness: 'unrounded' } },
  ],
};

describe('phonology engine', () => {
  it('validates a well-formed inventory', () => {
    expect(validatePhonology(sample)).toEqual([]);
  });

  it('flags duplicate ids and empty fields', () => {
    const bad: Phonology = {
      languageId: '',
      phonemes: [
        { id: 'p', ipa: 'p', features: {} },
        { id: 'p', ipa: 'p2', features: {} },
        { id: '', ipa: 'x', features: {} },
      ],
    };
    const problems = validatePhonology(bad);
    expect(problems.some(s => s.includes('languageId'))).toBe(true);
    expect(problems.some(s => s.includes('duplicate'))).toBe(true);
    expect(problems.some(s => s.includes('empty id'))).toBe(true);
  });

  it('tokenizes preferring longer digraphs (greedy)', () => {
    expect(tokenize('tsapi', sample)).toEqual(['ts', 'a', 'p', 'i']);
  });

  it('returns null when a character is outside the inventory', () => {
    expect(tokenize('paq', sample)).toBeNull();
  });

  it('looks up by id and by ipa', () => {
    expect(getPhonemeById(sample, 'm').ipa).toBe('m');
    expect(findPhonemeByIpa(sample, 'ts')?.id).toBe('ts');
    expect(findPhonemeByIpa(sample, 'q')).toBeUndefined();
  });

  it('queries by feature bundle', () => {
    const nasals = phonemesWithFeatures(sample, { manner: 'nasal' });
    expect(nasals.map(p => p.id)).toEqual(['m']);
    const voicedBilabials = phonemesWithFeatures(sample, { place: 'bilabial', voicing: 'voiced' });
    expect(voicedBilabials.map(p => p.id).sort()).toEqual(['b', 'm']);
  });

  it('splits consonants and vowels by feature presence', () => {
    expect(consonants(sample).map(p => p.id).sort()).toEqual(['b', 'm', 'p', 'ts']);
    expect(vowels(sample).map(p => p.id).sort()).toEqual(['a', 'i']);
  });
});
