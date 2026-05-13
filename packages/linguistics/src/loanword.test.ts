import { describe, expect, it } from 'vitest';
import type { Phonology } from './phonology.js';
import type { PhonotacticSpec } from './phonotactics.js';
import { passesPhonotactics } from './phonotactics.js';
import { createLoanwordAdapter } from './loanword.js';

/* Polynesian-style CV inventory — useful for cluster-repair stress tests. */
const polynesian: Phonology = {
  languageId: 'poly',
  phonemes: [
    { id: 'p', ipa: 'p', features: { place: 'bilabial', manner: 'plosive', voicing: 'voiceless' } },
    { id: 't', ipa: 't', features: { place: 'alveolar', manner: 'plosive', voicing: 'voiceless' } },
    { id: 'k', ipa: 'k', features: { place: 'velar',    manner: 'plosive', voicing: 'voiceless' } },
    { id: 'm', ipa: 'm', features: { place: 'bilabial', manner: 'nasal',   voicing: 'voiced' } },
    { id: 'n', ipa: 'n', features: { place: 'alveolar', manner: 'nasal',   voicing: 'voiced' } },
    { id: 'a', ipa: 'a', features: { height: 'open',     backness: 'front', roundness: 'unrounded' } },
    { id: 'i', ipa: 'i', features: { height: 'close',    backness: 'front', roundness: 'unrounded' } },
    { id: 'u', ipa: 'u', features: { height: 'close',    backness: 'back',  roundness: 'rounded' } },
  ],
};

const polySpec: PhonotacticSpec = {
  phonologyId: 'poly',
  vowels: ['a', 'i', 'u'],
  syllable: { templates: ['CV', 'V'] },
};

/* A more permissive inventory with θ absent, so we can test feature-distance substitution. */
const noThetaPhonology: Phonology = {
  languageId: 'noth',
  phonemes: [
    { id: 'p', ipa: 'p', features: { place: 'bilabial', manner: 'plosive', voicing: 'voiceless' } },
    { id: 't', ipa: 't', features: { place: 'alveolar', manner: 'plosive', voicing: 'voiceless' } },
    { id: 'k', ipa: 'k', features: { place: 'velar',    manner: 'plosive', voicing: 'voiceless' } },
    { id: 's', ipa: 's', features: { place: 'alveolar', manner: 'sibilant-fricative', voicing: 'voiceless' } },
    { id: 'f', ipa: 'f', features: { place: 'labiodental', manner: 'fricative', voicing: 'voiceless' } },
    { id: 'm', ipa: 'm', features: { place: 'bilabial', manner: 'nasal', voicing: 'voiced' } },
    { id: 'n', ipa: 'n', features: { place: 'alveolar', manner: 'nasal', voicing: 'voiced' } },
    { id: 'a', ipa: 'a', features: { height: 'open',     backness: 'front', roundness: 'unrounded' } },
    { id: 'i', ipa: 'i', features: { height: 'close',    backness: 'front', roundness: 'unrounded' } },
    { id: 'u', ipa: 'u', features: { height: 'close',    backness: 'back',  roundness: 'rounded' } },
    { id: 'o', ipa: 'o', features: { height: 'close-mid', backness: 'back', roundness: 'rounded' } },
  ],
};

const noThetaSpec: PhonotacticSpec = {
  phonologyId: 'noth',
  vowels: ['a', 'i', 'u', 'o'],
  syllable: { templates: ['CV', 'CVC', 'V'] },
};

describe('createLoanwordAdapter', () => {
  it('substitutes a phoneme not in inventory and records the step', () => {
    const adapter = createLoanwordAdapter(noThetaPhonology, noThetaSpec);
    // 'θa' — θ absent from noTheta inventory; should land on a fricative or plosive nearby.
    const result = adapter.adapt('θa');
    expect(result.steps.some(s => s.kind === 'substitute' && s.before === 'θ')).toBe(true);
    expect(result.adapted).not.toContain('θ');
    expect(passesPhonotactics(result.adapted, noThetaPhonology, noThetaSpec)).toBe(true);
    // The audit message should mention θ and the substitute target.
    const sub = result.steps.find(s => s.before === 'θ')!;
    expect(sub.reason).toMatch(/θ/);
    expect(sub.reason).toMatch(sub.after);
  });

  it('adapts "computer" against a CV-only Polynesian inventory via vowel epenthesis', () => {
    const adapter = createLoanwordAdapter(polynesian, polySpec);
    const result = adapter.adapt('computer');
    expect(passesPhonotactics(result.adapted, polynesian, polySpec)).toBe(true);
    expect(result.steps.some(s => s.kind === 'insert-vowel')).toBe(true);
    // Should be a multi-syllable Polynesian-style output.
    // Each syllable is CV or V, so adapted length / vowels ≥ 4 syllables.
    const vowels = new Set(['a', 'i', 'u']);
    const vowelCount = [...result.adapted].filter(c => vowels.has(c)).length;
    expect(vowelCount).toBeGreaterThanOrEqual(4);
  });

  it('throws on empty input', () => {
    const adapter = createLoanwordAdapter(polynesian, polySpec);
    expect(() => adapter.adapt('')).toThrow(/empty/);
    expect(() => adapter.adapt('   ')).toThrow(/empty/);
  });

  it('passes through an already-legal IPA word with zero steps', () => {
    const adapter = createLoanwordAdapter(polynesian, polySpec);
    const result = adapter.adapt('paka');
    expect(result.adapted).toBe('paka');
    expect(result.steps).toEqual([]);
    expect(passesPhonotactics(result.adapted, polynesian, polySpec)).toBe(true);
  });

  it('audit trail captures every transformation in order', () => {
    const adapter = createLoanwordAdapter(polynesian, polySpec);
    const result = adapter.adapt('strikt'); // s,t,r,i,k,t — lots of repairs needed
    expect(result.steps.length).toBeGreaterThan(0);
    // Steps must each have a non-empty human-readable reason.
    for (const s of result.steps) {
      expect(s.reason.length).toBeGreaterThan(0);
      expect(['substitute', 'insert-vowel', 'delete', 'transpose']).toContain(s.kind);
    }
    expect(passesPhonotactics(result.adapted, polynesian, polySpec)).toBe(true);
  });

  it('honours substitutionTable overrides', () => {
    const adapter = createLoanwordAdapter(noThetaPhonology, noThetaSpec, {
      substitutionTable: { θ: 'f' }, // force θ → f instead of feature-distance pick
    });
    const result = adapter.adapt('θa');
    const sub = result.steps.find(s => s.before === 'θ')!;
    expect(sub.after).toBe('f');
    expect(sub.reason).toMatch(/substitution table/);
    expect(result.adapted.startsWith('f')).toBe(true);
  });

  it('emits romanized form when a romanization map is supplied', () => {
    const adapter = createLoanwordAdapter(polynesian, polySpec, {
      romanization: { languageId: 'poly', rules: [['k', 'c'], ['a', 'a']] },
    });
    const result = adapter.adapt('paka');
    expect(result.romanized).toBe('paca');
  });
});
