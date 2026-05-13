import { describe, expect, it } from 'vitest';
import type { Phonology } from './phonology.js';
import type { PhonotacticSpec } from './phonotactics.js';
import { parseAllophonyRules, stringifyAllophonyRule } from './allophony.js';
import { suggestPhonotactics, suggestAllophony } from './naturalistic.js';

function ph(phonemes: Phonology['phonemes']): Phonology {
  return { languageId: 'demo', phonemes };
}

const STANDARD = ph([
  { id: 'p', ipa: 'p', features: { manner: 'plosive', place: 'bilabial', voicing: 'voiceless' } },
  { id: 't', ipa: 't', features: { manner: 'plosive', place: 'alveolar', voicing: 'voiceless' } },
  { id: 'k', ipa: 'k', features: { manner: 'plosive', place: 'velar', voicing: 'voiceless' } },
  { id: 'b', ipa: 'b', features: { manner: 'plosive', place: 'bilabial', voicing: 'voiced' } },
  { id: 'd', ipa: 'd', features: { manner: 'plosive', place: 'alveolar', voicing: 'voiced' } },
  { id: 'ɡ', ipa: 'ɡ', features: { manner: 'plosive', place: 'velar', voicing: 'voiced' } },
  { id: 'm', ipa: 'm', features: { manner: 'nasal', place: 'bilabial', voicing: 'voiced' } },
  { id: 'n', ipa: 'n', features: { manner: 'nasal', place: 'alveolar', voicing: 'voiced' } },
  { id: 'ŋ', ipa: 'ŋ', features: { manner: 'nasal', place: 'velar', voicing: 'voiced' } },
  { id: 'a', ipa: 'a', features: { height: 'open', backness: 'central' } },
  { id: 'i', ipa: 'i', features: { height: 'close', backness: 'front' } },
  { id: 'u', ipa: 'u', features: { height: 'close', backness: 'back' } },
]);

const SMALL = ph([
  { id: 'p', ipa: 'p', features: { manner: 'plosive', place: 'bilabial', voicing: 'voiceless' } },
  { id: 'l', ipa: 'l', features: { manner: 'lateral-approximant', place: 'alveolar', voicing: 'voiced' } },
  { id: 'a', ipa: 'a', features: { height: 'open', backness: 'central' } },
]);

const specFor = (p: Phonology, vowels: string[], extra: Partial<PhonotacticSpec['syllable']> = {}): PhonotacticSpec => ({
  phonologyId: p.languageId,
  vowels,
  syllable: { templates: ['CV', 'CVC'], ...extra },
});

describe('suggestPhonotactics', () => {
  it('single-C onsets and codas are universally legal', () => {
    const spec = specFor(STANDARD, ['a', 'i', 'u']);
    const suggestions = suggestPhonotactics(spec, STANDARD);
    // For inventory consonants {p, t, k, b, d, ɡ, m, n, ŋ}, every single-C (onset, '') should be legal.
    const cons = ['p', 't', 'k', 'b', 'd', 'ɡ', 'm', 'n', 'ŋ'];
    for (const c of cons) {
      const hit = suggestions.find(s => s.pair[0] === c && s.pair[1] === '');
      expect(hit, `(${c}, ∅) should exist`).toBeDefined();
      expect(hit!.suggestedLegality).toBe('legal');
    }
  });

  it('sonority basics: (p, l) onset cluster rises; (l, p) does not', () => {
    const spec = specFor(SMALL, ['a'], { onsetClusters: ['pl', 'lp'] });
    const suggestions = suggestPhonotactics(spec, SMALL);
    const pl = suggestions.find(s => s.pair[0] === 'pl' && s.pair[1] === '');
    const lp = suggestions.find(s => s.pair[0] === 'lp' && s.pair[1] === '');
    expect(pl?.suggestedLegality).toBe('legal');
    expect(lp?.suggestedLegality === 'illegal' || lp?.suggestedLegality === 'restricted').toBe(true);
  });
});

describe('suggestAllophony', () => {
  it('returns a lenition suggestion for standard inventory', () => {
    const out = suggestAllophony(STANDARD);
    const lenition = out.find(s => /spirantization|lenition/i.test(s.rule.label ?? '') || s.rule.surface === 'β' || s.rule.surface === 'ð' || s.rule.surface === 'ɣ');
    expect(lenition).toBeDefined();
    expect(lenition!.confidence).toBeGreaterThan(0.5);
  });

  it('returns a final devoicing suggestion', () => {
    const out = suggestAllophony(STANDARD);
    const dev = out.find(s => /final devoicing/i.test(s.rule.label ?? ''));
    expect(dev).toBeDefined();
  });

  it('returns a palatalization suggestion for {k g i e a}', () => {
    const p = ph([
      { id: 'k', ipa: 'k', features: { manner: 'plosive', place: 'velar', voicing: 'voiceless' } },
      { id: 'ɡ', ipa: 'ɡ', features: { manner: 'plosive', place: 'velar', voicing: 'voiced' } },
      { id: 'i', ipa: 'i', features: { height: 'close', backness: 'front' } },
      { id: 'e', ipa: 'e', features: { height: 'close-mid', backness: 'front' } },
      { id: 'a', ipa: 'a', features: { height: 'open', backness: 'central' } },
    ]);
    const out = suggestAllophony(p);
    const pal = out.find(s => /palatalization/i.test(s.rule.label ?? ''));
    expect(pal).toBeDefined();
  });

  it('no matching processes for minimal {p, a}', () => {
    const p = ph([
      { id: 'p', ipa: 'p', features: { manner: 'plosive', place: 'bilabial', voicing: 'voiceless' } },
      { id: 'a', ipa: 'a', features: { height: 'open', backness: 'central' } },
    ]);
    const out = suggestAllophony(p);
    // Word-final unrelease for /p/ may surface; that's it.
    expect(out.length).toBeLessThanOrEqual(2);
  });

  it('every suggestion has attestation entries', () => {
    const out = suggestAllophony(STANDARD);
    expect(out.length).toBeGreaterThan(0);
    for (const s of out) {
      expect(s.attestation.length).toBeGreaterThanOrEqual(1);
    }
  });

  it('every suggested rule round-trips through stringify/parse', () => {
    const out = suggestAllophony(STANDARD);
    expect(out.length).toBeGreaterThan(0);
    for (const s of out) {
      const text = stringifyAllophonyRule(s.rule);
      // Drafts are emitted as comments; skip those.
      if (text.startsWith('//')) continue;
      const reparsed = parseAllophonyRules(text);
      expect(reparsed.length).toBe(1);
      expect(reparsed[0]!.phoneme).toBe(s.rule.phoneme);
      expect(reparsed[0]!.surface).toBe(s.rule.surface);
    }
  });

  it('returns at least 4 suggestions for a typical inventory', () => {
    const out = suggestAllophony(STANDARD);
    expect(out.length).toBeGreaterThanOrEqual(4);
  });
});
