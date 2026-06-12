/**
 * L10 — Translator.
 *
 * Concept-by-concept English → conlang translator. Each input word maps to
 * a "concept" (the lexicon's canonical key); known concepts come straight
 * from the lexicon, unknowns are deterministically generated via L4 and
 * persisted so the next call returns the same word.
 *
 * Pure function over `(masterSeed, langId, text)` — same input → same
 * translation forever.
 */

import type { Phonology } from './phonology.js';
import type { PhonotacticSpec } from './phonotactics.js';
import type { Lexeme, LexiconRepo, PartOfSpeech } from './lexicon.js';
import type { NameGeneratorProfile } from './name-generator.js';
import { generatePhonotacticName } from './name-generator.js';
import { deriveSeed } from './rng.js';
import { romanize } from './romanization.js';
import type { RomanizationMap } from './romanization.js';

export interface TranslatedToken {
  /** Original word as it appeared in the input. */
  source: string;
  /** Canonical concept key looked up in the lexicon (lowercased, normalised). */
  concept: string;
  /** Surface form in the conlang's phonology. Absent for non-word tokens. */
  lemma?: string;
  ipa?: string;
  romanized?: string;
  pos?: PartOfSpeech | string;
  /** True when the lemma was generated on the fly because the lexicon had no entry. */
  generated: boolean;
  /** Whitespace / punctuation tokens pass through unchanged. */
  kind: 'word' | 'punct' | 'space';
}

export interface TranslatedSentence {
  source: string;
  tokens: TranslatedToken[];
  /** Token concepts that were newly generated this call. */
  generated: string[];
}

export interface TranslatorContext {
  languageId: string;
  phonology: Phonology;
  phonotactics: PhonotacticSpec;
  lexicon: LexiconRepo;
  /** Used for the deterministic fallback when a word isn't in the lexicon. */
  fallbackProfile: NameGeneratorProfile;
  romanization?: RomanizationMap;
  /** Optional master seed scoped to the language. */
  seed?: number | bigint;
}

/* ─────────────────────  Tokenisation  ───────────────────── */

const WORD_RE = /[\p{L}\p{M}'’\-]+/u;

export interface RawToken {
  text: string;
  kind: 'word' | 'punct' | 'space';
}

export function tokenize(text: string): RawToken[] {
  const out: RawToken[] = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (/\s/.test(ch)) {
      const start = i;
      while (i < text.length && /\s/.test(text[i]!)) i++;
      out.push({ text: text.slice(start, i), kind: 'space' });
      continue;
    }
    const wordMatch = text.slice(i).match(new RegExp('^' + WORD_RE.source, 'u'));
    if (wordMatch && wordMatch[0].length > 0) {
      out.push({ text: wordMatch[0], kind: 'word' });
      i += wordMatch[0].length;
      continue;
    }
    out.push({ text: ch, kind: 'punct' });
    i++;
  }
  return out;
}

/* ─────────────────────  Lemmatisation  ───────────────────── */

/**
 * Map a surface English form to its canonical lexicon key. This is a
 * deliberately simple heuristic — production systems would use a real
 * lemmatiser (WordNet, spaCy, etc.). The goal here is "good enough" so the
 * Translator demo doesn't insist on perfect citation forms.
 *
 * The returned tuple is `[concept, posHint]`. `posHint` is only used when
 * generating a new lemma — never overrides a lexicon entry.
 */
export function lemmatize(word: string): { concept: string; posHint?: PartOfSpeech } {
  const lc = word.toLowerCase().replace(/[’]/g, "'");
  if (lc === '') return { concept: lc };

  // High-confidence inflectional strips. Order matters: longer first.
  if (lc.endsWith('ies') && lc.length > 4) return { concept: lc.slice(0, -3) + 'y', posHint: 'noun' };
  if (lc.endsWith('sses')) return { concept: lc.slice(0, -2), posHint: 'noun' };
  if (lc.endsWith('xes') || lc.endsWith('shes') || lc.endsWith('ches')) return { concept: lc.slice(0, -2), posHint: 'noun' };
  if (lc.endsWith('ed') && lc.length > 3) return { concept: 'to-' + lc.slice(0, -2), posHint: 'verb' };
  if (lc.endsWith('ing') && lc.length > 4) return { concept: 'to-' + lc.slice(0, -3), posHint: 'verb' };
  if (lc.endsWith('ly') && lc.length > 3) return { concept: lc.slice(0, -2), posHint: 'adverb' };
  if (lc.endsWith('s') && lc.length > 2 && !lc.endsWith('ss') && !lc.endsWith('us') && !lc.endsWith('is')) {
    return { concept: lc.slice(0, -1), posHint: 'noun' };
  }
  return { concept: lc };
}

/* ─────────────────────  Translation  ───────────────────── */

/**
 * Generate a deterministic lemma for an unknown concept. Same
 * (masterSeed, languageId, concept) → same lemma forever.
 */
async function generateLemmaFor(
  ctx: TranslatorContext,
  concept: string,
  posHint?: PartOfSpeech,
): Promise<Lexeme> {
  const seed = ctx.seed ?? 0n;
  const lemma = generatePhonotacticName({
    phonology: ctx.phonology,
    phonotactics: ctx.phonotactics,
    profile: ctx.fallbackProfile,
    syllableCount: posHint === 'verb' ? 2 : 2 + Number(BigInt(deriveSeed(seed, concept, 'len')) & 1n),
    seed: deriveSeed(seed, ctx.languageId, concept),
    category: posHint === 'verb' ? 'concept' : 'object',
    instance: concept,
  });
  return { lemma, ipa: lemma, gloss: concept, pos: posHint };
}

export async function translate(
  text: string,
  ctx: TranslatorContext,
): Promise<TranslatedSentence> {
  const raw = tokenize(text);
  const out: TranslatedToken[] = [];
  const generated: string[] = [];

  for (const r of raw) {
    if (r.kind !== 'word') {
      out.push({ source: r.text, concept: r.text, generated: false, kind: r.kind });
      continue;
    }
    const { concept, posHint } = lemmatize(r.text);
    let hit = await ctx.lexicon.get(ctx.languageId, concept);
    let wasGenerated = false;
    if (!hit) {
      const fresh = await generateLemmaFor(ctx, concept, posHint);
      await ctx.lexicon.set(ctx.languageId, concept, fresh);
      hit = fresh;
      wasGenerated = true;
      generated.push(concept);
    }
    out.push({
      source: r.text,
      concept,
      lemma: hit.lemma,
      ipa: hit.ipa,
      pos: hit.pos,
      romanized: ctx.romanization?.rules.length
        ? romanize(hit.lemma, ctx.romanization)
        : undefined,
      generated: wasGenerated,
      kind: 'word',
    });
  }

  return { source: text, tokens: out, generated };
}

/** Render a translated sentence as a plain string (lemmas joined, punctuation preserved). */
export function renderTranslation(sentence: TranslatedSentence): string {
  return sentence.tokens.map(t => t.kind === 'word' ? (t.lemma ?? t.source) : t.source).join('');
}

/** Render as romanized text (falls back to the IPA lemma when no romanization map). */
export function renderRomanized(sentence: TranslatedSentence): string {
  return sentence.tokens.map(t => t.kind === 'word' ? (t.romanized ?? t.lemma ?? t.source) : t.source).join('');
}
