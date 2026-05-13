import { describe, expect, it } from 'vitest';
import type { Phonology } from './phonology.js';
import type { PhonotacticSpec } from './phonotactics.js';
import { computeLexiconStatistics } from './statistics.js';

const phono: Phonology = {
  languageId: 'test',
  phonemes: [
    { id: 'p', ipa: 'p', features: { place: 'bilabial', manner: 'plosive', voicing: 'voiceless' } },
    { id: 'k', ipa: 'k', features: { place: 'velar', manner: 'plosive', voicing: 'voiceless' } },
    { id: 't', ipa: 't', features: { place: 'alveolar', manner: 'plosive', voicing: 'voiceless' } },
    { id: 'n', ipa: 'n', features: { place: 'alveolar', manner: 'nasal', voicing: 'voiced' } },
    { id: 'a', ipa: 'a', features: { height: 'open', backness: 'front', roundness: 'unrounded' } },
    { id: 'i', ipa: 'i', features: { height: 'close', backness: 'front', roundness: 'unrounded' } },
  ],
};

const spec: PhonotacticSpec = {
  phonologyId: 'test',
  vowels: ['a', 'i'],
  syllable: { templates: ['CV', 'CVC'] },
};

describe('computeLexiconStatistics', () => {
  it('returns zeros for an empty lexicon', () => {
    const s = computeLexiconStatistics([], phono, spec);
    expect(s.wordCount).toBe(0);
    expect(s.parsedCount).toBe(0);
    expect(s.unparseable).toBe(0);
    expect(s.phonemeFrequency.size).toBe(0);
    expect(s.syllableShapeDistribution.size).toBe(0);
    expect(s.wordLengthHistogram.size).toBe(0);
    expect(s.posBreakdown.size).toBe(0);
    expect(s.registerBreakdown.size).toBe(0);
    expect(s.avgWordLength).toBe(0);
    expect(s.consonantVowelRatio).toBe(0);
  });

  it('handles a single CV word', () => {
    const s = computeLexiconStatistics([{ lemma: 'ka', pos: 'noun' }], phono, spec);
    expect(s.wordCount).toBe(1);
    expect(s.parsedCount).toBe(1);
    expect(s.phonemeFrequency.get('k')).toBe(1);
    expect(s.phonemeFrequency.get('a')).toBe(1);
    expect(s.syllableShapeDistribution.get('CV')).toBe(1);
    expect(s.wordLengthHistogram.get(2)).toBe(1);
    expect(s.avgWordLength).toBe(2);
    expect(s.consonantVowelRatio).toBe(1);
    expect(s.phonemeExamples.get('k')).toEqual(['ka']);
  });

  it('sums frequencies across a mixed CV + CVC lexicon', () => {
    const s = computeLexiconStatistics(
      [
        { lemma: 'ka', pos: 'noun' },
        { lemma: 'pat', pos: 'verb' },
        { lemma: 'ni', pos: 'noun' },
      ],
      phono,
      spec,
    );
    expect(s.wordCount).toBe(3);
    expect(s.phonemeFrequency.get('a')).toBe(2);
    expect(s.phonemeFrequency.get('k')).toBe(1);
    expect(s.phonemeFrequency.get('p')).toBe(1);
    expect(s.phonemeFrequency.get('t')).toBe(1);
    expect(s.phonemeFrequency.get('n')).toBe(1);
    expect(s.phonemeFrequency.get('i')).toBe(1);
    expect(s.syllableShapeDistribution.get('CV')).toBe(2);
    expect(s.syllableShapeDistribution.get('CVC')).toBe(1);
    // 2 + 3 + 2 = 7 phonemes / 3 words
    expect(s.avgWordLength).toBeCloseTo(7 / 3, 5);
    // 4 consonants / 3 vowels
    expect(s.consonantVowelRatio).toBeCloseTo(4 / 3, 5);
  });

  it('produces a POS breakdown matching the tags', () => {
    const s = computeLexiconStatistics(
      [
        { lemma: 'ka', pos: 'noun' },
        { lemma: 'pa', pos: 'noun' },
        { lemma: 'ti', pos: 'verb' },
      ],
      phono,
      spec,
    );
    expect(s.posBreakdown.get('noun')).toBe(2);
    expect(s.posBreakdown.get('verb')).toBe(1);
  });

  it('groups entries without POS under "untagged"', () => {
    const s = computeLexiconStatistics(
      [
        { lemma: 'ka' },
        { lemma: 'pa', pos: 'noun' },
        { lemma: 'ti' },
      ],
      phono,
      spec,
    );
    expect(s.posBreakdown.get('untagged')).toBe(2);
    expect(s.posBreakdown.get('noun')).toBe(1);
    expect(s.registerBreakdown.get('untagged')).toBe(3);
  });

  it('skips lemmas that do not tokenize against the inventory', () => {
    const s = computeLexiconStatistics(
      [
        { lemma: 'ka' },
        { lemma: 'xyz' }, // contains symbols not in the inventory
      ],
      phono,
      spec,
    );
    expect(s.wordCount).toBe(2);
    expect(s.parsedCount).toBe(1);
    expect(s.unparseable).toBe(1);
    expect(s.phonemeFrequency.get('k')).toBe(1);
    expect(s.avgWordLength).toBe(2);
  });
});
