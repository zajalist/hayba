/**
 * L4 — Phonotactic name generator.
 *
 * Deterministic: same `(seed, lang_id, category, instance)` → identical word
 * forever. Uses the SplitMix64 stream from `rng.ts` for reproducibility across
 * runs / arches. Generation is rejection-sampled against the language's
 * phonotactic spec (L2).
 */

import type { Phonology } from './phonology.js';
import { passesPhonotactics } from './phonotactics.js';
import type { PhonotacticSpec } from './phonotactics.js';
import { SplitMix64, deriveSeed } from './rng.js';

export type NameCategory = 'person' | 'place' | 'faction' | 'object' | 'concept';

export interface NameGeneratorProfile {
  syllableTemplate: 'CV' | 'CVC' | 'CCV' | 'CVN';
  vowels: string[];
  onsetPool: string[];
  /** Used as final consonant in CVC/CVN; falls back to onsetPool when empty. */
  codaPool?: string[];
  /** Optional nasal pool for CVN. */
  nasalPool?: string[];
}

export interface GenerateNameParams {
  phonology: Phonology;
  phonotactics: PhonotacticSpec;
  profile: NameGeneratorProfile;
  category?: NameCategory;
  syllableCount: number;
  seed: number | bigint;
  /** Optional extra scope tag for sub-stream derivation (e.g. an entity id). */
  instance?: string;
}

function buildSyllable(profile: NameGeneratorProfile, rng: SplitMix64): string {
  const onset = rng.pick(profile.onsetPool);
  const v = rng.pick(profile.vowels);
  switch (profile.syllableTemplate) {
    case 'CV': return onset + v;
    case 'CCV': return onset + rng.pick(profile.onsetPool) + v;
    case 'CVC': return onset + v + rng.pick(profile.codaPool?.length ? profile.codaPool : profile.onsetPool);
    case 'CVN': return onset + v + rng.pick(profile.nasalPool?.length ?? 0 ? profile.nasalPool! : profile.codaPool?.length ? profile.codaPool : profile.onsetPool);
  }
}

export function generatePhonotacticName(p: GenerateNameParams): string {
  const scope: string[] = [
    p.phonology.languageId,
    p.category ?? 'unknown',
  ];
  if (p.instance) scope.push(p.instance);
  const base = deriveSeed(p.seed, ...scope);

  for (let attempt = 0; attempt < 1000; attempt++) {
    const rng = new SplitMix64(base ^ BigInt(attempt) * 0x9E3779B97F4A7C15n);
    let word = '';
    for (let s = 0; s < p.syllableCount; s++) word += buildSyllable(p.profile, rng);
    if (passesPhonotactics(word, p.phonology, p.phonotactics)) return word;
  }
  throw new Error('hayba: phonotactic name generator exhausted 1000 attempts — widen onset/vowel pools or relax templates');
}
