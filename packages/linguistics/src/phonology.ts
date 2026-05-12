/** Feature bundles are open-ended strings — callers define inventories per language. */

export interface Phoneme {
  symbol: string;
  /** IPA or custom; primary display key */
  ipa: string;
  /** e.g. "+voice", "+high", "-rounded" */
  features: string[];
}

export interface Phonology {
  languageId: string;
  phonemes: Phoneme[];
}

/** Sort phoneme symbols longest-first for greedy tokenization. */
export function sortedPhonemeSymbols(phonology: Phonology): string[] {
  return [...phonology.phonemes].map(p => p.symbol).sort((a, b) => b.length - a.length);
}

/** Segment a word into phoneme symbols from inventory (greedy longest match). */
export function tokenize(word: string, phonology: Phonology): string[] | null {
  const syms = sortedPhonemeSymbols(phonology);
  const upper = word.normalize('NFC');
  const out: string[] = [];
  let i = 0;
  while (i < upper.length) {
    let hit: string | undefined;
    for (const s of syms) {
      if (upper.startsWith(s, i)) {
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
