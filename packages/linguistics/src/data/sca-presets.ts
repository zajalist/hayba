/**
 * L26 — Historical sound-change presets.
 *
 * Drop-in rule stacks based on well-documented historical changes. Each
 * `rulesText` is Lexurgy-style and parses cleanly via `parseRules`. Some
 * entries are deliberate simplifications (noted in `description`) — full
 * implementations would need features the L5 engine doesn't model yet
 * (morphological boundaries, whole-word harmony, gradient aspiration).
 *
 * Citations point to Wikipedia for quick reading. They're not the original
 * primary sources but they're stable, free, and link out to the literature.
 */

export interface ScaPreset {
  name: string;
  family: string;
  era: string;
  description: string;
  /** Lexurgy-compatible text — directly fed into `parseRules`. */
  rulesText: string;
  /** Wikipedia URL or paper reference. */
  citation: string;
}

export const SCA_PRESETS: ScaPreset[] = [
  {
    name: "Grimm's law",
    family: 'Germanic',
    era: '~1st millennium BCE',
    description:
      "Proto-Indo-European stops shifted: voiceless stops became fricatives, voiced stops devoiced, voiced aspirates lost aspiration. The classic 'not after s' exception (e.g. *spek- stays /sp/) is not modelled — the engine treats every /p t k/ uniformly.",
    rulesText: [
      "// Grimm's law (PIE → Proto-Germanic)",
      '// Note: the "not after /s/" environment is omitted — apply rules to roots',
      '// where the relevant stops are not preceded by /s/.',
      'p > f',
      't > θ',
      'k > x',
      'b > p',
      'd > t',
      'g > k',
      'bʰ > b',
      'dʰ > d',
      'gʰ > g',
    ].join('\n'),
    citation: 'https://en.wikipedia.org/wiki/Grimm%27s_law',
  },
  {
    name: 'Great Vowel Shift',
    family: 'Germanic',
    era: '15th–18th century CE',
    description:
      'Middle English long vowels raised one step; the two highest diphthongised. Captures the canonical seven-step shift; intermediate stages and dialect variation are flattened.',
    rulesText: [
      '// Great Vowel Shift (Middle English → Early Modern English)',
      'iː > aɪ',
      'uː > aʊ',
      'eː > iː',
      'oː > uː',
      'aː > eː',
      'ɛː > eː',
      'ɔː > oː',
    ].join('\n'),
    citation: 'https://en.wikipedia.org/wiki/Great_Vowel_Shift',
  },
  {
    name: 'Romance lenition',
    family: 'Romance',
    era: '1st–8th century CE',
    description:
      'Intervocalic voiceless stops voiced, voiced stops spirantised. Classic Western Romance pattern shared by Spanish, Portuguese, Catalan, and parts of Italian.',
    rulesText: [
      '// Romance intervocalic lenition (Latin → Western Romance)',
      'p > b / [V] _ [V]',
      't > d / [V] _ [V]',
      'k > g / [V] _ [V]',
      'b > β / [V] _ [V]',
      'd > ð / [V] _ [V]',
      'g > ɣ / [V] _ [V]',
    ].join('\n'),
    citation: 'https://en.wikipedia.org/wiki/Lenition#Romance_languages',
  },
  {
    name: 'Slavic first palatalization',
    family: 'Slavic',
    era: '~3rd–5th century CE',
    description:
      'Velar consonants /k g x/ shifted to postalveolars before front vowels. Requires a registered `front` class containing /i e ɛ æ/ (and historically also reconstructed /ь/).',
    rulesText: [
      '// First Slavic palatalization (Proto-Slavic)',
      '// Requires class: front = i e ɛ æ',
      'k > tʃ / _ [front]',
      'g > dʒ / _ [front]',
      'x > ʃ / _ [front]',
    ].join('\n'),
    citation: 'https://en.wikipedia.org/wiki/Slavic_first_palatalization',
  },
  {
    name: 'High German consonant shift',
    family: 'Germanic',
    era: '5th–8th century CE',
    description:
      'Second Germanic consonant shift, defining Old High German. Voiceless stops affricated word-initially and after consonants, spirantised intervocalically.',
    rulesText: [
      '// High German consonant shift (West Germanic → Old High German)',
      'p > pf / # _',
      't > ts / # _',
      'k > kx / # _',
      'p > f / [V] _ [V]',
      't > s / [V] _ [V]',
      'k > x / [V] _ [V]',
    ].join('\n'),
    citation: 'https://en.wikipedia.org/wiki/High_German_consonant_shift',
  },
  {
    name: 'Polynesian k-loss',
    family: 'Polynesian',
    era: '~12th–18th century CE',
    description:
      'Proto-Polynesian /k/ became glottal stop /ʔ/ in Hawaiian (and several sister languages). Single-rule, unconditional change.',
    rulesText: [
      '// Hawaiian k-loss (Proto-Polynesian → Hawaiian)',
      'k > ʔ',
    ].join('\n'),
    citation: 'https://en.wikipedia.org/wiki/Hawaiian_language#Phonology',
  },
  {
    name: "Grassmann's law",
    family: 'Hellenic / Indo-Iranian',
    era: 'Pre-classical (≥ 1st millennium BCE)',
    description:
      'When two aspirates appeared in adjacent syllables of a root, the first deaspirated (Greek θρίξ / τριχός). The engine has no notion of "another aspirate later in the word", so this preset is a simplification: it strips aspiration from voiced aspirates unconditionally. Treat as illustrative.',
    rulesText: [
      "// Grassmann's law — simplified (Greek / Sanskrit)",
      '// Real rule: deaspirate the first of two aspirates in a root.',
      '// Engine simplification: deaspirate unconditionally.',
      'bʰ > b',
      'dʰ > d',
      'gʰ > g',
      'pʰ > p',
      'tʰ > t',
      'kʰ > k',
    ].join('\n'),
    citation: 'https://en.wikipedia.org/wiki/Grassmann%27s_law',
  },
  {
    name: 'Sanskrit RUKI',
    family: 'Indo-Iranian / Balto-Slavic',
    era: 'Late Proto-Indo-European',
    description:
      '/s/ retracted to retroflex /ʂ/ after /r u k i/. Requires a registered `ruki` class containing those four segments.',
    rulesText: [
      '// RUKI rule (Proto-Indo-Iranian and Balto-Slavic)',
      '// Requires class: ruki = r u k i',
      's > ʂ / [ruki] _',
    ].join('\n'),
    citation: 'https://en.wikipedia.org/wiki/Ruki_sound_law',
  },
  {
    name: 'Turkish vowel harmony (simplified)',
    family: 'Turkic',
    era: 'Synchronic (modern)',
    description:
      'Real Turkish harmony spreads vowel backness across the whole word; the L5 engine only sees one segment of context, so this preset just backs /i/ to /ɯ/ when immediately preceded by a back vowel. Requires a registered `back` class.',
    rulesText: [
      '// Turkish vowel harmony — simplified',
      '// Real: backness spreads across the whole word.',
      '// Here: i → ɯ when the previous vowel is back.',
      '// Requires class: back = a ɯ o u',
      'i > ɯ / [back] _',
      'e > a / [back] _',
    ].join('\n'),
    citation: 'https://en.wikipedia.org/wiki/Turkish_phonology#Vowel_harmony',
  },
  {
    name: 'French nasalization',
    family: 'Romance',
    era: '10th–16th century CE',
    description:
      'Old French vowels nasalised before a nasal consonant in the same syllable; the nasal then often deleted. Simplified to two rules covering the most common /aN#/ outcome.',
    rulesText: [
      '// French nasalization (Old French → Modern French)',
      '// Two-step: delete word-final /n/ after /a/, then nasalise the bare /a/.',
      'n > 0 / a _ #',
      'a > ɑ̃ / _ #',
    ].join('\n'),
    citation: 'https://en.wikipedia.org/wiki/Phonological_history_of_French#Nasalization',
  },
  {
    name: 'Japanese rendaku (approximation)',
    family: 'Japonic',
    era: 'Old Japanese onward',
    description:
      'Second element of a compound voices its initial obstruent (yama + sakura → yamazakura). Genuine rendaku needs a morphological compound boundary the engine does not track; this preset just shows /k t s/ → /g d z/ word-medially after a vowel.',
    rulesText: [
      '// Japanese rendaku — approximation',
      '// Real: triggered at compound boundary; we approximate with V _ context.',
      'k > g / [V] _',
      't > d / [V] _',
      's > z / [V] _',
    ].join('\n'),
    citation: 'https://en.wikipedia.org/wiki/Rendaku',
  },
  {
    name: 'Mandarin n/ŋ merger',
    family: 'Sino-Tibetan',
    era: 'Modern colloquial (20th–21st century)',
    description:
      'Word-final /n/ neutralises to /ŋ/ in many southern Mandarin varieties (and the reverse direction in others). Single rule, word-final only.',
    rulesText: [
      '// Mandarin colloquial n/ŋ merger',
      'n > ŋ / _ #',
    ].join('\n'),
    citation: 'https://en.wikipedia.org/wiki/Standard_Chinese_phonology#Finals',
  },
];
