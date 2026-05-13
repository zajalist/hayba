import { describe, expect, it } from 'vitest';
import { buildPhrasePack, PHRASE_TEMPLATES, allPhraseSlots } from './phrase-pack.js';
import type { PhrasePackParams } from './phrase-pack.js';
import { InMemoryLexicon } from './lexicon.js';
import { passesPhonotactics } from './phonotactics.js';
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
    { id: 's', ipa: 's', features: { manner: 'fricative' } },
    { id: 'a', ipa: 'a', features: { height: 'open' } },
    { id: 'i', ipa: 'i', features: { height: 'close' } },
    { id: 'u', ipa: 'u', features: { height: 'close' } },
  ],
};
const pt: PhonotacticSpec = {
  phonologyId: 'demo',
  vowels: ['a', 'i', 'u'],
  syllable: { templates: ['CV'] },
};
const profile: NameGeneratorProfile = {
  syllableTemplate: 'CV',
  vowels: ['a', 'i', 'u'],
  onsetPool: ['p', 't', 'k', 'm', 'n', 's'],
};

function mkParams(overrides: Partial<PhrasePackParams> = {}): PhrasePackParams {
  return {
    languageId: 'demo',
    phonology: ph,
    phonotactics: pt,
    lexicon: new InMemoryLexicon(),
    fallbackProfile: profile,
    seed: 4242n,
    ...overrides,
  };
}

describe('buildPhrasePack', () => {
  it('produces 50 entries when no category filter is provided', async () => {
    const pack = await buildPhrasePack(mkParams());
    expect(pack).toHaveLength(50);
    expect(PHRASE_TEMPLATES).toHaveLength(50);
  });

  it('filters to a single category', async () => {
    const pack = await buildPhrasePack(mkParams({ categories: ['numbers'] }));
    expect(pack).toHaveLength(10);
    expect(pack.every(p => p.category === 'numbers')).toBe(true);
  });

  it('produces 10 numbers + 7 days when filtered to both', async () => {
    const pack = await buildPhrasePack(mkParams({ categories: ['numbers', 'days'] }));
    expect(pack).toHaveLength(17);
  });

  it('is deterministic — same seed + langId → identical phrases', async () => {
    const a = await buildPhrasePack(mkParams());
    const b = await buildPhrasePack(mkParams());
    expect(a.map(p => p.phrase)).toEqual(b.map(p => p.phrase));
    expect(a.map(p => p.concept)).toEqual(b.map(p => p.concept));
  });

  it('different seeds → different phrases', async () => {
    const a = await buildPhrasePack(mkParams({ seed: 1n }));
    const b = await buildPhrasePack(mkParams({ seed: 99999n }));
    // Not every entry must differ but the packs as a whole should.
    const sameCount = a.filter((p, i) => p.phrase === b[i]!.phrase).length;
    expect(sameCount).toBeLessThan(a.length);
  });

  it('all phrase tokens pass phonotactics', async () => {
    const pack = await buildPhrasePack(mkParams());
    for (const entry of pack) {
      for (const tok of entry.tokens) {
        expect(passesPhonotactics(tok.lemma, ph, pt)).toBe(true);
      }
    }
  });

  it('numbers 1-10 are phonetically distinct (no all-same collisions)', async () => {
    const pack = await buildPhrasePack(mkParams({ categories: ['numbers'] }));
    const lemmas = pack.map(p => p.phrase);
    const unique = new Set(lemmas);
    // Allow a couple of accidental collisions, but they must not collapse to one.
    expect(unique.size).toBeGreaterThanOrEqual(8);
  });

  it('second call with same params persists everything — zero new lemmas generated', async () => {
    const lex = new InMemoryLexicon();
    await buildPhrasePack(mkParams({ lexicon: lex }));
    const slotsAfterFirst = allPhraseSlots()
      .map(s => lex.get('demo', s))
      .filter(Boolean).length;
    expect(slotsAfterFirst).toBe(allPhraseSlots().length);

    // Snapshot all lemmas, then re-run; nothing should change.
    const before = lex.all('demo').map(e => `${e.concept}:${e.entry.lemma}`).sort();
    await buildPhrasePack(mkParams({ lexicon: lex }));
    const after = lex.all('demo').map(e => `${e.concept}:${e.entry.lemma}`).sort();
    expect(after).toEqual(before);
  });

  it('reuses existing lexicon entries instead of generating', async () => {
    const lex = new InMemoryLexicon();
    lex.set('demo', 'yes', { lemma: 'sii', ipa: 'sii', gloss: 'yes', pos: 'particle' });
    const pack = await buildPhrasePack(mkParams({ lexicon: lex }));
    const yesEntry = pack.find(p => p.concept === 'yes')!;
    expect(yesEntry.phrase).toBe('sii');
    expect(yesEntry.tokens[0]!.lemma).toBe('sii');
  });

  it('tags function-word concepts with sensible POS', async () => {
    const lex = new InMemoryLexicon();
    await buildPhrasePack(mkParams({ lexicon: lex }));
    expect(lex.get('demo', 'yes')!.pos).toBe('particle');
    expect(lex.get('demo', 'one')!.pos).toBe('numeral');
    expect(lex.get('demo', 'first')!.pos).toBe('numeral');
    expect(lex.get('demo', 'you')!.pos).toBe('pronoun');
    expect(lex.get('demo', 'mother')!.pos).toBe('noun');
    expect(lex.get('demo', 'good')!.pos).toBe('adjective');
    expect(lex.get('demo', 'greet')!.pos).toBe('interjection');
    expect(lex.get('demo', 'where')!.pos).toBe('adverb');
  });

  it('throws clearly when phoneme inventory is empty', async () => {
    const emptyPh: Phonology = { languageId: 'demo', phonemes: [] };
    await expect(buildPhrasePack(mkParams({ phonology: emptyPh }))).rejects.toThrow(/empty phoneme inventory/);
  });

  it('every template references at least one slot', () => {
    for (const t of PHRASE_TEMPLATES) {
      expect(t.slots.length).toBeGreaterThan(0);
    }
  });

  it('category counts match the spec', () => {
    const counts = new Map<string, number>();
    for (const t of PHRASE_TEMPLATES) counts.set(t.category, (counts.get(t.category) ?? 0) + 1);
    expect(counts.get('greeting')).toBe(5);
    expect(counts.get('farewell')).toBe(3);
    expect(counts.get('yesno')).toBe(3);
    expect(counts.get('numbers')).toBe(10);
    expect(counts.get('days')).toBe(7);
    expect(counts.get('kin')).toBe(7);
    expect(counts.get('directions')).toBe(6);
    expect(counts.get('politeness')).toBe(5);
    expect(counts.get('questions')).toBe(4);
  });
});
