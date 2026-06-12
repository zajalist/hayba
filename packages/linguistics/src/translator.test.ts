import { describe, expect, it } from 'vitest';
import { translate, tokenize, lemmatize, renderTranslation, renderRomanized } from './translator.js';
import { InMemoryLexicon } from './lexicon.js';
import type { Phonology } from './phonology.js';
import type { PhonotacticSpec } from './phonotactics.js';
import type { NameGeneratorProfile } from './name-generator.js';

const ph: Phonology = {
  languageId: 'demo',
  phonemes: [
    { id: 'p', ipa: 'p', features: { manner: 'plosive' } },
    { id: 't', ipa: 't', features: { manner: 'plosive' } },
    { id: 'k', ipa: 'k', features: { manner: 'plosive' } },
    { id: 'm', ipa: 'm', features: { manner: 'nasal' } },
    { id: 'n', ipa: 'n', features: { manner: 'nasal' } },
    { id: 'a', ipa: 'a', features: { height: 'open' } },
    { id: 'i', ipa: 'i', features: { height: 'close' } },
    { id: 'u', ipa: 'u', features: { height: 'close' } },
  ],
};
const pt: PhonotacticSpec = {
  phonologyId: 'demo', vowels: ['a', 'i', 'u'],
  syllable: { templates: ['CV'] },
};
const profile: NameGeneratorProfile = {
  syllableTemplate: 'CV', vowels: ['a','i','u'], onsetPool: ['p','t','k','m','n'],
};

function mkCtx() {
  const lex = new InMemoryLexicon();
  return {
    languageId: 'demo',
    phonology: ph, phonotactics: pt, lexicon: lex,
    fallbackProfile: profile,
    seed: 4242n,
  };
}

describe('tokenize', () => {
  it('splits words, whitespace, and punctuation', () => {
    const toks = tokenize('Hello, world!');
    expect(toks.map(t => t.kind)).toEqual(['word','punct','space','word','punct']);
    expect(toks.map(t => t.text)).toEqual(['Hello',',',' ','world','!']);
  });

  it('preserves apostrophes and hyphens in words', () => {
    expect(tokenize("don't").map(t => t.text)).toEqual(["don't"]);
    expect(tokenize('half-life').map(t => t.text)).toEqual(['half-life']);
  });
});

describe('lemmatize', () => {
  it('strips plural -s', () => {
    expect(lemmatize('mountains').concept).toBe('mountain');
  });
  it('strips -ed and prefixes verbs with to-', () => {
    expect(lemmatize('walked').concept).toBe('to-walk');
    expect(lemmatize('walked').posHint).toBe('verb');
  });
  it('strips -ing and prefixes verbs with to-', () => {
    expect(lemmatize('walking').concept).toBe('to-walk');
  });
  it('strips -ly and tags adverbs', () => {
    expect(lemmatize('quickly').concept).toBe('quick');
    expect(lemmatize('quickly').posHint).toBe('adverb');
  });
  it('handles -ies → -y', () => {
    expect(lemmatize('cities').concept).toBe('city');
  });
  it('leaves irregular words alone (best-effort)', () => {
    expect(lemmatize('is').concept).toBe('is');
  });
});

describe('translate', () => {
  it('translates known words via lexicon', async () => {
    const ctx = mkCtx();
    ctx.lexicon.set('demo', 'mountain', { lemma: 'kati', ipa: 'kati', gloss: 'mountain', pos: 'noun' });
    ctx.lexicon.set('demo', 'big', { lemma: 'na', ipa: 'na', gloss: 'big', pos: 'adjective' });
    const r = await translate('big mountain', ctx);
    expect(r.tokens.filter(t => t.kind === 'word').map(t => t.lemma)).toEqual(['na', 'kati']);
    expect(r.generated).toEqual([]);
  });

  it('generates lemmas for unknown words and persists them', async () => {
    const ctx = mkCtx();
    const first = await translate('strange word', ctx);
    expect(first.generated.length).toBe(2);
    const lemmaStrange = first.tokens.find(t => t.concept === 'strange')!.lemma;
    expect(lemmaStrange).toMatch(/^[ptkmnaiu]+$/);
    // Second call returns identical lemmas — no new generation.
    const second = await translate('strange word', ctx);
    expect(second.generated.length).toBe(0);
    expect(second.tokens.find(t => t.concept === 'strange')!.lemma).toBe(lemmaStrange);
  });

  it('is deterministic — same seed + language → identical translation', async () => {
    const a = await translate('a wild river', mkCtx());
    const b = await translate('a wild river', mkCtx());
    expect(renderTranslation(a)).toBe(renderTranslation(b));
  });

  it('handles plural lemmatisation — mountains → mountain', async () => {
    const ctx = mkCtx();
    ctx.lexicon.set('demo', 'mountain', { lemma: 'kati', ipa: 'kati', gloss: 'mountain', pos: 'noun' });
    const r = await translate('two mountains', ctx);
    expect(r.tokens.find(t => t.concept === 'mountain')!.lemma).toBe('kati');
    expect(r.tokens.find(t => t.concept === 'mountain')!.generated).toBe(false);
  });

  it('preserves punctuation and spacing in renderTranslation', async () => {
    const ctx = mkCtx();
    ctx.lexicon.set('demo', 'hello', { lemma: 'mata', ipa: 'mata', gloss: 'hello', pos: 'interjection' });
    ctx.lexicon.set('demo', 'world', { lemma: 'kuna', ipa: 'kuna', gloss: 'world', pos: 'noun' });
    const r = await translate('Hello, world!', ctx);
    expect(renderTranslation(r)).toBe('mata, kuna!');
  });

  it('uses romanization map when provided', async () => {
    const ctx = {
      ...mkCtx(),
      romanization: { languageId: 'demo', rules: [['k', 'c'] as const] },
    };
    ctx.lexicon.set('demo', 'mountain', { lemma: 'kati', ipa: 'kati', gloss: 'mountain', pos: 'noun' });
    const r = await translate('mountain', ctx);
    expect(r.tokens[0]!.romanized).toBe('cati');
    expect(renderRomanized(r)).toBe('cati');
  });
});
