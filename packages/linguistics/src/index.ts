export type { CardinalVowel, PulmonicConsonant } from './ipa-chart.js';
export { CARDINAL_VOWELS, PULMONIC_CONSONANTS } from './ipa-chart.js';

export type { Lexeme } from './lexicon.js';
export { LexiconStore } from './lexicon.js';

export type { NameCategory, NameGeneratorProfile } from './name-generator.js';
export { generatePhonotacticName } from './name-generator.js';

export type { Phoneme, Phonology } from './phonology.js';
export { sortedPhonemeSymbols, tokenize } from './phonology.js';

export type { PhonotacticSpec, SyllableProfile } from './phonotactics.js';
export { validatePhonotactics } from './phonotactics.js';
