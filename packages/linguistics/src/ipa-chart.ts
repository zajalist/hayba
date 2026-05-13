/**
 * Full IPA chart catalogue — drives the inventory-picker UI.
 *
 * Covers the official IPA (2020 chart):
 *   - Pulmonic consonants: place × manner × voicing, with gaps marked.
 *   - Non-pulmonic: clicks, implosives, ejectives (sampler set).
 *   - Vowels: complete quadrilateral (close, near-close, close-mid, mid,
 *     open-mid, near-open, open) × (front, central, back) × rounded/unrounded.
 *   - A few suprasegmental tokens (stress, length, tone) so the chart can
 *     surface them, even though the engine treats them as features rather
 *     than segments.
 */

export type Voicing = 'voiceless' | 'voiced';

export type ConsonantManner =
  | 'plosive' | 'nasal' | 'trill' | 'tap' | 'lateral-tap'
  | 'sibilant-fricative' | 'fricative'
  | 'lateral-fricative' | 'approximant' | 'lateral-approximant'
  | 'affricate' | 'click' | 'implosive' | 'ejective';

export type ConsonantPlace =
  | 'bilabial' | 'labiodental' | 'linguolabial'
  | 'dental' | 'alveolar' | 'postalveolar' | 'retroflex'
  | 'alveolo-palatal' | 'palatal' | 'velar' | 'uvular'
  | 'pharyngeal' | 'epiglottal' | 'glottal'
  | 'labial-velar' | 'labial-palatal';

export interface PulmonicConsonant {
  symbol: string;
  ipa: string;
  place: ConsonantPlace;
  manner: ConsonantManner;
  voicing: Voicing;
}

/**
 * Full pulmonic chart aligned with the IPA / Wikipedia layout:
 * voiceless | voiced per cell, with extIPA additions (voiceless sonorants
 * via combining ring, linguolabial column, dental/post-alveolar refinements,
 * sibilant vs non-sibilant fricative split, lateral tap/flap).
 */
export const PULMONIC_CONSONANTS: PulmonicConsonant[] = [
  // ─── Nasals ─────────────────────────────────────────────────────────
  { symbol: 'm̥',  ipa: 'm̥',  place: 'bilabial',     manner: 'nasal',   voicing: 'voiceless' },
  { symbol: 'm',  ipa: 'm',  place: 'bilabial',     manner: 'nasal',   voicing: 'voiced' },
  { symbol: 'ɱ̊',  ipa: 'ɱ̊',  place: 'labiodental',  manner: 'nasal',   voicing: 'voiceless' },
  { symbol: 'ɱ',  ipa: 'ɱ',  place: 'labiodental',  manner: 'nasal',   voicing: 'voiced' },
  { symbol: 'n̼',  ipa: 'n̼',  place: 'linguolabial', manner: 'nasal',   voicing: 'voiced' },
  { symbol: 'n̥',  ipa: 'n̥',  place: 'alveolar',     manner: 'nasal',   voicing: 'voiceless' },
  { symbol: 'n',  ipa: 'n',  place: 'alveolar',     manner: 'nasal',   voicing: 'voiced' },
  { symbol: 'ɳ̊',  ipa: 'ɳ̊',  place: 'retroflex',    manner: 'nasal',   voicing: 'voiceless' },
  { symbol: 'ɳ',  ipa: 'ɳ',  place: 'retroflex',    manner: 'nasal',   voicing: 'voiced' },
  { symbol: 'ɲ̊',  ipa: 'ɲ̊',  place: 'palatal',      manner: 'nasal',   voicing: 'voiceless' },
  { symbol: 'ɲ',  ipa: 'ɲ',  place: 'palatal',      manner: 'nasal',   voicing: 'voiced' },
  { symbol: 'ŋ̊',  ipa: 'ŋ̊',  place: 'velar',        manner: 'nasal',   voicing: 'voiceless' },
  { symbol: 'ŋ',  ipa: 'ŋ',  place: 'velar',        manner: 'nasal',   voicing: 'voiced' },
  { symbol: 'ɴ̥',  ipa: 'ɴ̥',  place: 'uvular',       manner: 'nasal',   voicing: 'voiceless' },
  { symbol: 'ɴ',  ipa: 'ɴ',  place: 'uvular',       manner: 'nasal',   voicing: 'voiced' },

  // ─── Plosives ───────────────────────────────────────────────────────
  { symbol: 'p',  ipa: 'p',  place: 'bilabial',     manner: 'plosive', voicing: 'voiceless' },
  { symbol: 'b',  ipa: 'b',  place: 'bilabial',     manner: 'plosive', voicing: 'voiced' },
  { symbol: 'p̪',  ipa: 'p̪',  place: 'labiodental',  manner: 'plosive', voicing: 'voiceless' },
  { symbol: 'b̪',  ipa: 'b̪',  place: 'labiodental',  manner: 'plosive', voicing: 'voiced' },
  { symbol: 't̼',  ipa: 't̼',  place: 'linguolabial', manner: 'plosive', voicing: 'voiceless' },
  { symbol: 'd̼',  ipa: 'd̼',  place: 'linguolabial', manner: 'plosive', voicing: 'voiced' },
  { symbol: 't̪',  ipa: 't̪',  place: 'dental',       manner: 'plosive', voicing: 'voiceless' },
  { symbol: 'd̪',  ipa: 'd̪',  place: 'dental',       manner: 'plosive', voicing: 'voiced' },
  { symbol: 't',  ipa: 't',  place: 'alveolar',     manner: 'plosive', voicing: 'voiceless' },
  { symbol: 'd',  ipa: 'd',  place: 'alveolar',     manner: 'plosive', voicing: 'voiced' },
  { symbol: 't̠',  ipa: 't̠',  place: 'postalveolar', manner: 'plosive', voicing: 'voiceless' },
  { symbol: 'd̠',  ipa: 'd̠',  place: 'postalveolar', manner: 'plosive', voicing: 'voiced' },
  { symbol: 'ʈ',  ipa: 'ʈ',  place: 'retroflex',    manner: 'plosive', voicing: 'voiceless' },
  { symbol: 'ɖ',  ipa: 'ɖ',  place: 'retroflex',    manner: 'plosive', voicing: 'voiced' },
  { symbol: 'c',  ipa: 'c',  place: 'palatal',      manner: 'plosive', voicing: 'voiceless' },
  { symbol: 'ɟ',  ipa: 'ɟ',  place: 'palatal',      manner: 'plosive', voicing: 'voiced' },
  { symbol: 'k',  ipa: 'k',  place: 'velar',        manner: 'plosive', voicing: 'voiceless' },
  { symbol: 'ɡ',  ipa: 'ɡ',  place: 'velar',        manner: 'plosive', voicing: 'voiced' },
  { symbol: 'q',  ipa: 'q',  place: 'uvular',       manner: 'plosive', voicing: 'voiceless' },
  { symbol: 'ɢ',  ipa: 'ɢ',  place: 'uvular',       manner: 'plosive', voicing: 'voiced' },
  { symbol: 'ʡ',  ipa: 'ʡ',  place: 'epiglottal',   manner: 'plosive', voicing: 'voiceless' },
  { symbol: 'ʔ',  ipa: 'ʔ',  place: 'glottal',      manner: 'plosive', voicing: 'voiceless' },

  // ─── Sibilant fricatives ────────────────────────────────────────────
  { symbol: 's',  ipa: 's',  place: 'alveolar',     manner: 'sibilant-fricative', voicing: 'voiceless' },
  { symbol: 'z',  ipa: 'z',  place: 'alveolar',     manner: 'sibilant-fricative', voicing: 'voiced' },
  { symbol: 'ʃ',  ipa: 'ʃ',  place: 'postalveolar', manner: 'sibilant-fricative', voicing: 'voiceless' },
  { symbol: 'ʒ',  ipa: 'ʒ',  place: 'postalveolar', manner: 'sibilant-fricative', voicing: 'voiced' },
  { symbol: 'ʂ',  ipa: 'ʂ',  place: 'retroflex',    manner: 'sibilant-fricative', voicing: 'voiceless' },
  { symbol: 'ʐ',  ipa: 'ʐ',  place: 'retroflex',    manner: 'sibilant-fricative', voicing: 'voiced' },
  { symbol: 'ɕ',  ipa: 'ɕ',  place: 'alveolo-palatal', manner: 'sibilant-fricative', voicing: 'voiceless' },
  { symbol: 'ʑ',  ipa: 'ʑ',  place: 'alveolo-palatal', manner: 'sibilant-fricative', voicing: 'voiced' },

  // ─── Non-sibilant fricatives ────────────────────────────────────────
  { symbol: 'ɸ',  ipa: 'ɸ',  place: 'bilabial',     manner: 'fricative', voicing: 'voiceless' },
  { symbol: 'β',  ipa: 'β',  place: 'bilabial',     manner: 'fricative', voicing: 'voiced' },
  { symbol: 'f',  ipa: 'f',  place: 'labiodental',  manner: 'fricative', voicing: 'voiceless' },
  { symbol: 'v',  ipa: 'v',  place: 'labiodental',  manner: 'fricative', voicing: 'voiced' },
  { symbol: 'θ̼',  ipa: 'θ̼',  place: 'linguolabial', manner: 'fricative', voicing: 'voiceless' },
  { symbol: 'ð̼',  ipa: 'ð̼',  place: 'linguolabial', manner: 'fricative', voicing: 'voiced' },
  { symbol: 'θ',  ipa: 'θ',  place: 'dental',       manner: 'fricative', voicing: 'voiceless' },
  { symbol: 'ð',  ipa: 'ð',  place: 'dental',       manner: 'fricative', voicing: 'voiced' },
  { symbol: 'θ̠',  ipa: 'θ̠',  place: 'alveolar',     manner: 'fricative', voicing: 'voiceless' },
  { symbol: 'ð̠',  ipa: 'ð̠',  place: 'alveolar',     manner: 'fricative', voicing: 'voiced' },
  { symbol: 'ç',  ipa: 'ç',  place: 'palatal',      manner: 'fricative', voicing: 'voiceless' },
  { symbol: 'ʝ',  ipa: 'ʝ',  place: 'palatal',      manner: 'fricative', voicing: 'voiced' },
  { symbol: 'x',  ipa: 'x',  place: 'velar',        manner: 'fricative', voicing: 'voiceless' },
  { symbol: 'ɣ',  ipa: 'ɣ',  place: 'velar',        manner: 'fricative', voicing: 'voiced' },
  { symbol: 'χ',  ipa: 'χ',  place: 'uvular',       manner: 'fricative', voicing: 'voiceless' },
  { symbol: 'ʁ',  ipa: 'ʁ',  place: 'uvular',       manner: 'fricative', voicing: 'voiced' },
  { symbol: 'ħ',  ipa: 'ħ',  place: 'pharyngeal',   manner: 'fricative', voicing: 'voiceless' },
  { symbol: 'ʕ',  ipa: 'ʕ',  place: 'pharyngeal',   manner: 'fricative', voicing: 'voiced' },
  { symbol: 'ʜ',  ipa: 'ʜ',  place: 'epiglottal',   manner: 'fricative', voicing: 'voiceless' },
  { symbol: 'ʢ',  ipa: 'ʢ',  place: 'epiglottal',   manner: 'fricative', voicing: 'voiced' },
  { symbol: 'h',  ipa: 'h',  place: 'glottal',      manner: 'fricative', voicing: 'voiceless' },
  { symbol: 'ɦ',  ipa: 'ɦ',  place: 'glottal',      manner: 'fricative', voicing: 'voiced' },
  { symbol: 'ʍ',  ipa: 'ʍ',  place: 'labial-velar', manner: 'fricative', voicing: 'voiceless' },
  { symbol: 'ɧ',  ipa: 'ɧ',  place: 'postalveolar', manner: 'fricative', voicing: 'voiceless' },

  // ─── Approximants ──────────────────────────────────────────────────
  { symbol: 'ʋ̥',  ipa: 'ʋ̥',  place: 'labiodental',  manner: 'approximant', voicing: 'voiceless' },
  { symbol: 'ʋ',  ipa: 'ʋ',  place: 'labiodental',  manner: 'approximant', voicing: 'voiced' },
  { symbol: 'ɹ̥',  ipa: 'ɹ̥',  place: 'alveolar',     manner: 'approximant', voicing: 'voiceless' },
  { symbol: 'ɹ',  ipa: 'ɹ',  place: 'alveolar',     manner: 'approximant', voicing: 'voiced' },
  { symbol: 'ɻ̊',  ipa: 'ɻ̊',  place: 'retroflex',    manner: 'approximant', voicing: 'voiceless' },
  { symbol: 'ɻ',  ipa: 'ɻ',  place: 'retroflex',    manner: 'approximant', voicing: 'voiced' },
  { symbol: 'j̊',  ipa: 'j̊',  place: 'palatal',      manner: 'approximant', voicing: 'voiceless' },
  { symbol: 'j',  ipa: 'j',  place: 'palatal',      manner: 'approximant', voicing: 'voiced' },
  { symbol: 'ɰ̊',  ipa: 'ɰ̊',  place: 'velar',        manner: 'approximant', voicing: 'voiceless' },
  { symbol: 'ɰ',  ipa: 'ɰ',  place: 'velar',        manner: 'approximant', voicing: 'voiced' },
  { symbol: 'w',  ipa: 'w',  place: 'labial-velar', manner: 'approximant', voicing: 'voiced' },
  { symbol: 'ɥ',  ipa: 'ɥ',  place: 'labial-palatal', manner: 'approximant', voicing: 'voiced' },

  // ─── Taps / flaps ──────────────────────────────────────────────────
  { symbol: 'ⱱ̟',  ipa: 'ⱱ̟',  place: 'bilabial',     manner: 'tap',     voicing: 'voiced' },
  { symbol: 'ⱱ',  ipa: 'ⱱ',  place: 'labiodental',  manner: 'tap',     voicing: 'voiced' },
  { symbol: 'ɾ̼',  ipa: 'ɾ̼',  place: 'linguolabial', manner: 'tap',     voicing: 'voiced' },
  { symbol: 'ɾ̥',  ipa: 'ɾ̥',  place: 'alveolar',     manner: 'tap',     voicing: 'voiceless' },
  { symbol: 'ɾ',  ipa: 'ɾ',  place: 'alveolar',     manner: 'tap',     voicing: 'voiced' },
  { symbol: 'ɽ̊',  ipa: 'ɽ̊',  place: 'retroflex',    manner: 'tap',     voicing: 'voiceless' },
  { symbol: 'ɽ',  ipa: 'ɽ',  place: 'retroflex',    manner: 'tap',     voicing: 'voiced' },
  { symbol: 'ɢ̆',  ipa: 'ɢ̆',  place: 'uvular',       manner: 'tap',     voicing: 'voiced' },
  { symbol: 'ʡ̆',  ipa: 'ʡ̆',  place: 'epiglottal',   manner: 'tap',     voicing: 'voiced' },

  // ─── Trills ────────────────────────────────────────────────────────
  { symbol: 'ʙ̥',  ipa: 'ʙ̥',  place: 'bilabial',     manner: 'trill',   voicing: 'voiceless' },
  { symbol: 'ʙ',  ipa: 'ʙ',  place: 'bilabial',     manner: 'trill',   voicing: 'voiced' },
  { symbol: 'r̥',  ipa: 'r̥',  place: 'alveolar',     manner: 'trill',   voicing: 'voiceless' },
  { symbol: 'r',  ipa: 'r',  place: 'alveolar',     manner: 'trill',   voicing: 'voiced' },
  { symbol: 'ʀ̥',  ipa: 'ʀ̥',  place: 'uvular',       manner: 'trill',   voicing: 'voiceless' },
  { symbol: 'ʀ',  ipa: 'ʀ',  place: 'uvular',       manner: 'trill',   voicing: 'voiced' },

  // ─── Lateral fricatives ────────────────────────────────────────────
  { symbol: 'ɬ',  ipa: 'ɬ',  place: 'alveolar',     manner: 'lateral-fricative', voicing: 'voiceless' },
  { symbol: 'ɮ',  ipa: 'ɮ',  place: 'alveolar',     manner: 'lateral-fricative', voicing: 'voiced' },

  // ─── Lateral approximants ──────────────────────────────────────────
  { symbol: 'l̥',  ipa: 'l̥',  place: 'alveolar',     manner: 'lateral-approximant', voicing: 'voiceless' },
  { symbol: 'l',  ipa: 'l',  place: 'alveolar',     manner: 'lateral-approximant', voicing: 'voiced' },
  { symbol: 'ɭ',  ipa: 'ɭ',  place: 'retroflex',    manner: 'lateral-approximant', voicing: 'voiced' },
  { symbol: 'ʎ',  ipa: 'ʎ',  place: 'palatal',      manner: 'lateral-approximant', voicing: 'voiced' },
  { symbol: 'ʟ',  ipa: 'ʟ',  place: 'velar',        manner: 'lateral-approximant', voicing: 'voiced' },

  // ─── Lateral taps/flaps ────────────────────────────────────────────
  { symbol: 'ɺ',  ipa: 'ɺ',  place: 'alveolar',     manner: 'lateral-tap', voicing: 'voiced' },
  { symbol: 'ʟ̆',  ipa: 'ʟ̆',  place: 'velar',        manner: 'lateral-tap', voicing: 'voiced' },

  // ─── Affricates ────────────────────────────────────────────────────
  { symbol: 't͡s', ipa: 't͡s', place: 'alveolar',     manner: 'affricate', voicing: 'voiceless' },
  { symbol: 'd͡z', ipa: 'd͡z', place: 'alveolar',     manner: 'affricate', voicing: 'voiced' },
  { symbol: 't͡ʃ', ipa: 't͡ʃ', place: 'postalveolar', manner: 'affricate', voicing: 'voiceless' },
  { symbol: 'd͡ʒ', ipa: 'd͡ʒ', place: 'postalveolar', manner: 'affricate', voicing: 'voiced' },
  { symbol: 't͡ɕ', ipa: 't͡ɕ', place: 'alveolo-palatal', manner: 'affricate', voicing: 'voiceless' },
  { symbol: 'd͡ʑ', ipa: 'd͡ʑ', place: 'alveolo-palatal', manner: 'affricate', voicing: 'voiced' },
  { symbol: 'p͡f', ipa: 'p͡f', place: 'labiodental',  manner: 'affricate', voicing: 'voiceless' },
  { symbol: 't͡ɬ', ipa: 't͡ɬ', place: 'alveolar',     manner: 'affricate', voicing: 'voiceless' },
  { symbol: 'k͡x', ipa: 'k͡x', place: 'velar',        manner: 'affricate', voicing: 'voiceless' },
];

/** Non-pulmonic — clicks, implosives, common ejectives. */
export const NON_PULMONIC_CONSONANTS: PulmonicConsonant[] = [
  { symbol: 'ʘ',  ipa: 'ʘ',  place: 'bilabial',     manner: 'click', voicing: 'voiceless' },
  { symbol: 'ǀ',  ipa: 'ǀ',  place: 'dental',       manner: 'click', voicing: 'voiceless' },
  { symbol: 'ǃ',  ipa: 'ǃ',  place: 'alveolar',     manner: 'click', voicing: 'voiceless' },
  { symbol: 'ǂ',  ipa: 'ǂ',  place: 'palatal',      manner: 'click', voicing: 'voiceless' },
  { symbol: 'ǁ',  ipa: 'ǁ',  place: 'alveolar',     manner: 'click', voicing: 'voiceless' },

  { symbol: 'ɓ',  ipa: 'ɓ',  place: 'bilabial',     manner: 'implosive', voicing: 'voiced' },
  { symbol: 'ɗ',  ipa: 'ɗ',  place: 'alveolar',     manner: 'implosive', voicing: 'voiced' },
  { symbol: 'ʄ',  ipa: 'ʄ',  place: 'palatal',      manner: 'implosive', voicing: 'voiced' },
  { symbol: 'ɠ',  ipa: 'ɠ',  place: 'velar',        manner: 'implosive', voicing: 'voiced' },
  { symbol: 'ʛ',  ipa: 'ʛ',  place: 'uvular',       manner: 'implosive', voicing: 'voiced' },

  { symbol: 'pʼ', ipa: 'pʼ', place: 'bilabial',     manner: 'ejective', voicing: 'voiceless' },
  { symbol: 'tʼ', ipa: 'tʼ', place: 'alveolar',     manner: 'ejective', voicing: 'voiceless' },
  { symbol: 'kʼ', ipa: 'kʼ', place: 'velar',        manner: 'ejective', voicing: 'voiceless' },
  { symbol: 'qʼ', ipa: 'qʼ', place: 'uvular',       manner: 'ejective', voicing: 'voiceless' },
  { symbol: 'sʼ', ipa: 'sʼ', place: 'alveolar',     manner: 'ejective', voicing: 'voiceless' },
  { symbol: 'ʈʼ', ipa: 'ʈʼ', place: 'retroflex',    manner: 'ejective', voicing: 'voiceless' },
  { symbol: 'cʼ', ipa: 'cʼ', place: 'palatal',      manner: 'ejective', voicing: 'voiceless' },
  { symbol: 'fʼ', ipa: 'fʼ', place: 'labiodental',  manner: 'ejective', voicing: 'voiceless' },
  { symbol: 'ʃʼ', ipa: 'ʃʼ', place: 'postalveolar', manner: 'ejective', voicing: 'voiceless' },

  // Voiced clicks (nasal series).
  { symbol: 'ɡʘ', ipa: 'ɡʘ', place: 'bilabial',     manner: 'click', voicing: 'voiced' },
  { symbol: 'ɡǀ', ipa: 'ɡǀ', place: 'dental',       manner: 'click', voicing: 'voiced' },
  { symbol: 'ɡǃ', ipa: 'ɡǃ', place: 'alveolar',     manner: 'click', voicing: 'voiced' },
  { symbol: 'ɡǂ', ipa: 'ɡǂ', place: 'palatal',      manner: 'click', voicing: 'voiced' },
];

export type VowelHeight =
  | 'close' | 'near-close' | 'close-mid' | 'mid'
  | 'open-mid' | 'near-open' | 'open';

export type VowelBackness = 'front' | 'central' | 'back';

export type Roundness = 'rounded' | 'unrounded';

export interface CardinalVowel {
  symbol: string;
  ipa: string;
  height: VowelHeight;
  backness: VowelBackness;
  roundness: Roundness;
}

/** Full IPA vowel quadrilateral. Pairs at each height/backness: unrounded · rounded. */
export const CARDINAL_VOWELS: CardinalVowel[] = [
  // Close
  { symbol: 'i', ipa: 'i', height: 'close',     backness: 'front',   roundness: 'unrounded' },
  { symbol: 'y', ipa: 'y', height: 'close',     backness: 'front',   roundness: 'rounded' },
  { symbol: 'ɨ', ipa: 'ɨ', height: 'close',     backness: 'central', roundness: 'unrounded' },
  { symbol: 'ʉ', ipa: 'ʉ', height: 'close',     backness: 'central', roundness: 'rounded' },
  { symbol: 'ɯ', ipa: 'ɯ', height: 'close',     backness: 'back',    roundness: 'unrounded' },
  { symbol: 'u', ipa: 'u', height: 'close',     backness: 'back',    roundness: 'rounded' },

  // Near-close
  { symbol: 'ɪ', ipa: 'ɪ', height: 'near-close', backness: 'front',  roundness: 'unrounded' },
  { symbol: 'ʏ', ipa: 'ʏ', height: 'near-close', backness: 'front',  roundness: 'rounded' },
  { symbol: 'ʊ', ipa: 'ʊ', height: 'near-close', backness: 'back',   roundness: 'rounded' },

  // Close-mid
  { symbol: 'e', ipa: 'e', height: 'close-mid', backness: 'front',   roundness: 'unrounded' },
  { symbol: 'ø', ipa: 'ø', height: 'close-mid', backness: 'front',   roundness: 'rounded' },
  { symbol: 'ɘ', ipa: 'ɘ', height: 'close-mid', backness: 'central', roundness: 'unrounded' },
  { symbol: 'ɵ', ipa: 'ɵ', height: 'close-mid', backness: 'central', roundness: 'rounded' },
  { symbol: 'ɤ', ipa: 'ɤ', height: 'close-mid', backness: 'back',    roundness: 'unrounded' },
  { symbol: 'o', ipa: 'o', height: 'close-mid', backness: 'back',    roundness: 'rounded' },

  // Mid (schwa lives here)
  { symbol: 'ə', ipa: 'ə', height: 'mid',       backness: 'central', roundness: 'unrounded' },

  // Open-mid
  { symbol: 'ɛ', ipa: 'ɛ', height: 'open-mid',  backness: 'front',   roundness: 'unrounded' },
  { symbol: 'œ', ipa: 'œ', height: 'open-mid',  backness: 'front',   roundness: 'rounded' },
  { symbol: 'ɜ', ipa: 'ɜ', height: 'open-mid',  backness: 'central', roundness: 'unrounded' },
  { symbol: 'ɞ', ipa: 'ɞ', height: 'open-mid',  backness: 'central', roundness: 'rounded' },
  { symbol: 'ʌ', ipa: 'ʌ', height: 'open-mid',  backness: 'back',    roundness: 'unrounded' },
  { symbol: 'ɔ', ipa: 'ɔ', height: 'open-mid',  backness: 'back',    roundness: 'rounded' },

  // Near-open
  { symbol: 'æ', ipa: 'æ', height: 'near-open', backness: 'front',   roundness: 'unrounded' },
  { symbol: 'ɐ', ipa: 'ɐ', height: 'near-open', backness: 'central', roundness: 'unrounded' },

  // Open
  { symbol: 'a', ipa: 'a', height: 'open',      backness: 'front',   roundness: 'unrounded' },
  { symbol: 'ɶ', ipa: 'ɶ', height: 'open',      backness: 'front',   roundness: 'rounded' },
  { symbol: 'ä', ipa: 'ä', height: 'open',      backness: 'central', roundness: 'unrounded' },
  { symbol: 'ɑ', ipa: 'ɑ', height: 'open',      backness: 'back',    roundness: 'unrounded' },
  { symbol: 'ɒ', ipa: 'ɒ', height: 'open',      backness: 'back',    roundness: 'rounded' },
];

/** Convert an IPA chart entry into a Phonology phoneme entry with feature bundle. */
export function consonantToPhonemeFeatures(c: PulmonicConsonant): Record<string, string> {
  return { place: c.place, manner: c.manner, voicing: c.voicing };
}

export function vowelToPhonemeFeatures(v: CardinalVowel): Record<string, string> {
  return { height: v.height, backness: v.backness, roundness: v.roundness };
}

/** Every IPA symbol exposed by the chart, in display order. */
export function allChartIpa(): string[] {
  return [
    ...PULMONIC_CONSONANTS.map(c => c.ipa),
    ...NON_PULMONIC_CONSONANTS.map(c => c.ipa),
    ...CARDINAL_VOWELS.map(v => v.ipa),
  ];
}
