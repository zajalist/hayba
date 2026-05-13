// IPA chart
export type {
  CardinalVowel, PulmonicConsonant,
  Voicing, ConsonantManner, ConsonantPlace,
  VowelHeight, VowelBackness, Roundness,
} from './ipa-chart.js';
export {
  CARDINAL_VOWELS, PULMONIC_CONSONANTS, NON_PULMONIC_CONSONANTS,
  allChartIpa, consonantToPhonemeFeatures, vowelToPhonemeFeatures,
} from './ipa-chart.js';

// Phonology engine
export type { FeatureBundle, Phoneme, Phonology } from './phonology.js';
export {
  consonants, findPhonemeByIpa, getPhonemeById, phonemesWithFeatures,
  sortedPhonemeSymbols, tokenize, validatePhonology, vowels,
} from './phonology.js';

// Co-occurrence model + audio
export type { CoOccurrenceModel } from './cooccurrence.js';
export { buildCoOccurrenceModel } from './cooccurrence.js';
export type { InventoryRecord } from './data/inventories.js';
export { INVENTORIES, loadInventoriesFromPhoible, loadPhoibleCorpus } from './data/inventories.js';
export { audioUrlFor, audioCatalogueKeys } from './audio.js';

// Phonotactics (L2)
export type { PhonotacticSpec, SyllableProfile, PhonotacticResult, ClusterCell, ClusterLegality } from './phonotactics.js';
export { validatePhonotactics, passesPhonotactics, clusterLegality } from './phonotactics.js';

// Name generator (L4)
export type { NameCategory, NameGeneratorProfile, GenerateNameParams } from './name-generator.js';
export { generatePhonotacticName } from './name-generator.js';

// Lexicon (L3 + L9 POS / morph)
export type { Lexeme, LexiconRepo, SqlClient, PartOfSpeech, MorphFeatures } from './lexicon.js';
export { InMemoryLexicon, LexiconStore, PostgresLexicon, PARTS_OF_SPEECH } from './lexicon.js';

// Sound changes (L5)
export type { SoundChangeRule } from './sound-changes.js';
export {
  parseRule, parseRules, stringifyRule, applyRule, evolveWord, evolveLexicon,
} from './sound-changes.js';

// RNG (used by L4, exposed for hosts that want sub-streams)
export { SplitMix64, deriveSeed, fnv1a64 } from './rng.js';

// AI derivation scaffold (L7)
export type { DerivationLLM, DerivationRequest, DerivationResult } from './derivation.js';
export { proposeDerivation } from './derivation.js';

// Anthropic LLM adapter for L7 derivation (L18) — gated by optional SDK.
export type { AnthropicAdapterOpts } from './llm-anthropic.js';
export { createAnthropicLLM, buildSystemPrompt } from './llm-anthropic.js';

// Romanization
export type { RomanizationMap, RomanizationRule } from './romanization.js';
export { romanize, deromanize, defaultRomanization } from './romanization.js';

// Translator (L10)
export type {
  TranslatedToken, TranslatedSentence, TranslatorContext, RawToken,
} from './translator.js';
export {
  translate, tokenize as tokenizeText, lemmatize, renderTranslation, renderRomanized,
} from './translator.js';

// Morphology / paradigms (L11)
export type {
  AffixRule, AffixPosition, ParadigmDef, ParadigmCell, MorphTarget,
} from './morphology.js';
export {
  inflect, buildParadigm, enumerateAxes, findRuleConflicts, PRESET_PARADIGMS,
  addAxis, removeAxis, addAxisValue, removeAxisValue,
} from './morphology.js';

// Wordlinks — cross-language translation graph (L13)
export type { Wordlink, WordlinkKind, WordlinkRepo } from './wordlinks.js';
export {
  InMemoryWordlinks, PostgresWordlinks, autoCognatesFromDiachrony,
} from './wordlinks.js';

// Family tree (L14)
export type { LanguageTreeNode, SampleChange } from './family-tree.js';
export { buildFamilyTree } from './family-tree.js';

// Loanword adapter (L20)
export type {
  AdaptationStep, AdaptedLoanword, LoanwordAdapter, LoanwordAdapterOptions,
} from './loanword.js';
export { createLoanwordAdapter } from './loanword.js';

// Typology catalogue (L15)
export type {
  TypologyFeature, TypologyOption, TypologyCategory, LanguageProfile,
} from './data/typology.js';
export {
  TYPOLOGY_FEATURES, TYPOLOGY_PRESETS, getTypologyFeature, validateProfile, profileSummary,
} from './data/typology.js';
