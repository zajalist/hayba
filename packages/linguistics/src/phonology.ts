/**
 * L1 — Phonology engine.
 *
 * A Phonology is a per-language phoneme inventory. Each Phoneme has a stable
 * `id` (used for cross-references in lexicon, sound-change rules, etc.) and an
 * `ipa` surface form (used for display + greedy tokenization of written forms).
 *
 * Features are an open-ended `{ key: value }` bundle. Conventional keys:
 *   consonants: place, manner, voicing
 *   vowels:     height, backness, roundness
 *   supraseg.:  tone, stress, length
 * Callers are free to extend with additional keys per language.
 */

export type FeatureBundle = Readonly<Record<string, string>>;

export interface Phoneme {
  /** Stable identifier, unique within a Phonology. Used for cross-references. */
  id: string;
  /** IPA (or romanised) surface form. Used for greedy tokenization. */
  ipa: string;
  features: FeatureBundle;
}

export interface Phonology {
  languageId: string;
  phonemes: Phoneme[];
}

/** Sort phoneme IPA strings longest-first so digraphs win in greedy match. */
export function sortedPhonemeSymbols(phonology: Phonology): string[] {
  return phonology.phonemes
    .map(p => p.ipa)
    .sort((a, b) => b.length - a.length || (a < b ? -1 : a > b ? 1 : 0));
}

/** Segment a written word into phoneme IPA tokens (greedy longest match). */
export function tokenize(word: string, phonology: Phonology): string[] | null {
  const syms = sortedPhonemeSymbols(phonology);
  const src = word.normalize('NFC');
  const out: string[] = [];
  let i = 0;
  while (i < src.length) {
    let hit: string | undefined;
    for (const s of syms) {
      if (s.length > 0 && src.startsWith(s, i)) {
        hit = s;
        break;
      }
    }
    if (!hit) return null;
    out.push(hit);
    i += hit.length;
  }
  return out;
}

/** Look up a phoneme by id; throws if missing (call site treats as invariant). */
export function getPhonemeById(phonology: Phonology, id: string): Phoneme {
  const hit = phonology.phonemes.find(p => p.id === id);
  if (!hit) throw new Error(`hayba: phoneme '${id}' not in phonology '${phonology.languageId}'`);
  return hit;
}

/** Look up by surface IPA; first match wins (use ids for guaranteed uniqueness). */
export function findPhonemeByIpa(phonology: Phonology, ipa: string): Phoneme | undefined {
  return phonology.phonemes.find(p => p.ipa === ipa);
}

/** Phonemes matching every (key, value) in the supplied feature query. */
export function phonemesWithFeatures(phonology: Phonology, query: FeatureBundle): Phoneme[] {
  const entries = Object.entries(query);
  return phonology.phonemes.filter(p => entries.every(([k, v]) => p.features[k] === v));
}

/** Convenience: anything carrying a non-zero vowel-axis feature (height/backness). */
export function vowels(phonology: Phonology): Phoneme[] {
  return phonology.phonemes.filter(p => 'height' in p.features || 'backness' in p.features);
}

export function consonants(phonology: Phonology): Phoneme[] {
  return phonology.phonemes.filter(p => 'manner' in p.features || 'place' in p.features);
}

/**
 * Structural validation of a phonology. Returns the list of problems; an empty
 * array means the inventory is well-formed.
 */
export function validatePhonology(phonology: Phonology): string[] {
  const problems: string[] = [];
  if (!phonology.languageId) problems.push('languageId is empty');
  if (phonology.phonemes.length === 0) problems.push('inventory is empty');
  const ids = new Set<string>();
  for (const p of phonology.phonemes) {
    if (!p.id) problems.push(`phoneme with ipa '${p.ipa}' has empty id`);
    if (!p.ipa) problems.push(`phoneme '${p.id}' has empty ipa`);
    if (ids.has(p.id)) problems.push(`duplicate phoneme id '${p.id}'`);
    ids.add(p.id);
  }
  return problems;
}
