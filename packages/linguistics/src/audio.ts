/**
 * L1 — Sampled IPA audio resolver.
 *
 * Maps every chart phoneme to its Wikimedia Commons IPA recording (CC-BY-SA
 * 4.0) via the Special:FilePath redirector. Off-chart phonemes return `null`.
 */

import {
  PULMONIC_CONSONANTS, NON_PULMONIC_CONSONANTS, CARDINAL_VOWELS,
} from './ipa-chart.js';
import type { PulmonicConsonant, CardinalVowel } from './ipa-chart.js';

const COMMONS_FILEPATH = 'https://commons.wikimedia.org/wiki/Special:FilePath/';

const MANNER_NOUN: Record<string, string> = {
  plosive: 'plosive',
  nasal: 'nasal',
  trill: 'trill',
  tap: 'flap',
  'lateral-tap': 'lateral_flap',
  fricative: 'fricative',
  'sibilant-fricative': 'fricative',
  'lateral-fricative': 'lateral_fricative',
  approximant: 'approximant',
  'lateral-approximant': 'lateral_approximant',
  affricate: 'affricate',
  click: 'click',
  implosive: 'implosive',
  ejective: 'ejective',
};

function cap(s: string): string {
  return s.length === 0 ? s : s[0]!.toUpperCase() + s.slice(1);
}

function consonantFilename(c: PulmonicConsonant): string | null {
  const voicing = c.voicing === 'voiced' ? 'Voiced' : 'Voiceless';
  const manner = MANNER_NOUN[c.manner];
  if (!manner) return null;
  return `${voicing}_${c.place}_${manner}.ogg`;
}

function vowelFilename(v: CardinalVowel): string | null {
  // Commons uses "Close_front_unrounded_vowel.ogg" / "Open-mid_back_rounded_vowel.ogg".
  return `${cap(v.height)}_${v.backness}_${v.roundness}_vowel.ogg`;
}

function buildCatalogue(): Map<string, string> {
  const out = new Map<string, string>();
  for (const c of [...PULMONIC_CONSONANTS, ...NON_PULMONIC_CONSONANTS]) {
    const fn = consonantFilename(c);
    if (fn) out.set(c.ipa, `${COMMONS_FILEPATH}${fn}`);
  }
  for (const v of CARDINAL_VOWELS) {
    const fn = vowelFilename(v);
    if (fn) out.set(v.ipa, `${COMMONS_FILEPATH}${fn}`);
  }
  // Special-cases where Commons uses a non-derivable filename.
  out.set('ə', `${COMMONS_FILEPATH}Mid-central_vowel.ogg`);
  return out;
}

const AUDIO_CATALOGUE = buildCatalogue();

export function audioUrlFor(ipa: string): string | null {
  return AUDIO_CATALOGUE.get(ipa) ?? null;
}

export function audioCatalogueKeys(): string[] {
  return [...AUDIO_CATALOGUE.keys()];
}
