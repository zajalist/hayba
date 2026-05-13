/**
 * L15 — Typology catalogue. WALS-/Grambank-style feature checklist.
 *
 * The frequency annotations below are rough cross-linguistic proportions taken
 * from the World Atlas of Language Structures (WALS, https://wals.info) and
 * Grambank (https://grambank.clld.org). They are approximate and meant to give
 * the workbench user a sense of how common each option is across the world's
 * languages — not to be a citable source. When the literature disagrees we
 * use round numbers that are easy to read on the bar visualisations.
 *
 * Downstream consumers
 *   • Translator (L10)  → constituent order from `word_order`
 *   • Grammar engine (L11) → affix order via `head_marking`, `polysynthesis`
 *   • Family Tree (L14) → typological drift between parent and daughter
 */

export type TypologyCategory =
  | 'word-order'
  | 'morphology'
  | 'phonology'
  | 'syntax'
  | 'semantics';

export interface TypologyOption {
  value: string;
  label: string;
  /** Approximate fraction of the world's languages exhibiting this option (0-1). */
  frequency?: number;
}

export interface TypologyFeature {
  key: string;
  label: string;
  description: string;
  category: TypologyCategory;
  options: TypologyOption[];
}

/** Per-language profile: feature key → chosen option value. Partial by design. */
export type LanguageProfile = Record<string, string>;

export const TYPOLOGY_FEATURES: TypologyFeature[] = [
  // ── Word order ──────────────────────────────────────────────────────────
  {
    key: 'word_order',
    label: 'Basic constituent order',
    description: 'Order of Subject, Verb and Object in a neutral main clause.',
    category: 'word-order',
    options: [
      { value: 'SOV',  label: 'SOV',  frequency: 0.41 },
      { value: 'SVO',  label: 'SVO',  frequency: 0.35 },
      { value: 'VSO',  label: 'VSO',  frequency: 0.07 },
      { value: 'VOS',  label: 'VOS',  frequency: 0.02 },
      { value: 'OVS',  label: 'OVS',  frequency: 0.01 },
      { value: 'OSV',  label: 'OSV',  frequency: 0.005 },
      { value: 'free', label: 'No dominant order', frequency: 0.13 },
    ],
  },
  {
    key: 'adposition_order',
    label: 'Adposition order',
    description: 'Prepositions precede their noun; postpositions follow it.',
    category: 'word-order',
    options: [
      { value: 'preposition',  label: 'Prepositions',  frequency: 0.43 },
      { value: 'postposition', label: 'Postpositions', frequency: 0.51 },
      { value: 'none',         label: 'Neither dominant', frequency: 0.06 },
    ],
  },
  {
    key: 'genitive_order',
    label: 'Genitive–noun order',
    description: 'Whether the possessor precedes or follows the possessed noun.',
    category: 'word-order',
    options: [
      { value: 'gen-noun', label: 'Genitive · Noun', frequency: 0.55 },
      { value: 'noun-gen', label: 'Noun · Genitive', frequency: 0.41 },
      { value: 'free',     label: 'No dominant order', frequency: 0.04 },
    ],
  },

  // ── Morphology / alignment ──────────────────────────────────────────────
  {
    key: 'alignment',
    label: 'Morphological alignment',
    description: 'How verb arguments (S, A, P) are grouped by case or agreement.',
    category: 'morphology',
    options: [
      { value: 'nom-acc',        label: 'Nominative–accusative', frequency: 0.52 },
      { value: 'erg-abs',        label: 'Ergative–absolutive',  frequency: 0.16 },
      { value: 'split-s',        label: 'Split-S / active–stative', frequency: 0.05 },
      { value: 'tripartite',     label: 'Tripartite',           frequency: 0.02 },
      { value: 'direct-inverse', label: 'Direct–inverse',       frequency: 0.03 },
      { value: 'neutral',        label: 'Neutral (no marking)', frequency: 0.22 },
    ],
  },
  {
    key: 'head_marking',
    label: 'Head / dependent marking',
    description: 'Where grammatical relations are marked: on the head, the dependent, or both.',
    category: 'morphology',
    options: [
      { value: 'head',      label: 'Head-marking',      frequency: 0.20 },
      { value: 'dependent', label: 'Dependent-marking', frequency: 0.40 },
      { value: 'double',    label: 'Double-marking',    frequency: 0.15 },
      { value: 'zero',      label: 'No marking',        frequency: 0.25 },
    ],
  },
  {
    key: 'polysynthesis',
    label: 'Polysynthesis',
    description: 'Degree to which a single word can encode a whole clause via affixation/noun-incorporation.',
    category: 'morphology',
    options: [
      { value: 'no',   label: 'Analytic / isolating', frequency: 0.55 },
      { value: 'some', label: 'Mildly synthetic',     frequency: 0.35 },
      { value: 'yes',  label: 'Polysynthetic',        frequency: 0.10 },
    ],
  },
  {
    key: 'gender',
    label: 'Grammatical gender',
    description: 'Noun class / gender system, if any.',
    category: 'morphology',
    options: [
      { value: 'none',           label: 'No gender',         frequency: 0.56 },
      { value: 'masc-fem',       label: 'Masculine–feminine', frequency: 0.13 },
      { value: 'masc-fem-neut',  label: 'Masc–fem–neuter',    frequency: 0.07 },
      { value: 'animate',        label: 'Animate–inanimate',  frequency: 0.08 },
      { value: 'noun-class',     label: 'Many noun classes',  frequency: 0.16 },
    ],
  },
  {
    key: 'definiteness',
    label: 'Definiteness marking',
    description: 'Whether definite reference is marked, and how.',
    category: 'morphology',
    options: [
      { value: 'none',    label: 'Unmarked',          frequency: 0.45 },
      { value: 'article', label: 'Definite article',  frequency: 0.40 },
      { value: 'affix',   label: 'Affix on the noun', frequency: 0.10 },
      { value: 'clitic',  label: 'Clitic',            frequency: 0.05 },
    ],
  },
  {
    key: 'clusivity',
    label: 'Clusivity (1pl)',
    description: 'Whether 1st-person plural distinguishes inclusive vs exclusive of the addressee.',
    category: 'morphology',
    options: [
      { value: 'no',  label: 'No clusivity',  frequency: 0.60 },
      { value: 'yes', label: 'Inclusive/exclusive', frequency: 0.40 },
    ],
  },

  // ── Semantics (TAM, evidentiality, classifiers) ──────────────────────────
  {
    key: 'tense',
    label: 'Tense system',
    description: 'How time reference is grammaticalised.',
    category: 'semantics',
    options: [
      { value: 'none',        label: 'No grammatical tense', frequency: 0.13 },
      { value: 'past-nonpast',label: 'Past vs non-past',     frequency: 0.34 },
      { value: 'past-pres-fut', label: 'Past–present–future', frequency: 0.40 },
      { value: 'many',        label: 'Multiple past/future degrees', frequency: 0.13 },
    ],
  },
  {
    key: 'aspect',
    label: 'Aspect system',
    description: 'Grammaticalised aspectual contrasts.',
    category: 'semantics',
    options: [
      { value: 'none',        label: 'No grammatical aspect', frequency: 0.10 },
      { value: 'perf-imperf', label: 'Perfective vs imperfective', frequency: 0.55 },
      { value: 'progressive', label: 'Progressive vs other',  frequency: 0.20 },
      { value: 'rich',        label: 'Rich aspect system',    frequency: 0.15 },
    ],
  },
  {
    key: 'mood',
    label: 'Mood inventory',
    description: 'Number of grammatical moods distinguished on the verb.',
    category: 'semantics',
    options: [
      { value: 'indicative-only', label: 'Indicative only', frequency: 0.25 },
      { value: 'subjunctive',     label: 'Indicative + subjunctive', frequency: 0.45 },
      { value: 'many',            label: 'Many moods',      frequency: 0.30 },
    ],
  },
  {
    key: 'evidentiality',
    label: 'Evidentiality',
    description: 'Whether the verb obligatorily marks the source of information.',
    category: 'semantics',
    options: [
      { value: 'none',   label: 'Unmarked',     frequency: 0.75 },
      { value: 'marked', label: 'Grammaticalised evidentials', frequency: 0.25 },
    ],
  },
  {
    key: 'animacy',
    label: 'Animacy hierarchy',
    description: 'Whether an animacy hierarchy conditions case, agreement, or word order.',
    category: 'semantics',
    options: [
      { value: 'no',  label: 'Not active', frequency: 0.70 },
      { value: 'yes', label: 'Active',     frequency: 0.30 },
    ],
  },
  {
    key: 'classifiers',
    label: 'Numeral classifiers',
    description: 'Whether counting nouns requires a sortal classifier.',
    category: 'semantics',
    options: [
      { value: 'no',  label: 'No classifiers', frequency: 0.78 },
      { value: 'yes', label: 'Classifier system', frequency: 0.22 },
    ],
  },

  // ── Phonology ───────────────────────────────────────────────────────────
  {
    key: 'tone',
    label: 'Tone',
    description: 'Use of pitch to distinguish lexical items.',
    category: 'phonology',
    options: [
      { value: 'none',    label: 'No tone',            frequency: 0.58 },
      { value: '2-level', label: 'Two-level tone',     frequency: 0.18 },
      { value: '3-level', label: 'Three-level tone',   frequency: 0.10 },
      { value: 'contour', label: 'Contour-tone system', frequency: 0.14 },
    ],
  },
  {
    key: 'vowel_harmony',
    label: 'Vowel harmony',
    description: 'Phonological agreement of vowel features across the word.',
    category: 'phonology',
    options: [
      { value: 'none',      label: 'No harmony', frequency: 0.80 },
      { value: 'front-back', label: 'Front/back harmony', frequency: 0.08 },
      { value: 'height',    label: 'Height harmony',  frequency: 0.04 },
      { value: 'round',     label: 'Roundness harmony', frequency: 0.04 },
      { value: 'atr',       label: 'ATR / tongue-root harmony', frequency: 0.04 },
    ],
  },
  {
    key: 'syllable',
    label: 'Syllable structure',
    description: 'Most complex syllable shape the phonotactics permits.',
    category: 'phonology',
    options: [
      { value: 'cv',      label: 'CV only',         frequency: 0.10 },
      { value: 'cvc',     label: 'CVC',             frequency: 0.30 },
      { value: 'ccvcc',   label: 'Up to CCVCC',     frequency: 0.40 },
      { value: 'complex', label: 'Very complex onsets/codas', frequency: 0.20 },
    ],
  },
  {
    key: 'consonant_inventory',
    label: 'Consonant inventory size',
    description: 'Coarse size class of the consonant inventory.',
    category: 'phonology',
    options: [
      { value: 'small',   label: 'Small (< 15)',   frequency: 0.25 },
      { value: 'average', label: 'Average (15–25)', frequency: 0.50 },
      { value: 'large',   label: 'Large (> 25)',    frequency: 0.25 },
    ],
  },
  {
    key: 'vowel_inventory',
    label: 'Vowel inventory size',
    description: 'Coarse size class of the vowel inventory.',
    category: 'phonology',
    options: [
      { value: 'small',   label: 'Small (≤ 4)',   frequency: 0.30 },
      { value: 'average', label: 'Average (5–6)', frequency: 0.50 },
      { value: 'large',   label: 'Large (≥ 7)',   frequency: 0.20 },
    ],
  },
];

const FEATURE_INDEX: Map<string, TypologyFeature> = new Map(
  TYPOLOGY_FEATURES.map(f => [f.key, f]),
);

export function getTypologyFeature(key: string): TypologyFeature | undefined {
  return FEATURE_INDEX.get(key);
}

/**
 * Returns a list of human-readable problems with the given profile.
 * Empty list means the profile is valid (every key maps to a known feature
 * and every value is one of that feature's allowed options).
 */
export function validateProfile(profile: LanguageProfile): string[] {
  const problems: string[] = [];
  for (const [key, value] of Object.entries(profile)) {
    const feat = FEATURE_INDEX.get(key);
    if (!feat) {
      problems.push(`unknown feature: ${key}`);
      continue;
    }
    if (!feat.options.some(o => o.value === value)) {
      problems.push(`invalid option for ${key}: ${value}`);
    }
  }
  return problems;
}

/**
 * One-line headline summarising the most salient choices in the profile:
 * "SVO · nom-acc · gendered · tonal". Missing keys are simply skipped.
 */
export function profileSummary(profile: LanguageProfile): string {
  const parts: string[] = [];
  const wo = profile['word_order'];
  if (wo) parts.push(wo === 'free' ? 'free word order' : wo);
  const al = profile['alignment'];
  if (al) {
    const map: Record<string, string> = {
      'nom-acc': 'nom-acc',
      'erg-abs': 'erg-abs',
      'split-s': 'split-S',
      'tripartite': 'tripartite',
      'direct-inverse': 'direct-inverse',
      'neutral': 'neutral alignment',
    };
    parts.push(map[al] ?? al);
  }
  const g = profile['gender'];
  if (g && g !== 'none') {
    parts.push(g === 'noun-class' ? 'noun classes' : g === 'animate' ? 'animate/inanimate' : 'gendered');
  } else if (g === 'none') {
    parts.push('no gender');
  }
  const t = profile['tone'];
  if (t && t !== 'none') parts.push('tonal');
  else if (t === 'none') parts.push('no tone');
  const vh = profile['vowel_harmony'];
  if (vh && vh !== 'none') parts.push('vowel harmony');
  const poly = profile['polysynthesis'];
  if (poly === 'yes') parts.push('polysynthetic');
  return parts.join(' · ');
}

/** Curated presets approximating well-known natural languages. */
export const TYPOLOGY_PRESETS: Record<string, LanguageProfile> = {
  English: {
    word_order: 'SVO', adposition_order: 'preposition', genitive_order: 'gen-noun',
    alignment: 'nom-acc', head_marking: 'dependent', polysynthesis: 'no',
    gender: 'none', definiteness: 'article', clusivity: 'no',
    tense: 'past-pres-fut', aspect: 'perf-imperf', mood: 'subjunctive',
    evidentiality: 'none', animacy: 'no', classifiers: 'no',
    tone: 'none', vowel_harmony: 'none', syllable: 'complex',
    consonant_inventory: 'average', vowel_inventory: 'large',
  },
  Mandarin: {
    word_order: 'SVO', adposition_order: 'preposition', genitive_order: 'gen-noun',
    alignment: 'neutral', head_marking: 'zero', polysynthesis: 'no',
    gender: 'none', definiteness: 'none', clusivity: 'no',
    tense: 'none', aspect: 'perf-imperf', mood: 'indicative-only',
    evidentiality: 'none', animacy: 'no', classifiers: 'yes',
    tone: 'contour', vowel_harmony: 'none', syllable: 'cvc',
    consonant_inventory: 'average', vowel_inventory: 'average',
  },
  Turkish: {
    word_order: 'SOV', adposition_order: 'postposition', genitive_order: 'gen-noun',
    alignment: 'nom-acc', head_marking: 'double', polysynthesis: 'some',
    gender: 'none', definiteness: 'affix', clusivity: 'no',
    tense: 'past-pres-fut', aspect: 'perf-imperf', mood: 'many',
    evidentiality: 'marked', animacy: 'no', classifiers: 'no',
    tone: 'none', vowel_harmony: 'front-back', syllable: 'cvc',
    consonant_inventory: 'average', vowel_inventory: 'large',
  },
  Hawaiian: {
    word_order: 'VSO', adposition_order: 'preposition', genitive_order: 'noun-gen',
    alignment: 'nom-acc', head_marking: 'zero', polysynthesis: 'no',
    gender: 'none', definiteness: 'article', clusivity: 'yes',
    tense: 'past-nonpast', aspect: 'perf-imperf', mood: 'indicative-only',
    evidentiality: 'none', animacy: 'no', classifiers: 'no',
    tone: 'none', vowel_harmony: 'none', syllable: 'cv',
    consonant_inventory: 'small', vowel_inventory: 'average',
  },
  Japanese: {
    word_order: 'SOV', adposition_order: 'postposition', genitive_order: 'gen-noun',
    alignment: 'nom-acc', head_marking: 'dependent', polysynthesis: 'some',
    gender: 'none', definiteness: 'none', clusivity: 'no',
    tense: 'past-nonpast', aspect: 'perf-imperf', mood: 'many',
    evidentiality: 'marked', animacy: 'yes', classifiers: 'yes',
    tone: '2-level', vowel_harmony: 'none', syllable: 'cvc',
    consonant_inventory: 'average', vowel_inventory: 'small',
  },
  Spanish: {
    word_order: 'SVO', adposition_order: 'preposition', genitive_order: 'noun-gen',
    alignment: 'nom-acc', head_marking: 'double', polysynthesis: 'some',
    gender: 'masc-fem', definiteness: 'article', clusivity: 'no',
    tense: 'past-pres-fut', aspect: 'perf-imperf', mood: 'subjunctive',
    evidentiality: 'none', animacy: 'yes', classifiers: 'no',
    tone: 'none', vowel_harmony: 'none', syllable: 'ccvcc',
    consonant_inventory: 'average', vowel_inventory: 'small',
  },
  Welsh: {
    word_order: 'VSO', adposition_order: 'preposition', genitive_order: 'noun-gen',
    alignment: 'nom-acc', head_marking: 'head', polysynthesis: 'some',
    gender: 'masc-fem', definiteness: 'article', clusivity: 'no',
    tense: 'past-pres-fut', aspect: 'perf-imperf', mood: 'subjunctive',
    evidentiality: 'none', animacy: 'no', classifiers: 'no',
    tone: 'none', vowel_harmony: 'none', syllable: 'ccvcc',
    consonant_inventory: 'average', vowel_inventory: 'average',
  },
  Quechua: {
    word_order: 'SOV', adposition_order: 'postposition', genitive_order: 'gen-noun',
    alignment: 'nom-acc', head_marking: 'double', polysynthesis: 'yes',
    gender: 'none', definiteness: 'none', clusivity: 'yes',
    tense: 'past-pres-fut', aspect: 'perf-imperf', mood: 'many',
    evidentiality: 'marked', animacy: 'yes', classifiers: 'no',
    tone: 'none', vowel_harmony: 'none', syllable: 'cvc',
    consonant_inventory: 'average', vowel_inventory: 'small',
  },
};
