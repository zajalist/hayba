/**
 * L21 — Lexicon statistics.
 *
 * Pure aggregation pass over a lexicon: phoneme frequencies, syllable-shape
 * distribution (as raw C/V strings), word-length histogram, POS / register
 * breakdowns, and the headline ratios (avg word length, C:V ratio). Tokenises
 * each lemma against the active phonology; lemmas the inventory can't parse
 * are silently skipped (but still counted in `unparseable`).
 */

import type { Phonology } from './phonology.js';
import { tokenize } from './phonology.js';
import type { PhonotacticSpec } from './phonotactics.js';

export interface LexiconStatistics {
  wordCount: number;
  /** Lemmas that tokenized successfully (i.e. contributed to phoneme/shape stats). */
  parsedCount: number;
  /** Lemmas whose surface form contains symbols outside the inventory. */
  unparseable: number;
  phonemeFrequency: Map<string, number>;
  syllableShapeDistribution: Map<string, number>;
  wordLengthHistogram: Map<number, number>;
  posBreakdown: Map<string, number>;
  registerBreakdown: Map<string, number>;
  avgWordLength: number;
  consonantVowelRatio: number;
  /** Sample lemmas containing each phoneme (up to 3) — drives hover tooltips. */
  phonemeExamples: Map<string, string[]>;
}

export interface StatsLexEntry {
  lemma: string;
  pos?: string;
  register?: string;
}

export function computeLexiconStatistics(
  lexicon: readonly StatsLexEntry[],
  phonology: Phonology,
  phonotactics: PhonotacticSpec,
): LexiconStatistics {
  const vset = new Set(phonotactics.vowels);
  const phonemeFrequency = new Map<string, number>();
  const syllableShapeDistribution = new Map<string, number>();
  const wordLengthHistogram = new Map<number, number>();
  const posBreakdown = new Map<string, number>();
  const registerBreakdown = new Map<string, number>();
  const phonemeExamples = new Map<string, string[]>();

  let totalC = 0;
  let totalV = 0;
  let totalPhonemes = 0;
  let parsedCount = 0;
  let unparseable = 0;

  for (const entry of lexicon) {
    // POS / register breakdowns apply to every lemma, parseable or not.
    const pos = entry.pos && entry.pos.length > 0 ? entry.pos : 'untagged';
    posBreakdown.set(pos, (posBreakdown.get(pos) ?? 0) + 1);
    const reg = entry.register && entry.register.length > 0 ? entry.register : 'untagged';
    registerBreakdown.set(reg, (registerBreakdown.get(reg) ?? 0) + 1);

    const tokens = tokenize(entry.lemma, phonology);
    if (!tokens) {
      unparseable++;
      continue;
    }
    parsedCount++;

    // Word-length histogram (phonemes per word)
    const len = tokens.length;
    wordLengthHistogram.set(len, (wordLengthHistogram.get(len) ?? 0) + 1);

    // Per-phoneme frequency + sample lemmas
    let shape = '';
    for (const t of tokens) {
      phonemeFrequency.set(t, (phonemeFrequency.get(t) ?? 0) + 1);
      const ex = phonemeExamples.get(t) ?? [];
      if (ex.length < 3 && !ex.includes(entry.lemma)) {
        ex.push(entry.lemma);
        phonemeExamples.set(t, ex);
      }
      if (vset.has(t)) { shape += 'V'; totalV++; }
      else { shape += 'C'; totalC++; }
      totalPhonemes++;
    }
    if (shape.length > 0) {
      syllableShapeDistribution.set(shape, (syllableShapeDistribution.get(shape) ?? 0) + 1);
    }
  }

  const wordCount = lexicon.length;
  const avgWordLength = parsedCount === 0 ? 0 : totalPhonemes / parsedCount;
  const consonantVowelRatio = totalV === 0 ? 0 : totalC / totalV;

  return {
    wordCount,
    parsedCount,
    unparseable,
    phonemeFrequency,
    syllableShapeDistribution,
    wordLengthHistogram,
    posBreakdown,
    registerBreakdown,
    avgWordLength,
    consonantVowelRatio,
    phonemeExamples,
  };
}
