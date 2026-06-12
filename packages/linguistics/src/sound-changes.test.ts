import { describe, expect, it } from 'vitest';
import { parseRule, parseRules, evolveWord } from './sound-changes.js';
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
