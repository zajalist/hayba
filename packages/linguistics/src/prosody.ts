/**
 * L27 — Stress + tone engines.
 *
 * Operates on already-syllabified words (each syllable is a list of phoneme
 * IPA tokens). The engine is pure: callers handle syllabification (typically
 * via L2 `validatePhonotactics`) and render the chosen stress/tone marks
 * onto surface forms.
 *
 * Stress rules are either fixed-position or weight-sensitive. Tone rules are
 * a priority-sorted list of conditions; an optional sandhi pass rewrites
 * adjacent tone pairs left-to-right (e.g. Mandarin 3rd-tone sandhi).
 */

import type { Phonology } from './phonology.js';

/* ───────────────────── Stress ───────────────────── */

export type StressRule =
  | { kind: 'none' }
  | { kind: 'fixed'; position: 'initial' | 'penultimate' | 'antepenultimate' | 'final' }
  | { kind: 'weight-sensitive'; heavyDefinedBy: 'closed-syllable' | 'long-vowel' | 'closed-or-long' };

const LONG_DIACRITIC = 'ː'; // ː

function isVowelToken(tok: string, phonology?: Phonology): boolean {
  if (phonology) {
    const ph = phonology.phonemes.find(p => p.ipa === tok);
    if (ph) {
      const f = ph.features;
      return ('height' in f) || ('backness' in f) || f.kind === 'vowel';
    }
  }
  // Fallback: strip length/diacritics and check a small cardinal-vowel set
  const base = tok.replace(/[ːːʼ]/g, '');
  return /^[aeiouɑɐəɛɪɔʊʌyøœæɨʉɯɤ]+$/.test(base);
}

function syllableHasCoda(syl: string[], phonology?: Phonology): boolean {
  // Coda = any consonant token after the last vowel.
  let lastVowel = -1;
  for (let i = 0; i < syl.length; i++) {
    if (isVowelToken(syl[i]!, phonology)) lastVowel = i;
  }
  if (lastVowel < 0) return false;
  return lastVowel < syl.length - 1;
}

function syllableHasLongVowel(syl: string[], phonology?: Phonology): boolean {
  for (const tok of syl) {
    if (!isVowelToken(tok, phonology)) continue;
    if (tok.includes(LONG_DIACRITIC)) return true;
    if (phonology) {
      const ph = phonology.phonemes.find(p => p.ipa === tok);
      if (ph && ph.features.length === 'long') return true;
    }
  }
  return false;
}

function isHeavy(
  syl: string[],
  criterion: 'closed-syllable' | 'long-vowel' | 'closed-or-long',
  phonology?: Phonology,
): boolean {
  switch (criterion) {
    case 'closed-syllable': return syllableHasCoda(syl, phonology);
    case 'long-vowel':      return syllableHasLongVowel(syl, phonology);
    case 'closed-or-long':  return syllableHasCoda(syl, phonology) || syllableHasLongVowel(syl, phonology);
  }
}

/**
 * Pick the index of the stressed syllable, or `null` when the rule is `none`
 * or unreachable for the input (empty word).
 *
 * Antepenultimate falls back to penultimate (then to initial) when the word
 * is too short.
 */
export function assignStress(
  syllables: string[][],
  rule: StressRule,
  phonology?: Phonology,
): number | null {
  if (rule.kind === 'none') return null;
  const n = syllables.length;
  if (n === 0) return null;
  if (rule.kind === 'fixed') {
    switch (rule.position) {
      case 'initial':         return 0;
      case 'final':           return n - 1;
      case 'penultimate':     return n >= 2 ? n - 2 : 0;
      case 'antepenultimate': {
        if (n >= 3) return n - 3;
        if (n >= 2) return n - 2; // fall back to penultimate
        return 0;                  // fall back to initial
      }
    }
  }
  // weight-sensitive
  let pick = -1;
  for (let i = n - 1; i >= 0; i--) {
    if (isHeavy(syllables[i]!, rule.heavyDefinedBy, phonology)) { pick = i; break; }
  }
  if (pick >= 0) return pick;
  return n >= 2 ? n - 2 : 0; // fall back to penultimate
}

/* ───────────────────── Tone ───────────────────── */

export type Tone = 'H' | 'M' | 'L' | 'HL' | 'LH' | 'HLH';

export interface ToneRule {
  condition: { position?: 'initial' | 'final' | 'penultimate'; phoneme?: string };
  tone: Tone;
  priority?: number;
}

export interface ToneSandhi {
  /** When tone A precedes tone B... */
  pattern: [Tone, Tone];
  /** ...A becomes this. */
  result: Tone;
}

const TONE_LETTERS: Record<Tone, string> = {
  H:   '˥',           // ˥
  M:   '˧',           // ˧
  L:   '˩',           // ˩
  HL:  '˥˩',     // ˥˩
  LH:  '˩˥',     // ˩˥
  HLH: '˥˩˥', // ˥˩˥
};

export function toneToLetters(t: Tone): string { return TONE_LETTERS[t]; }

function ruleMatches(
  rule: ToneRule,
  syllable: string[],
  idx: number,
  total: number,
): boolean {
  const c = rule.condition;
  if (c.position) {
    if (c.position === 'initial' && idx !== 0) return false;
    if (c.position === 'final' && idx !== total - 1) return false;
    if (c.position === 'penultimate' && idx !== total - 2) return false;
  }
  if (c.phoneme) {
    if (!syllable.includes(c.phoneme)) return false;
  }
  return true;
}

/**
 * Assign a tone to each syllable. Highest-priority matching rule wins; ties
 * are broken by rule-list order. Sandhi rules are applied left-to-right
 * after initial assignment; each pair only fires once per position.
 */
export function applyTones(
  syllables: string[][],
  toneRules: ToneRule[],
  sandhi: ToneSandhi[],
): Array<{ syllable: string[]; tone: Tone | null }> {
  const tones: Array<Tone | null> = syllables.map((syl, i) => {
    let best: { tone: Tone; priority: number; order: number } | null = null;
    for (let r = 0; r < toneRules.length; r++) {
      const rule = toneRules[r]!;
      if (!ruleMatches(rule, syl, i, syllables.length)) continue;
      const pr = rule.priority ?? 0;
      if (!best || pr > best.priority) {
        best = { tone: rule.tone, priority: pr, order: r };
      }
      // Ties: lower order (earlier in list) wins, which is already preserved
      // because we use strict `>`.
    }
    return best ? best.tone : null;
  });
  if (sandhi.length) {
    for (let i = 0; i < tones.length - 1; i++) {
      const a = tones[i]; const b = tones[i + 1];
      if (a == null || b == null) continue;
      for (const s of sandhi) {
        if (s.pattern[0] === a && s.pattern[1] === b) {
          tones[i] = s.result;
          break;
        }
      }
    }
  }
  return syllables.map((syl, i) => ({ syllable: syl, tone: tones[i] ?? null }));
}
