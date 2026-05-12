/**
 * Curated IPA subset for UI grids — place / manner / voicing for pulmonic consonants
 * plus cardinal vowel quadrilateral ids.
 */

export type PulmonicConsonant = {
  symbol: string;
  ipa: string;
  place: string;
  manner: string;
  voicing: 'voiceless' | 'voiced';
};

export const PULMONIC_CONSONANTS: PulmonicConsonant[] = [
  { symbol: 'p', ipa: 'p', place: 'bilabial', manner: 'stop', voicing: 'voiceless' },
  { symbol: 'b', ipa: 'b', place: 'bilabial', manner: 'stop', voicing: 'voiced' },
  { symbol: 't', ipa: 't', place: 'alveolar', manner: 'stop', voicing: 'voiceless' },
  { symbol: 'd', ipa: 'd', place: 'alveolar', manner: 'stop', voicing: 'voiced' },
  { symbol: 'k', ipa: 'k', place: 'velar', manner: 'stop', voicing: 'voiceless' },
  { symbol: 'ɡ', ipa: 'ɡ', place: 'velar', manner: 'stop', voicing: 'voiced' },
  { symbol: 'm', ipa: 'm', place: 'bilabial', manner: 'nasal', voicing: 'voiced' },
  { symbol: 'n', ipa: 'n', place: 'alveolar', manner: 'nasal', voicing: 'voiced' },
  { symbol: 'ŋ', ipa: 'ŋ', place: 'velar', manner: 'nasal', voicing: 'voiced' },
  { symbol: 'f', ipa: 'f', place: 'labiodental', manner: 'fricative', voicing: 'voiceless' },
  { symbol: 'v', ipa: 'v', place: 'labiodental', manner: 'fricative', voicing: 'voiced' },
  { symbol: 's', ipa: 's', place: 'alveolar', manner: 'fricative', voicing: 'voiceless' },
  { symbol: 'z', ipa: 'z', place: 'alveolar', manner: 'fricative', voicing: 'voiced' },
  { symbol: 'ʃ', ipa: 'ʃ', place: 'postalveolar', manner: 'fricative', voicing: 'voiceless' },
  { symbol: 'ʒ', ipa: 'ʒ', place: 'postalveolar', manner: 'fricative', voicing: 'voiced' },
  { symbol: 'h', ipa: 'h', place: 'glottal', manner: 'fricative', voicing: 'voiceless' },
  { symbol: 'l', ipa: 'l', place: 'alveolar', manner: 'approximant', voicing: 'voiced' },
  { symbol: 'j', ipa: 'j', place: 'palatal', manner: 'approximant', voicing: 'voiced' },
  { symbol: 'w', ipa: 'w', place: 'labial-velar', manner: 'approximant', voicing: 'voiced' },
  { symbol: 'r', ipa: 'r', place: 'alveolar', manner: 'approximant', voicing: 'voiced' },
];

export type CardinalVowel = { symbol: string; ipa: string; height: string; backness: string };

export const CARDINAL_VOWELS: CardinalVowel[] = [
  { symbol: 'i', ipa: 'i', height: 'close', backness: 'front' },
  { symbol: 'e', ipa: 'e', height: 'close-mid', backness: 'front' },
  { symbol: 'ɛ', ipa: 'ɛ', height: 'open-mid', backness: 'front' },
  { symbol: 'a', ipa: 'a', height: 'open', backness: 'front' },
  { symbol: 'u', ipa: 'u', height: 'close', backness: 'back' },
  { symbol: 'o', ipa: 'o', height: 'close-mid', backness: 'back' },
  { symbol: 'ɔ', ipa: 'ɔ', height: 'open-mid', backness: 'back' },
  { symbol: 'ɑ', ipa: 'ɑ', height: 'open', backness: 'back' },
  { symbol: 'ə', ipa: 'ə', height: 'mid', backness: 'central' },
];
