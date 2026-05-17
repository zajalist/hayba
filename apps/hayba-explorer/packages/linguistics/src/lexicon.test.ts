import { describe, expect, it } from 'vitest';
import { InMemoryLexicon, PARTS_OF_SPEECH } from './lexicon.js';
import type { Lexeme } from './lexicon.js';

describe('lexicon — L9 parts of speech + morph', () => {
  it('exports a canonical 11-tag POS set', () => {
    expect(PARTS_OF_SPEECH).toContain('noun');
    expect(PARTS_OF_SPEECH).toContain('verb');
    expect(PARTS_OF_SPEECH.length).toBe(11);
  });

  it('round-trips POS + morph features in-memory', () => {
    const lex = new InMemoryLexicon();
    const entry: Lexeme = {
      lemma: 'kati',
      ipa: 'kati',
      gloss: 'mountain',
      pos: 'noun',
      morph: { number: 'sg', case: 'nom' },
    };
    lex.set('demo', 'mountain', entry);
    const got = lex.get('demo', 'mountain');
    expect(got?.pos).toBe('noun');
    expect(got?.morph?.case).toBe('nom');
    expect(got?.morph?.number).toBe('sg');
  });

  it('filters by POS', () => {
    const lex = new InMemoryLexicon();
    lex.set('demo', 'cat', { lemma: 'mau', ipa: 'mau', gloss: 'cat', pos: 'noun' });
    lex.set('demo', 'run', { lemma: 'fla', ipa: 'fla', gloss: 'run', pos: 'verb' });
    lex.set('demo', 'big', { lemma: 'tor', ipa: 'tor', gloss: 'big', pos: 'adjective' });
    const nouns = lex.byPos('demo', 'noun');
    expect(nouns).toHaveLength(1);
    expect(nouns[0]!.concept).toBe('cat');
    const verbs = lex.byPos('demo', 'verb');
    expect(verbs.map(v => v.entry.lemma)).toEqual(['fla']);
  });

  it('accepts custom POS strings (open set)', () => {
    const lex = new InMemoryLexicon();
    lex.set('demo', 'X', { lemma: 'qq', ipa: 'qq', gloss: 'X', pos: 'classifier' });
    expect(lex.byPos('demo', 'classifier')).toHaveLength(1);
  });

  it('defaults POS to undefined when not provided (back-compat)', () => {
    const lex = new InMemoryLexicon();
    lex.set('demo', 'x', { lemma: 'aa', ipa: 'aa', gloss: 'x' });
    const got = lex.get('demo', 'x');
    expect(got?.pos).toBeUndefined();
    expect(got?.morph).toBeUndefined();
  });
});
