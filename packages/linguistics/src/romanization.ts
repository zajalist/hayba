/**
 * Romanization — bidirectional IPA ↔ orthography mapping.
 *
 * A `RomanizationMap` is an ordered list of `(ipa → spelling)` entries. Order
 * matters: digraphs and other multi-segment IPA sequences must come before
 * their constituent single segments so greedy match prefers the longer one.
 *
 *   [['ʃ', 'sh'], ['ŋ', 'ng'], ['ʔ', "'"], ['ə', 'e'], ...]
 *
 * Pure functions; no globals.
 */

export type RomanizationRule = readonly [ipa: string, spelling: string];

export interface RomanizationMap {
  languageId: string;
  rules: RomanizationRule[];
}

/** Sort rules by IPA length descending so digraphs win during greedy match. */
function sortedRules(map: RomanizationMap): RomanizationRule[] {
  return [...map.rules].sort(([a], [b]) => b.length - a.length);
}

/** Apply the map to an IPA string, producing the romanized form. */
export function romanize(ipa: string, map: RomanizationMap): string {
  const rules = sortedRules(map);
  let out = '';
  let i = 0;
  const src = ipa.normalize('NFC');
  while (i < src.length) {
    let hit: RomanizationRule | undefined;
    for (const r of rules) {
      if (r[0].length > 0 && src.startsWith(r[0], i)) { hit = r; break; }
    }
    if (hit) { out += hit[1]; i += hit[0].length; }
    else     { out += src[i]; i++; }
  }
  return out;
}

/** Inverse map: spelling → IPA. Same greedy-longest-first semantics. */
export function deromanize(spelling: string, map: RomanizationMap): string {
  const inverse: RomanizationMap = {
    languageId: map.languageId,
    rules: map.rules.map(([a, b]) => [b, a] as const),
  };
  return romanize(spelling, inverse);
}

/**
 * Build a sensible default romanization for a phoneme inventory. Each phoneme
 * maps to itself unless it's a non-ASCII IPA symbol with a conventional Latin
 * approximation (ʃ→sh, ʒ→zh, ŋ→ng, θ→th, ɣ→gh, χ→kh, etc.).
 */
const DEFAULT_LATINIZATION: Record<string, string> = {
  ʃ: 'sh', ʒ: 'zh', ŋ: 'ng', θ: 'th', ð: 'dh',
  ɣ: 'gh', χ: 'kh', ʁ: 'r', ʔ: "'", ħ: 'hh', ʕ: '`',
  ɲ: 'ny', ʎ: 'ly', ɫ: 'll',
  ɸ: 'ph', β: 'bh', ç: 'ch', ʝ: 'jh',
  ɕ: 'sj', ʑ: 'zj',
  ʈ: 'tt', ɖ: 'dd', ɳ: 'nn', ɭ: 'll', ɽ: 'rr', ʂ: 'ss', ʐ: 'zz',
  ʈʼ: "tt'", cʼ: "c'", kʼ: "k'", qʼ: "q'", pʼ: "p'", tʼ: "t'", sʼ: "s'",
  ɓ: 'b', ɗ: 'd', ʄ: 'j', ɠ: 'g', ʛ: 'gh',
  ə: 'e', ɛ: 'e', ɔ: 'o', ɪ: 'i', ʊ: 'u', ɑ: 'a', ɒ: 'a',
  æ: 'ae', œ: 'oe', ø: 'oe', y: 'y', ʉ: 'u', ɨ: 'i', ɯ: 'u',
  ɤ: 'o', ɵ: 'o', ɘ: 'e', ɜ: 'e', ɞ: 'oe', ʌ: 'u', ɐ: 'a', ʏ: 'y',
};

export function defaultRomanization(languageId: string, ipaSymbols: string[]): RomanizationMap {
  // Longer IPA tokens first so digraph mappings win their conventional spelling.
  const sorted = [...ipaSymbols].sort((a, b) => b.length - a.length);
  const rules: RomanizationRule[] = sorted.map(ipa => {
    const spelling = DEFAULT_LATINIZATION[ipa] ?? ipa;
    return [ipa, spelling] as const;
  });
  return { languageId, rules };
}
