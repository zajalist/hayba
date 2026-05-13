/**
 * L7 — AI-augmented derivation.
 *
 * Pure scaffold: takes a `DerivationLLM` (any function returning a candidate
 * word + gloss/etymology), runs validate-and-retry against the language's
 * phonotactic spec, and falls back to the L4 phonotactic name generator if
 * the LLM repeatedly emits invalid words.
 *
 * No SDK dependency — host code provides the LLM adapter (Anthropic, local
 * `outlines`, mock, …). This keeps the linguistics package SDK-free and the
 * deterministic fallback always available.
 */

import type { Phonology } from './phonology.js';
import type { PhonotacticSpec } from './phonotactics.js';
import { passesPhonotactics } from './phonotactics.js';
import type { Lexeme } from './lexicon.js';
import type { NameCategory, NameGeneratorProfile } from './name-generator.js';
import { generatePhonotacticName } from './name-generator.js';

export interface DerivationRequest {
  phonology: Phonology;
  phonotactics: PhonotacticSpec;
  /** Used by the deterministic fallback when the LLM gives up. */
  fallbackProfile: NameGeneratorProfile;
  category?: NameCategory;
  /** What the new lexeme should mean. */
  gloss: string;
  /** Optional root form to derive from (e.g. a noun → verb derivation). */
  rootLemma?: string;
  /** What kind of derivation — diminutive, agent noun, abstract, etc. */
  derivationKind?: string;
  seed: number | bigint;
  maxRetries?: number;
}

export interface DerivationCandidate {
  lemma: string;
  ipa?: string;
  etymology?: string;
  register?: Lexeme['register'];
}

export type DerivationLLM = (
  attempt: number,
  feedback: string | null,
  req: DerivationRequest,
) => Promise<DerivationCandidate>;

export interface DerivationResult {
  lexeme: Lexeme;
  /** Which path produced the entry. */
  source: 'llm' | 'fallback';
  attempts: number;
  /** Validation errors collected from rejected LLM emissions. */
  history: string[];
}

export async function proposeDerivation(
  req: DerivationRequest,
  llm?: DerivationLLM,
): Promise<DerivationResult> {
  const maxRetries = req.maxRetries ?? 3;
  const history: string[] = [];

  if (llm) {
    let feedback: string | null = null;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      const cand = await llm(attempt, feedback, req);
      const check = passesPhonotactics(cand.lemma, req.phonology, req.phonotactics);
      if (check) {
        return {
          lexeme: {
            lemma: cand.lemma,
            ipa: cand.ipa ?? cand.lemma,
            gloss: req.gloss,
            etymology: cand.etymology,
            register: cand.register,
          },
          source: 'llm',
          attempts: attempt,
          history,
        };
      }
      feedback = `'${cand.lemma}' fails phonotactics for language '${req.phonology.languageId}'`;
      history.push(feedback);
    }
  }

  const lemma = generatePhonotacticName({
    phonology: req.phonology,
    phonotactics: req.phonotactics,
    profile: req.fallbackProfile,
    category: req.category,
    syllableCount: 2,
    seed: req.seed,
    instance: req.gloss,
  });
  return {
    lexeme: { lemma, ipa: lemma, gloss: req.gloss },
    source: 'fallback',
    attempts: (llm ? maxRetries : 0) + 1,
    history,
  };
}
