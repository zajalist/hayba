import { describe, expect, it } from 'vitest';
import { parseRule, parseRules, stringifyRule, evolveWord } from './sound-changes.js';
import type { Phonology } from './phonology.js';

const ph: Phonology = {
  languageId: 'demo',
  phonemes: [
    { id: 'p', ipa: 'p', features: { manner: 'plosive' } },
    { id: 'b', ipa: 'b', features: { manner: 'plosive' } },
    { id: 't', ipa: 't', features: { manner: 'plosive' } },
    { id: 'd', ipa: 'd', features: { manner: 'plosive' } },
    { id: 'k', ipa: 'k', features: { manner: 'plosive' } },
    { id: 'n', ipa: 'n', features: { manner: 'nasal' } },
    { id: 'm', ipa: 'm', features: { manner: 'nasal' } },
    { id: 'a', ipa: 'a', features: { height: 'open' } },
    { id: 'i', ipa: 'i', features: { height: 'close' } },
  ],
};

const classes = {
  V: new Set(['a', 'i']),
  C: new Set(['p', 'b', 't', 'd', 'k', 'n', 'm']),
  nasal: new Set(['n', 'm']),
};

describe('rule parser', () => {
  it('parses target > replacement with context', () => {
    const r = parseRule('p > b / V _ V');
    expect(r.target).toBe('p');
    expect(r.replacement).toBe('b');
    expect(r.before).toEqual(['V']);
    expect(r.after).toEqual(['V']);
  });

  it('parses zero replacement (deletion)', () => {
    const r = parseRule('t > 0 / _ #');
    expect(r.replacement).toBe('0');
    expect(r.after).toEqual(['#']);
  });

  it('parses bracketed feature classes', () => {
    const r = parseRule('[+nasal] > 0 / _ #');
    expect(r.target).toBe('[+nasal]');
  });

  it('ignores comments and blanks', () => {
    const rs = parseRules(`
      // intervocalic lenition
      p > b / V _ V
      # final-stop deletion
      t > 0 / _ #
    `);
    expect(rs).toHaveLength(2);
  });
});

describe('rule stringify round-trip', () => {
  // Helper: compare structurally, ignoring `source` (which preserves the
  // original input text and is not part of the canonical form).
  const eqStruct = (a: ReturnType<typeof parseRule>, b: ReturnType<typeof parseRule>) => {
    expect(a.target).toBe(b.target);
    expect(a.replacement).toBe(b.replacement);
    expect(a.before).toEqual(b.before);
    expect(a.after).toEqual(b.after);
  };

  const cases: Array<[string, string]> = [
    ['bare segment, no context', 't > s'],
    ['feature-class target, V context', '[V] > [V] / [V] _ [V]'],
    ['shorthand class target', '[nasal] > 0 / _ #'],
    ['deletion to 0', 't > 0 / _ #'],
    ['word-boundary on the left', 'k > x / # _'],
    ['multi-segment context', 'a > e / # p _ t'],
  ];

  for (const [label, text] of cases) {
    it(`round-trips: ${label}`, () => {
      const r = parseRule(text);
      const text2 = stringifyRule(r);
      const r2 = parseRule(text2);
      eqStruct(r, r2);
      // Idempotent.
      expect(stringifyRule(r2)).toBe(text2);
    });
  }

  it('strips trailing // comments on round-trip', () => {
    const r = parseRule('p > b / [V] _ [V]    // intervocalic voicing');
    const out = stringifyRule(r);
    expect(out).toBe('p > b / [V] _ [V]');
    // Parse-of-stringify still structurally equals original.
    const r2 = parseRule(out);
    expect(r2.before).toEqual(r.before);
    expect(r2.after).toEqual(r.after);
  });

  it('throws clearly on a malformed rule', () => {
    expect(() => parseRule('this is not a rule')).toThrow(/cannot parse sound-change rule/);
  });
});

describe('rule application', () => {
  it('lenites /p/ between vowels', () => {
    const rules = parseRules('p > b / [V] _ [V]');
    expect(evolveWord('apa', ph, rules, classes)).toBe('aba');
    expect(evolveWord('pa', ph, rules, classes)).toBe('pa'); // no left vowel
  });

  it('deletes word-final stops', () => {
    const rules = parseRules('t > 0 / _ #');
    expect(evolveWord('kat', ph, rules, classes)).toBe('ka');
    expect(evolveWord('kati', ph, rules, classes)).toBe('kati');
  });

  it('deletes word-final nasals via feature class', () => {
    const rules = parseRules('[nasal] > 0 / _ #');
    expect(evolveWord('kan', ph, rules, classes)).toBe('ka');
    expect(evolveWord('kam', ph, rules, classes)).toBe('ka');
    expect(evolveWord('nani', ph, rules, classes)).toBe('nani');
  });

  it('applies rules in declared order', () => {
    const rules = parseRules(`
      p > b / [V] _ [V]
      b > 0 / [V] _ [V]
    `);
    // p → b → 0 between vowels.
    expect(evolveWord('apa', ph, rules, classes)).toBe('aa');
  });
});
