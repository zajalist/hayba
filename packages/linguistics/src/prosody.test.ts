import { describe, it, expect } from 'vitest';
import { assignStress, applyTones, toneToLetters, type ToneRule, type ToneSandhi } from './prosody.js';
import type { Phonology } from './phonology.js';

describe('assignStress — fixed', () => {
  it('initial → 0', () => {
    expect(assignStress([['p','a'],['k','a']], { kind: 'fixed', position: 'initial' })).toBe(0);
  });
  it('penultimate on 3-syllable word → index 1', () => {
    expect(assignStress([['p','a'],['k','a'],['t','a']], { kind: 'fixed', position: 'penultimate' })).toBe(1);
  });
  it('final → last index', () => {
    expect(assignStress([['p','a'],['k','a'],['t','a']], { kind: 'fixed', position: 'final' })).toBe(2);
  });
  it('antepenultimate on 2-syllable falls back to penultimate (index 0)', () => {
    expect(assignStress([['p','a'],['k','a']], { kind: 'fixed', position: 'antepenultimate' })).toBe(0);
  });
  it('antepenultimate on 1-syllable falls back to initial (index 0)', () => {
    expect(assignStress([['p','a']], { kind: 'fixed', position: 'antepenultimate' })).toBe(0);
  });
  it('antepenultimate on 4-syllable → index 1', () => {
    expect(assignStress([['p','a'],['k','a'],['t','a'],['m','a']], { kind: 'fixed', position: 'antepenultimate' })).toBe(1);
  });
  it('returns null for none', () => {
    expect(assignStress([['p','a']], { kind: 'none' })).toBeNull();
  });
  it('returns null for empty word', () => {
    expect(assignStress([], { kind: 'fixed', position: 'initial' })).toBeNull();
  });
});

describe('assignStress — weight-sensitive', () => {
  it('closed-syllable picks the closed one', () => {
    // [pak][ta] — first syllable is closed (has coda /k/)
    expect(
      assignStress([['p','a','k'],['t','a']], { kind: 'weight-sensitive', heavyDefinedBy: 'closed-syllable' }),
    ).toBe(0);
  });
  it('closed-syllable falls back to penultimate when nothing is heavy', () => {
    expect(
      assignStress([['p','a'],['k','a'],['t','a']], { kind: 'weight-sensitive', heavyDefinedBy: 'closed-syllable' }),
    ).toBe(1);
  });
  it('long-vowel picks the long-vowel syllable closest to the end', () => {
    expect(
      assignStress([['p','aː'],['k','a'],['t','aː']], { kind: 'weight-sensitive', heavyDefinedBy: 'long-vowel' }),
    ).toBe(2);
  });
  it('closed-or-long picks closest-to-end heavy syllable', () => {
    expect(
      assignStress(
        [['p','a','k'],['k','a'],['t','aː'],['m','a']],
        { kind: 'weight-sensitive', heavyDefinedBy: 'closed-or-long' },
      ),
    ).toBe(2);
  });
  it('uses phonology length feature when token has no ː diacritic', () => {
    const phono: Phonology = {
      languageId: 'L',
      phonemes: [
        { id: 'p', ipa: 'p', features: { manner: 'plosive', place: 'bilabial' } },
        { id: 'a', ipa: 'A', features: { height: 'low', backness: 'central', length: 'long' } },
        { id: 'k', ipa: 'k', features: { manner: 'plosive', place: 'velar' } },
        { id: 'i', ipa: 'i', features: { height: 'high', backness: 'front' } },
      ],
    };
    expect(
      assignStress([['p','i'],['k','A']], { kind: 'weight-sensitive', heavyDefinedBy: 'long-vowel' }, phono),
    ).toBe(1);
  });
});

describe('applyTones', () => {
  it('assigns H to initial syllable, null elsewhere', () => {
    const out = applyTones([['p','a'],['k','a']], [
      { condition: { position: 'initial' }, tone: 'H' },
    ], []);
    expect(out[0]!.tone).toBe('H');
    expect(out[1]!.tone).toBeNull();
  });

  it('phoneme-conditioned: assign HL to syllables containing /a/', () => {
    const out = applyTones([['p','a'],['k','i'],['t','a']], [
      { condition: { phoneme: 'a' }, tone: 'HL' },
    ], []);
    expect(out.map(o => o.tone)).toEqual(['HL', null, 'HL']);
  });

  it('higher priority wins among multiple matches', () => {
    const rules: ToneRule[] = [
      { condition: { position: 'initial' }, tone: 'L', priority: 0 },
      { condition: { phoneme: 'a' }, tone: 'H', priority: 5 },
    ];
    const out = applyTones([['p','a']], rules, []);
    expect(out[0]!.tone).toBe('H');
  });

  it('ties broken by rule order (earlier wins)', () => {
    const rules: ToneRule[] = [
      { condition: { position: 'initial' }, tone: 'H' },
      { condition: { phoneme: 'a' }, tone: 'L' },
    ];
    const out = applyTones([['p','a']], rules, []);
    expect(out[0]!.tone).toBe('H');
  });

  it('Mandarin-style sandhi: HL HL → LH HL', () => {
    const rules: ToneRule[] = [{ condition: { phoneme: 'a' }, tone: 'HL' }];
    const sandhi: ToneSandhi[] = [{ pattern: ['HL', 'HL'], result: 'LH' }];
    const out = applyTones([['p','a'],['k','a']], rules, sandhi);
    expect(out.map(o => o.tone)).toEqual(['LH', 'HL']);
  });

  it('sandhi only fires on matching adjacent pairs', () => {
    const rules: ToneRule[] = [
      { condition: { position: 'initial' }, tone: 'H' },
      { condition: { position: 'final' }, tone: 'L' },
    ];
    const sandhi: ToneSandhi[] = [{ pattern: ['HL', 'HL'], result: 'LH' }];
    const out = applyTones([['p','a'],['k','a']], rules, sandhi);
    expect(out.map(o => o.tone)).toEqual(['H', 'L']);
  });
});

describe('toneToLetters', () => {
  it('renders the IPA tone letters', () => {
    expect(toneToLetters('H')).toBe('˥');
    expect(toneToLetters('HL')).toBe('˥˩');
    expect(toneToLetters('HLH')).toBe('˥˩˥');
  });
});
