import { describe, expect, it } from 'vitest';
import {
  applyAllophony,
  parseAllophonyRules,
  stringifyAllophonyRule,
  surfaceOf,
  type AllophonyRule,
} from './allophony.js';
import type { Phonology } from './phonology.js';

const ph: Phonology = {
  languageId: 'demo',
  phonemes: [
    { id: 'p', ipa: 'p', features: { manner: 'plosive', place: 'labial' } },
    { id: 't', ipa: 't', features: { manner: 'plosive', place: 'alveolar' } },
    { id: 'k', ipa: 'k', features: { manner: 'plosive', place: 'velar' } },
    { id: 'n', ipa: 'n', features: { manner: 'nasal', place: 'alveolar' } },
    { id: 'm', ipa: 'm', features: { manner: 'nasal', place: 'labial' } },
    { id: 'a', ipa: 'a', features: { height: 'open' } },
    { id: 'i', ipa: 'i', features: { height: 'close' } },
    { id: 'u', ipa: 'u', features: { height: 'close' } },
  ],
};

const classes = {
  V: new Set(['a', 'i', 'u']),
  C: new Set(['p', 't', 'k', 'n', 'm']),
  velar: new Set(['k']),
  labial: new Set(['p', 'm']),
};

describe('applyAllophony', () => {
  it('intervocalic flap: /t/ → [ɾ] / [V] _ [V] on "kati"', () => {
    const rules: AllophonyRule[] = [
      { phoneme: 't', surface: 'ɾ', before: ['[V]'], after: ['[V]'] },
    ];
    const { surface, mapping } = applyAllophony('kati', ph, rules, classes);
    expect(surface).toBe('kaɾi');
    expect(mapping).toEqual([
      { underlying: 'k', surface: 'k' },
      { underlying: 'a', surface: 'a' },
      { underlying: 't', surface: 'ɾ', ruleIdx: 0 },
      { underlying: 'i', surface: 'i' },
    ]);
  });

  it('word-final unreleased stop: /k/ → [k̚] / _ # on "pak"', () => {
    const rules: AllophonyRule[] = [
      { phoneme: 'k', surface: 'k̚', before: [], after: ['#'] },
    ];
    const { surface, mapping } = applyAllophony('pak', ph, rules, classes);
    expect(surface).toBe('pak̚');
    expect(mapping[2]).toEqual({ underlying: 'k', surface: 'k̚', ruleIdx: 0 });
    expect(mapping[0]?.ruleIdx).toBeUndefined();
  });

  it('priority: higher-priority rule wins when both match', () => {
    const rules: AllophonyRule[] = [
      { phoneme: 't', surface: 'X', before: ['[V]'], after: ['[V]'], priority: 1 },
      { phoneme: 't', surface: 'Y', before: ['[V]'], after: ['[V]'], priority: 5 },
    ];
    const { surface, mapping } = applyAllophony('ata', ph, rules, classes);
    expect(surface).toBe('aYa');
    expect(mapping[1]?.ruleIdx).toBe(1);
  });

  it('priority ties: earlier rule in the list wins', () => {
    const rules: AllophonyRule[] = [
      { phoneme: 't', surface: 'A', before: ['[V]'], after: ['[V]'] },
      { phoneme: 't', surface: 'B', before: ['[V]'], after: ['[V]'] },
    ];
    const { surface, mapping } = applyAllophony('ata', ph, rules, classes);
    expect(surface).toBe('aAa');
    expect(mapping[1]?.ruleIdx).toBe(0);
  });

  it('no rule match: token passes through unchanged with ruleIdx undefined', () => {
    const rules: AllophonyRule[] = [
      { phoneme: 't', surface: 'ɾ', before: ['[V]'], after: ['[V]'] },
    ];
    const { surface, mapping } = applyAllophony('pak', ph, rules, classes);
    expect(surface).toBe('pak');
    for (const m of mapping) {
      expect(m.ruleIdx).toBeUndefined();
      expect(m.surface).toBe(m.underlying);
    }
  });

  it('class-based context: /n/ → [ŋ] / _ [velar] before /k/', () => {
    const rules: AllophonyRule[] = [
      { phoneme: 'n', surface: 'ŋ', before: [], after: ['[velar]'] },
    ];
    const { surface, mapping } = applyAllophony('anka', ph, rules, classes);
    expect(surface).toBe('aŋka');
    expect(mapping[1]).toEqual({ underlying: 'n', surface: 'ŋ', ruleIdx: 0 });
  });

  it('class-target: [labial] → m / # _ matches /p/ at word start', () => {
    const rules: AllophonyRule[] = [
      { phoneme: '[labial]', surface: 'm', before: ['#'], after: [] },
    ];
    const { surface } = applyAllophony('pak', ph, rules, classes);
    expect(surface).toBe('mak');
  });

  it('single-pass: an emitted surface does not feed later rules', () => {
    // If /t/ → ɾ and ɾ → r, the second rule must NOT fire on the output of
    // the first — allophony is synchronic, not chained.
    const rules: AllophonyRule[] = [
      { phoneme: 't', surface: 'ɾ', before: ['[V]'], after: ['[V]'] },
      { phoneme: 'ɾ', surface: 'r', before: ['[V]'], after: ['[V]'] },
    ];
    const { surface } = applyAllophony('ata', ph, rules, classes);
    expect(surface).toBe('aɾa');
  });
});

describe('parseAllophonyRules / stringifyAllophonyRule', () => {
  it('parses Lexurgy-style text into AllophonyRule[]', () => {
    const rs = parseAllophonyRules(`
      // intervocalic flap
      t > ɾ / [V] _ [V]
      n > ŋ / _ [velar]
    `);
    expect(rs).toHaveLength(2);
    expect(rs[0]).toMatchObject({ phoneme: 't', surface: 'ɾ', before: ['[V]'], after: ['[V]'] });
    expect(rs[1]).toMatchObject({ phoneme: 'n', surface: 'ŋ', before: [], after: ['[velar]'] });
  });

  it('stringify round-trips with parser (ignoring whitespace)', () => {
    const r: AllophonyRule = { phoneme: 't', surface: 'ɾ', before: ['[V]'], after: ['[V]'] };
    const text = stringifyAllophonyRule(r);
    const back = parseAllophonyRules(text);
    expect(back[0]).toMatchObject(r);
  });

  it('drafts stringify to a comment line', () => {
    expect(stringifyAllophonyRule({ phoneme: '', surface: '', before: [], after: [] }))
      .toBe('// (draft rule)');
  });
});

describe('surfaceOf', () => {
  it('returns just the surface string', () => {
    const rules: AllophonyRule[] = [
      { phoneme: 't', surface: 'ɾ', before: ['[V]'], after: ['[V]'] },
    ];
    expect(surfaceOf('kati', ph, rules, classes)).toBe('kaɾi');
  });
});
