import { z } from 'zod';
import {
  LexiconStore,
  generatePhonotacticName,
  type Lexeme,
  type NameGeneratorProfile,
  type Phonology,
  type PhonotacticSpec,
} from '@hayba/linguistics';

const phonemeSchema = z.object({
  symbol: z.string(),
  ipa: z.string(),
  features: z.array(z.string()),
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
  }),
});

export const definePhonologySchema = z.object({
  phonology: z.string().describe('JSON string of Phonology { languageId, phonemes[] }'),
  phonotactics: z.string().optional().describe('Optional JSON PhonotacticSpec'),
});

export const wordForSchema = z.object({
  language_id: z.string(),
  concept_id: z.string(),
  /** When absent and nothing stored yet, returns null unless define_lexeme provided */
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
  syllable_template: z.enum(['CV', 'CVC']),
  vowels: z.array(z.string()),
  onset_pool: z.array(z.string()),
  coda_pool: z.array(z.string()).optional(),
  category: z.enum(['person', 'place', 'faction']).optional(),
});

export const soundChangesSchema = z.object({
  rules_json: z.string().describe('Lexurgy-style rule stack JSON — engine lands in L5'),
});

export const proposeDerivationSchema = z.object({
  language_id: z.string(),
  proto_form: z.string(),
  target_gloss: z.string(),
});

export const remixPhonologiesSchema = z.object({
  language_ids: z.array(z.string()).min(2),
});

const langs = new Map<string, { phonology: Phonology; phonotactic?: PhonotacticSpec }>();
export const lexicon = new LexiconStore();

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
  return { ok: true as const, language_id: ph.languageId, phoneme_count: ph.phonemes.length };
}

export function languageWordFor(params: z.infer<typeof wordForSchema>) {
  let hit = lexicon.wordFor(params.language_id, params.concept_id);
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

export function languageApplySoundChanges(_params: z.infer<typeof soundChangesSchema>) {
  return {
    ok: false as const,
    message:
      'Deterministic sound-change engine + visual builder are tracked under linguistics L5; rule execution is not wired in this MCP release.',
  };
}

export function languageProposeDerivation(_params: z.infer<typeof proposeDerivationSchema>) {
  return {
    ok: false as const,
    message:
      'LLM-assisted derivation (linguistics L7) is pending constrained decoding hooks — use phonotactic validator client-side first.',
  };
}

export function languageRemixPhonologies(params: z.infer<typeof remixPhonologiesSchema>) {
  return {
    ok: false as const,
    language_ids: params.language_ids,
    message:
      'Language remixing / creole blending (linguistics L9) is not implemented yet — export phonologies via language_define_phonology + merge manually.',
  };
}
