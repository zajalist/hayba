import { z } from 'zod';
import {
  InMemoryLexicon,
  generatePhonotacticName,
  parseRules,
  evolveLexicon,
  proposeDerivation,
  buildCoOccurrenceModel,
  passesPhonotactics,
  type Lexeme,
  type NameGeneratorProfile,
  type Phonology,
  type PhonotacticSpec,
  type SoundChangeRule,
} from '@hayba/linguistics';

/* ─────────────────────  schemas  ───────────────────── */

const phonemeSchema = z.object({
  id: z.string(),
  ipa: z.string(),
  features: z.record(z.string(), z.string()),
});

const phonologySchema = z.object({
  languageId: z.string(),
  phonemes: z.array(phonemeSchema),
});

const phonotacticSchema = z.object({
  phonologyId: z.string(),
  vowels: z.array(z.string()),
  syllable: z.object({
    templates: z.array(z.string()),
    onsetClusters: z.array(z.string()).optional(),
    codaClusters: z.array(z.string()).optional(),
    boundaryClusters: z.array(z.string()).optional(),
  }),
  slotClasses: z.record(z.string(), z.array(z.string())).optional(),
});

export const definePhonologySchema = z.object({
  phonology: z.string().describe('JSON string of Phonology { languageId, phonemes[] }'),
  phonotactics: z.string().optional().describe('Optional JSON PhonotacticSpec'),
});

export const wordForSchema = z.object({
  language_id: z.string(),
  concept_id: z.string(),
  define_lexeme: z
    .object({
      lemma: z.string(),
      ipa: z.string(),
      gloss: z.string(),
      register: z.enum(['neutral', 'formal', 'slang', 'poetic']).optional(),
      etymology: z.string().optional(),
    })
    .optional(),
});

export const generateNameSchema = z.object({
  language_id: z.string(),
  seed: z.number().int(),
  syllable_count: z.number().int().min(1).max(8),
  syllable_template: z.enum(['CV', 'CVC', 'CCV', 'CVN']),
  vowels: z.array(z.string()),
  onset_pool: z.array(z.string()),
  coda_pool: z.array(z.string()).optional(),
  nasal_pool: z.array(z.string()).optional(),
  category: z.enum(['person', 'place', 'faction', 'object', 'concept']).optional(),
});

export const soundChangesSchema = z.object({
  language_id: z.string(),
  rules_text: z.string().describe('One rule per line, e.g. "p > b / V _ V"'),
});

export const proposeDerivationSchema = z.object({
  language_id: z.string(),
  gloss: z.string(),
  derivation_kind: z.string().optional(),
  root_lemma: z.string().optional(),
  seed: z.number().int(),
});

export const remixPhonologiesSchema = z.object({
  language_ids: z.array(z.string()).min(2),
});

/* ─────────────────────  state  ───────────────────── */

interface LanguageRecord {
  phonology: Phonology;
  phonotactic?: PhonotacticSpec;
}

const langs = new Map<string, LanguageRecord>();
export const lexicon = new InMemoryLexicon();

const coOccurrence = buildCoOccurrenceModel();

/* ─────────────────────  handlers  ───────────────────── */

export function definePhonology(params: z.infer<typeof definePhonologySchema>) {
  const ph = phonologySchema.parse(JSON.parse(params.phonology));
  let phonotactic: PhonotacticSpec | undefined;
  if (params.phonotactics) {
    phonotactic = phonotacticSchema.parse(JSON.parse(params.phonotactics));
    if (phonotactic.phonologyId !== ph.languageId) {
      throw new Error('phonotactics.phonologyId must equal phonology.languageId');
    }
  }
  langs.set(ph.languageId, { phonology: ph, phonotactic });
  // Co-occurrence summary helps the caller sanity-check the inventory.
  const summary = ph.phonemes.map(p => ({
    ipa: p.ipa,
    marginal: Number(coOccurrence.marginal(p.ipa).toFixed(3)),
  }));
  return {
    ok: true as const,
    language_id: ph.languageId,
    phoneme_count: ph.phonemes.length,
    cross_linguistic_summary: summary,
  };
}

export function languageWordFor(params: z.infer<typeof wordForSchema>) {
  let hit = lexicon.get(params.language_id, params.concept_id);
  if (!hit && params.define_lexeme) {
    const row: Lexeme = {
      lemma: params.define_lexeme.lemma,
      ipa: params.define_lexeme.ipa,
      gloss: params.define_lexeme.gloss,
      register: params.define_lexeme.register,
      etymology: params.define_lexeme.etymology,
    };
    lexicon.set(params.language_id, params.concept_id, row);
    hit = row;
  }
  return { lexeme: hit };
}

export function languageGenerateName(params: z.infer<typeof generateNameSchema>) {
  const cfg = langs.get(params.language_id);
  if (!cfg?.phonotactic) {
    throw new Error(`language "${params.language_id}" missing phonology + phonotactics — call language_define_phonology first`);
  }
  const profile: NameGeneratorProfile = {
    syllableTemplate: params.syllable_template,
    vowels: params.vowels,
    onsetPool: params.onset_pool,
    codaPool: params.coda_pool,
    nasalPool: params.nasal_pool,
  };
  const name = generatePhonotacticName({
    phonology: cfg.phonology,
    phonotactics: cfg.phonotactic,
    profile,
    syllableCount: params.syllable_count,
    seed: params.seed,
    category: params.category,
  });
  return { name };
}

export function languageApplySoundChanges(params: z.infer<typeof soundChangesSchema>) {
  const cfg = langs.get(params.language_id);
  if (!cfg) throw new Error(`language "${params.language_id}" not defined`);
  let rules: SoundChangeRule[];
  try {
    rules = parseRules(params.rules_text);
  } catch (e: unknown) {
    return { ok: false as const, message: e instanceof Error ? e.message : String(e) };
  }
  const entries = lexicon.all(params.language_id).map(({ concept, entry }) => ({
    concept, lemma: entry.lemma,
  }));
  const vset = new Set(cfg.phonotactic?.vowels ?? []);
  const classes: Record<string, Set<string>> = {
    V: vset,
    C: new Set(cfg.phonology.phonemes.map(p => p.ipa).filter(ipa => !vset.has(ipa))),
    nasal: new Set(cfg.phonology.phonemes.filter(p => p.features.manner === 'nasal').map(p => p.ipa)),
  };
  const evolved = evolveLexicon(entries, cfg.phonology, rules, classes);
  return { ok: true as const, evolved };
}

export async function languageProposeDerivation(params: z.infer<typeof proposeDerivationSchema>) {
  const cfg = langs.get(params.language_id);
  if (!cfg?.phonotactic) {
    throw new Error(`language "${params.language_id}" missing phonology + phonotactics`);
  }
  const consonants = cfg.phonology.phonemes
    .filter(p => p.features.manner && p.features.manner !== 'plosive')
    .map(p => p.ipa);
  const vowels = cfg.phonotactic.vowels;
  const result = await proposeDerivation({
    phonology: cfg.phonology,
    phonotactics: cfg.phonotactic,
    fallbackProfile: {
      syllableTemplate: 'CV',
      vowels,
      onsetPool: consonants.length ? consonants : cfg.phonology.phonemes.map(p => p.ipa),
    },
    gloss: params.gloss,
    derivationKind: params.derivation_kind,
    rootLemma: params.root_lemma,
    seed: params.seed,
  });
  lexicon.set(params.language_id, params.gloss, result.lexeme);
  return { ok: true as const, ...result };
}

export function languageRemixPhonologies(params: z.infer<typeof remixPhonologiesSchema>) {
  // M3 feature — collect the union of all phonemes, intersect cluster rules.
  const found = params.language_ids.map(id => langs.get(id)).filter(Boolean) as LanguageRecord[];
  if (found.length !== params.language_ids.length) {
    return { ok: false as const, message: 'one or more languages not defined' };
  }
  const merged = new Map<string, Phonology['phonemes'][number]>();
  for (const r of found) for (const p of r.phonology.phonemes) merged.set(p.id, p);
  // Probability-weighted survival: only keep phonemes plausibly co-occurring
  // with the most-common phoneme of the first language (anchor harmony).
  const anchor = found[0]?.phonology.phonemes[0]?.ipa;
  const phonemes = [...merged.values()].filter(p =>
    !anchor || p.ipa === anchor || coOccurrence.pGivenPresent(p.ipa, anchor) > 0.2);
  return {
    ok: true as const,
    creole: {
      languageId: params.language_ids.join('+'),
      phonemes,
    },
  };
}

// Stay used so dead-code passes don't strip them when this file is split later.
void passesPhonotactics;
