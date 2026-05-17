import { describe, expect, it } from 'vitest';
import { audioUrlFor, audioCatalogueKeys } from './audio.js';
import { PULMONIC_CONSONANTS, CARDINAL_VOWELS } from './ipa-chart.js';

describe('audio resolver', () => {
  it('returns a Commons URL for every charted consonant', () => {
    for (const c of PULMONIC_CONSONANTS) {
      const url = audioUrlFor(c.ipa);
      expect(url, `audio for /${c.ipa}/`).not.toBeNull();
      expect(url!).toMatch(/^https:\/\/commons\.wikimedia\.org\/wiki\/Special:FilePath\//);
    }
  });

  it('returns a Commons URL for every charted vowel', () => {
    for (const v of CARDINAL_VOWELS) {
      expect(audioUrlFor(v.ipa), `audio for /${v.ipa}/`).not.toBeNull();
    }
  });

  it('returns null for off-chart phonemes', () => {
    expect(audioUrlFor('Q')).toBeNull();
  });

  it('encodes feature semantics in the filename', () => {
    expect(audioUrlFor('p')).toContain('Voiceless_bilabial_plosive');
    expect(audioUrlFor('b')).toContain('Voiced_bilabial_plosive');
    expect(audioUrlFor('m')).toContain('Voiced_bilabial_nasal');
  });

  it('catalogue is non-empty', () => {
    expect(audioCatalogueKeys().length).toBeGreaterThan(20);
  });
});
