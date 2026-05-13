/**
 * L24 — Phrase pack generator.
 *
 * Given a conlang (phonology + phonotactics + lexicon + L4 fallback profile),
 * auto-generate ~50 common phrases — greetings, farewells, yes/no, numbers,
 * days, kin, directions, politeness, questions.
 *
 * Behaviour mirrors L10 Translator: each phrase template names concept-slots
 * which are looked up in the lexicon; missing concepts are filled by L4
 * deterministically and persisted, so subsequent calls return identical
 * phrases.
 *
 * Pure over `(masterSeed, languageId, categories)`.
 */

import type { Phonology } from './phonology.js';
import type { PhonotacticSpec } from './phonotactics.js';
import type { Lexeme, LexiconRepo, PartOfSpeech } from './lexicon.js';
import type { NameGeneratorProfile } from './name-generator.js';
import { generatePhonotacticName } from './name-generator.js';
import { deriveSeed } from './rng.js';

export type PhraseCategory =
  | 'greeting' | 'farewell' | 'yesno' | 'numbers' | 'days'
  | 'kin' | 'directions' | 'politeness' | 'questions';

export type PhraseRegister = 'neutral' | 'formal' | 'slang' | 'poetic' | 'ritual';

export interface PhraseToken {
  source: string; // concept slot, e.g. "greet"
  lemma: string;
  ipa?: string;
}

export interface PhraseEntry {
  concept: string;           // canonical English description (e.g. "hello-formal")
  phrase: string;            // surface form in conlang (lemmas joined by spaces)
  tokens: PhraseToken[];
  register: PhraseRegister;
  contextNote?: string;
  category: PhraseCategory;
}

export interface PhrasePackParams {
  languageId: string;
  phonology: Phonology;
  phonotactics: PhonotacticSpec;
  lexicon: LexiconRepo;
  categories?: PhraseCategory[];
  seed: bigint | number;
  fallbackProfile: NameGeneratorProfile;
}

interface PhraseTemplate {
  category: PhraseCategory;
  concept: string;
  slots: string[];
  register: PhraseRegister;
  contextNote?: string;
}

/* ─────────────────────  Templates  ───────────────────── */

export const PHRASE_TEMPLATES: PhraseTemplate[] = [
  // greetings (5)
  { category: 'greeting', concept: 'hello-formal',     slots: ['greet', 'sir'],         register: 'formal',  contextNote: 'used in first encounters' },
  { category: 'greeting', concept: 'hello-casual',     slots: ['greet'],                register: 'neutral' },
  { category: 'greeting', concept: 'good-morning',     slots: ['good', 'morning'],      register: 'neutral' },
  { category: 'greeting', concept: 'good-evening',     slots: ['good', 'evening'],      register: 'neutral' },
  { category: 'greeting', concept: 'group-greeting',   slots: ['greet', 'you-plural'],  register: 'neutral', contextNote: 'addressing a group' },

  // farewells (3)
  { category: 'farewell', concept: 'goodbye',          slots: ['farewell'],             register: 'neutral' },
  { category: 'farewell', concept: 'see-you-later',    slots: ['see', 'you', 'later'],  register: 'neutral' },
  { category: 'farewell', concept: 'good-night',       slots: ['good', 'night'],        register: 'neutral' },

  // yes/no/maybe (3)
  { category: 'yesno',    concept: 'yes',              slots: ['yes'],                  register: 'neutral' },
  { category: 'yesno',    concept: 'no',               slots: ['no'],                   register: 'neutral' },
  { category: 'yesno',    concept: 'maybe',            slots: ['maybe'],                register: 'neutral' },

  // numbers 1–10 (10)
  { category: 'numbers',  concept: 'one',              slots: ['one'],                  register: 'neutral' },
  { category: 'numbers',  concept: 'two',              slots: ['two'],                  register: 'neutral' },
  { category: 'numbers',  concept: 'three',            slots: ['three'],                register: 'neutral' },
  { category: 'numbers',  concept: 'four',             slots: ['four'],                 register: 'neutral' },
  { category: 'numbers',  concept: 'five',             slots: ['five'],                 register: 'neutral' },
  { category: 'numbers',  concept: 'six',              slots: ['six'],                  register: 'neutral' },
  { category: 'numbers',  concept: 'seven',            slots: ['seven'],                register: 'neutral' },
  { category: 'numbers',  concept: 'eight',            slots: ['eight'],                register: 'neutral' },
  { category: 'numbers',  concept: 'nine',             slots: ['nine'],                 register: 'neutral' },
  { category: 'numbers',  concept: 'ten',              slots: ['ten'],                  register: 'neutral' },

  // days of the week (7)
  { category: 'days',     concept: 'day-1',            slots: ['day', 'first'],         register: 'neutral', contextNote: 'first day of week' },
  { category: 'days',     concept: 'day-2',            slots: ['day', 'second'],        register: 'neutral' },
  { category: 'days',     concept: 'day-3',            slots: ['day', 'third'],         register: 'neutral' },
  { category: 'days',     concept: 'day-4',            slots: ['day', 'fourth'],        register: 'neutral' },
  { category: 'days',     concept: 'day-5',            slots: ['day', 'fifth'],         register: 'neutral' },
  { category: 'days',     concept: 'day-6',            slots: ['day', 'sixth'],         register: 'neutral' },
  { category: 'days',     concept: 'day-7',            slots: ['day', 'seventh'],       register: 'neutral' },

  // kin (7)
  { category: 'kin',      concept: 'mother',           slots: ['mother'],               register: 'neutral' },
  { category: 'kin',      concept: 'father',           slots: ['father'],               register: 'neutral' },
  { category: 'kin',      concept: 'brother',          slots: ['brother'],              register: 'neutral' },
  { category: 'kin',      concept: 'sister',           slots: ['sister'],               register: 'neutral' },
  { category: 'kin',      concept: 'child',            slots: ['child'],                register: 'neutral' },
  { category: 'kin',      concept: 'elder',            slots: ['elder'],                register: 'formal',  contextNote: 'respectful address for elders' },
  { category: 'kin',      concept: 'friend',           slots: ['friend'],               register: 'neutral' },

  // directions (6)
  { category: 'directions', concept: 'north',          slots: ['north'],                register: 'neutral' },
  { category: 'directions', concept: 'south',          slots: ['south'],                register: 'neutral' },
  { category: 'directions', concept: 'east',           slots: ['east'],                 register: 'neutral' },
  { category: 'directions', concept: 'west',           slots: ['west'],                 register: 'neutral' },
  { category: 'directions', concept: 'here',           slots: ['here'],                 register: 'neutral' },
  { category: 'directions', concept: 'there',          slots: ['there'],                register: 'neutral' },

  // politeness (5)
  { category: 'politeness', concept: 'please',         slots: ['please'],               register: 'formal' },
  { category: 'politeness', concept: 'thank-you',      slots: ['thank', 'you'],         register: 'neutral' },
  { category: 'politeness', concept: 'sorry',          slots: ['sorry'],                register: 'neutral' },
  { category: 'politeness', concept: 'excuse-me',      slots: ['excuse', 'me'],         register: 'formal' },
  { category: 'politeness', concept: 'youre-welcome',  slots: ['you', 'welcome'],       register: 'neutral' },

  // questions (4)
  { category: 'questions',  concept: 'where',          slots: ['where'],                register: 'neutral' },
  { category: 'questions',  concept: 'when',           slots: ['when'],                 register: 'neutral' },
  { category: 'questions',  concept: 'how-much',       slots: ['how', 'much'],          register: 'neutral' },
  { category: 'questions',  concept: 'why',            slots: ['why'],                  register: 'neutral' },
];

/* ─────────────────────  POS tagging  ───────────────────── */

const PARTICLES = new Set(['yes', 'no', 'the', 'here', 'there', 'maybe']);
const INTERJECTIONS = new Set(['greet', 'farewell', 'please', 'sorry', 'thank']);
const NUMERALS = new Set([
  'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
  'first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh',
]);
const PRONOUNS = new Set(['you', 'me', 'you-plural']);
const ADJECTIVES = new Set(['good', 'much', 'later', 'welcome']);
const ADVERBS = new Set(['where', 'when', 'why', 'how']);
const VERBS = new Set(['see', 'excuse']);

function posFor(slot: string): PartOfSpeech {
  if (NUMERALS.has(slot)) return 'numeral';
  if (PARTICLES.has(slot)) return 'particle';
  if (INTERJECTIONS.has(slot)) return 'interjection';
  if (PRONOUNS.has(slot)) return 'pronoun';
  if (ADJECTIVES.has(slot)) return 'adjective';
  if (ADVERBS.has(slot)) return 'adverb';
  if (VERBS.has(slot)) return 'verb';
  return 'noun';
}

/* ─────────────────────  Generation  ───────────────────── */

function syllableCountFor(slot: string, seed: bigint): number {
  // Numerals stay short (1–2 syll). Function words 1 syll. Content 2 syll.
  if (PARTICLES.has(slot) || PRONOUNS.has(slot)) return 1;
  if (NUMERALS.has(slot)) return 1 + Number(BigInt(seed) & 1n);
  return 2;
}

async function ensureLemma(
  p: PhrasePackParams,
  slot: string,
): Promise<Lexeme> {
  const existing = await p.lexicon.get(p.languageId, slot);
  if (existing) return existing;

  const pos = posFor(slot);
  const slotSeed = deriveSeed(BigInt(p.seed), p.languageId, 'phrase', slot);
  const lemma = generatePhonotacticName({
    phonology: p.phonology,
    phonotactics: p.phonotactics,
    profile: p.fallbackProfile,
    syllableCount: syllableCountFor(slot, slotSeed),
    seed: slotSeed,
    category: pos === 'verb' ? 'concept' : 'object',
    instance: slot,
  });
  const entry: Lexeme = { lemma, ipa: lemma, gloss: slot, pos };
  await p.lexicon.set(p.languageId, slot, entry);
  return entry;
}

export async function buildPhrasePack(p: PhrasePackParams): Promise<PhraseEntry[]> {
  if (!p.phonology.phonemes || p.phonology.phonemes.length === 0) {
    throw new Error('hayba: buildPhrasePack — empty phoneme inventory; add phonemes before generating a phrase pack.');
  }
  const want: Set<PhraseCategory> | null = p.categories && p.categories.length
    ? new Set(p.categories)
    : null;

  const out: PhraseEntry[] = [];
  for (const tpl of PHRASE_TEMPLATES) {
    if (want && !want.has(tpl.category)) continue;
    const tokens: PhraseToken[] = [];
    for (const slot of tpl.slots) {
      const lex = await ensureLemma(p, slot);
      tokens.push({ source: slot, lemma: lex.lemma, ipa: lex.ipa });
    }
    out.push({
      concept: tpl.concept,
      category: tpl.category,
      register: tpl.register,
      contextNote: tpl.contextNote,
      tokens,
      phrase: tokens.map(t => t.lemma).join(' '),
    });
  }
  return out;
}

/** Convenience: every distinct concept-slot referenced by the templates. */
export function allPhraseSlots(): string[] {
  const s = new Set<string>();
  for (const t of PHRASE_TEMPLATES) for (const slot of t.slots) s.add(slot);
  return [...s];
}
