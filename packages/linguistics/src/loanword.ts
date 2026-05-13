/**
 * L20 — Loanword adapter.
 *
 * Given an input word in IPA or romanized Latin, produce a phonotactically-
 * legal version in the target conlang. Two phases:
 *   1. Tokenise input → IPA phoneme stream.
 *   2. Substitute out-of-inventory phonemes by feature distance.
 *   3. Walk syllables, insert epenthetic vowels to fix illegal clusters.
 *   4. Fix terminal clusters via paragoge or (last resort) deletion.
 *   5. Re-validate; iterate up to MAX_REPAIR_ITERS before bailing.
 *
 * The audit trail captures every transformation as a human-readable
 * AdaptationStep so the UI can show "why" — substituted X→Y, inserted vowel
 * to break cluster Z, etc.
 */

import {
  PULMONIC_CONSONANTS, NON_PULMONIC_CONSONANTS, CARDINAL_VOWELS,
  type PulmonicConsonant, type CardinalVowel,
} from './ipa-chart.js';
import type { Phonology, Phoneme } from './phonology.js';
import type { PhonotacticSpec } from './phonotactics.js';
import { passesPhonotactics, validatePhonotactics } from './phonotactics.js';
import { romanize, type RomanizationMap } from './romanization.js';

export interface AdaptationStep {
  kind: 'substitute' | 'insert-vowel' | 'delete' | 'transpose';
  before: string;
  after: string;
  reason: string;
}

export interface AdaptedLoanword {
  source: string;
  sourceIpa: string;
  adapted: string;
  romanized?: string;
  steps: AdaptationStep[];
}

export interface LoanwordAdapter {
  adapt(word: string): AdaptedLoanword;
}

export interface LoanwordAdapterOptions {
  /** Direct (input IPA phoneme) → (output IPA phoneme) overrides; bypass feature distance. */
  substitutionTable?: Record<string, string>;
  romanization?: RomanizationMap;
}

const MAX_REPAIR_ITERS = 5;

/* ── 1.  English-graphemes → IPA fallback ─────────────────────────────── */

/** Pragmatic English-style grapheme → IPA table, applied longest-first. */
const ENGLISH_GRAPHEME_TO_IPA: Array<[string, string]> = [
  // Trigraphs
  ['tch', 't͡ʃ'],
  // Common digraphs
  ['ch', 't͡ʃ'], ['sh', 'ʃ'], ['th', 'θ'], ['ph', 'f'], ['gh', ''], // 'gh' silent default
  ['ck', 'k'], ['ng', 'ŋ'], ['qu', 'kw'], ['wh', 'w'], ['wr', 'r'],
  ['kn', 'n'], ['ps', 's'],
  // Vowel digraphs
  ['oo', 'uː'], ['ee', 'iː'], ['ea', 'iː'], ['ai', 'eɪ'], ['ay', 'eɪ'],
  ['oa', 'oʊ'], ['oe', 'oʊ'], ['ow', 'aʊ'], ['ou', 'aʊ'], ['au', 'ɔː'],
  ['aw', 'ɔː'], ['oi', 'ɔɪ'], ['oy', 'ɔɪ'], ['ie', 'iː'], ['ei', 'eɪ'],
  ['ue', 'uː'], ['ui', 'uː'], ['eu', 'juː'], ['ew', 'juː'], ['er', 'ər'],
  // Single graphemes
  ['a', 'æ'], ['b', 'b'], ['c', 'k'], ['d', 'd'], ['e', 'ɛ'],
  ['f', 'f'], ['g', 'ɡ'], ['h', 'h'], ['i', 'ɪ'], ['j', 'd͡ʒ'],
  ['k', 'k'], ['l', 'l'], ['m', 'm'], ['n', 'n'], ['o', 'ɑ'],
  ['p', 'p'], ['q', 'k'], ['r', 'r'], ['s', 's'], ['t', 't'],
  ['u', 'ʌ'], ['v', 'v'], ['w', 'w'], ['x', 'ks'], ['y', 'j'],
  ['z', 'z'],
];

/** Universal IPA inventory (everything the chart catalogues). */
function universalIpaSymbols(): string[] {
  return [
    ...PULMONIC_CONSONANTS.map(c => c.ipa),
    ...NON_PULMONIC_CONSONANTS.map(c => c.ipa),
    ...CARDINAL_VOWELS.map(v => v.ipa),
    // Common diacritic-bearing forms we emit from the English table
    'uː', 'iː', 'eɪ', 'oʊ', 'aʊ', 'ɔː', 'ɔɪ', 'juː', 'ər',
  ];
}

const UNIVERSAL_IPA_SET = new Set(universalIpaSymbols());

/** Heuristic: does the input look like IPA (any non-ASCII letter or known IPA-only symbol)? */
function looksLikeIpa(word: string): boolean {
  // Non-ASCII chars or characters in our chart's symbol set beyond plain Latin a-z.
  for (const ch of word.normalize('NFC')) {
    const code = ch.codePointAt(0)!;
    if (code > 127) return true;
    // Chart-only ASCII symbols like ʔ are >127 anyway. Plain a-z falls through.
  }
  return false;
}

/** Greedy-longest tokenization against a sorted symbol list. */
function greedyTokenize(word: string, symbols: string[]): string[] {
  const sorted = [...symbols].sort((a, b) => b.length - a.length);
  const out: string[] = [];
  const src = word.normalize('NFC');
  let i = 0;
  while (i < src.length) {
    let hit: string | undefined;
    for (const s of sorted) {
      if (s.length > 0 && src.startsWith(s, i)) { hit = s; break; }
    }
    if (hit) { out.push(hit); i += hit.length; }
    else {
      // Unknown char — skip silently rather than crash (spaces, hyphens, etc.).
      i++;
    }
  }
  return out;
}

/** Tokenize Latin input via the English-graphemes fallback table. */
function tokenizeLatin(word: string): string[] {
  const lower = word.toLowerCase().normalize('NFC');
  const out: string[] = [];
  let i = 0;
  while (i < lower.length) {
    const ch = lower[i]!;
    if (!/[a-z]/.test(ch)) { i++; continue; }
    let hit: [string, string] | undefined;
    for (const pair of ENGLISH_GRAPHEME_TO_IPA) {
      if (lower.startsWith(pair[0], i)) { hit = pair; break; }
    }
    if (hit) {
      if (hit[1]) out.push(...greedyTokenize(hit[1], universalIpaSymbols()));
      i += hit[0].length;
    } else {
      i++; // unknown char
    }
  }
  return out;
}

/** Tokenize input — IPA-mode if it has non-ASCII chars, else English-Latin. */
function tokenizeInput(word: string, inventoryIpa?: Set<string>): { tokens: string[]; ipa: string } {
  // Pre-check: if the input fully tokenises against the *target* inventory as
  // IPA, treat it as already-IPA. This lets "paka" against a {p,a,k} inventory
  // pass straight through with no English-grapheme substitution noise.
  if (inventoryIpa && inventoryIpa.size > 0) {
    const trial = greedyTokenizeStrict(word, [...inventoryIpa]);
    if (trial) return { tokens: trial, ipa: trial.join('') };
  }
  const tokens = looksLikeIpa(word)
    ? greedyTokenize(word, universalIpaSymbols())
    : tokenizeLatin(word);
  return { tokens, ipa: tokens.join('') };
}

/** Like greedyTokenize but returns null if any character can't be matched. */
function greedyTokenizeStrict(word: string, symbols: string[]): string[] | null {
  const sorted = [...symbols].sort((a, b) => b.length - a.length);
  const out: string[] = [];
  const src = word.normalize('NFC');
  let i = 0;
  while (i < src.length) {
    let hit: string | undefined;
    for (const s of sorted) {
      if (s.length > 0 && src.startsWith(s, i)) { hit = s; break; }
    }
    if (!hit) return null;
    out.push(hit);
    i += hit.length;
  }
  return out;
}

/* ── 2.  Feature-distance substitution ────────────────────────────────── */

interface ConsonantFeat { kind: 'C'; place: string; manner: string; voicing: string; ipa: string }
interface VowelFeat     { kind: 'V'; height: string; backness: string; roundness: string; ipa: string }
type ChartFeat = ConsonantFeat | VowelFeat;

function chartLookup(ipa: string): ChartFeat | undefined {
  const c = [...PULMONIC_CONSONANTS, ...NON_PULMONIC_CONSONANTS].find(p => p.ipa === ipa);
  if (c) return { kind: 'C', place: c.place, manner: c.manner, voicing: c.voicing, ipa: c.ipa };
  const v = CARDINAL_VOWELS.find(p => p.ipa === ipa);
  if (v) return { kind: 'V', height: v.height, backness: v.backness, roundness: v.roundness, ipa: v.ipa };
  // English-table outputs like 'uː', 'eɪ': strip length mark and diphthong glide.
  if (ipa.endsWith('ː')) return chartLookup(ipa.slice(0, -1));
  if (ipa.length === 2) return chartLookup(ipa[0]!) ?? chartLookup(ipa[1]!);
  return undefined;
}

function phonemeFeat(p: Phoneme): ChartFeat | undefined {
  if ('manner' in p.features || 'place' in p.features) {
    return {
      kind: 'C',
      place: p.features.place ?? '',
      manner: p.features.manner ?? '',
      voicing: p.features.voicing ?? 'voiceless',
      ipa: p.ipa,
    };
  }
  if ('height' in p.features || 'backness' in p.features) {
    return {
      kind: 'V',
      height: p.features.height ?? '',
      backness: p.features.backness ?? '',
      roundness: p.features.roundness ?? 'unrounded',
      ipa: p.ipa,
    };
  }
  return chartLookup(p.ipa);
}

function featDistance(a: ChartFeat, b: ChartFeat): number {
  if (a.kind !== b.kind) return Infinity;
  if (a.kind === 'C' && b.kind === 'C') {
    return (a.place === b.place ? 0 : 1)
         + (a.manner === b.manner ? 0 : 1)
         + (a.voicing === b.voicing ? 0 : 1);
  }
  if (a.kind === 'V' && b.kind === 'V') {
    return (a.height === b.height ? 0 : 1)
         + (a.backness === b.backness ? 0 : 1)
         + (a.roundness === b.roundness ? 0 : 1);
  }
  return Infinity;
}

function describePhoneme(f: ChartFeat): string {
  if (f.kind === 'C') return `${f.voicing} ${f.place} ${f.manner.replace(/-/g, ' ')}`;
  return `${f.height} ${f.backness} ${f.roundness} vowel`;
}

/** Find the closest in-inventory phoneme by feature distance. */
function closestInInventory(
  input: ChartFeat,
  candidates: { phoneme: Phoneme; feat: ChartFeat }[],
): { phoneme: Phoneme; feat: ChartFeat } | undefined {
  let best: { phoneme: Phoneme; feat: ChartFeat } | undefined;
  let bestDist = Infinity;
  for (const c of candidates) {
    const d = featDistance(input, c.feat);
    if (d < bestDist) { best = c; bestDist = d; }
  }
  return best;
}

/* ── 3.  Vowel selection for epenthesis ───────────────────────────────── */

/** Pick the most schwa-like vowel in the inventory, fallback to first vowel. */
function pickEpentheticVowel(phonology: Phonology): string | undefined {
  const vowels = phonology.phonemes
    .map(p => ({ p, f: phonemeFeat(p) }))
    .filter((x): x is { p: Phoneme; f: VowelFeat } => x.f?.kind === 'V');
  if (vowels.length === 0) return undefined;
  // Closest to schwa (mid central unrounded)
  const schwa: VowelFeat = { kind: 'V', height: 'mid', backness: 'central', roundness: 'unrounded', ipa: 'ə' };
  let best = vowels[0]!;
  let bestDist = featDistance(schwa, best.f);
  for (const v of vowels.slice(1)) {
    const d = featDistance(schwa, v.f);
    if (d < bestDist) { best = v; bestDist = d; }
  }
  return best.p.ipa;
}

/* ── 4.  Main adapter ─────────────────────────────────────────────────── */

export function createLoanwordAdapter(
  phonology: Phonology,
  phonotactics: PhonotacticSpec,
  options: LoanwordAdapterOptions = {},
): LoanwordAdapter {
  const vowelSet = new Set(phonotactics.vowels);
  const inventoryByIpa = new Map(phonology.phonemes.map(p => [p.ipa, p]));
  const consonantCandidates: { phoneme: Phoneme; feat: ChartFeat }[] = [];
  const vowelCandidates: { phoneme: Phoneme; feat: ChartFeat }[] = [];
  for (const p of phonology.phonemes) {
    const f = phonemeFeat(p);
    if (!f) continue;
    if (f.kind === 'C') consonantCandidates.push({ phoneme: p, feat: f });
    else vowelCandidates.push({ phoneme: p, feat: f });
  }

  function substituteOne(ipa: string): { out: string; step?: AdaptationStep } {
    // Direct override?
    const override = options.substitutionTable?.[ipa];
    if (override !== undefined) {
      if (override === ipa) return { out: ipa };
      return {
        out: override,
        step: {
          kind: 'substitute', before: ipa, after: override,
          reason: `${ipa} → ${override} (via substitution table)`,
        },
      };
    }
    if (inventoryByIpa.has(ipa)) return { out: ipa };
    const feat = chartLookup(ipa);
    if (!feat) {
      // Unknown to chart — drop it (last-resort).
      return {
        out: '',
        step: {
          kind: 'delete', before: ipa, after: '',
          reason: `${ipa} not recognized in the IPA chart and not in inventory — dropped`,
        },
      };
    }
    const pool = feat.kind === 'C' ? consonantCandidates : vowelCandidates;
    const closest = closestInInventory(feat, pool);
    if (!closest) {
      return {
        out: '',
        step: {
          kind: 'delete', before: ipa, after: '',
          reason: `no ${feat.kind === 'C' ? 'consonant' : 'vowel'} in inventory to substitute for ${ipa} — dropped`,
        },
      };
    }
    return {
      out: closest.phoneme.ipa,
      step: {
        kind: 'substitute', before: ipa, after: closest.phoneme.ipa,
        reason: `${ipa} (${describePhoneme(feat)}) not in inventory → closest is ${closest.phoneme.ipa} (${describePhoneme(closest.feat)})`,
      },
    };
  }

  function isConsonant(ipa: string): boolean {
    if (vowelSet.has(ipa)) return false;
    const f = chartLookup(ipa);
    if (f) return f.kind === 'C';
    const p = inventoryByIpa.get(ipa);
    return p ? (phonemeFeat(p)?.kind === 'C') : false;
  }

  function adapt(word: string): AdaptedLoanword {
    const trimmed = (word ?? '').trim();
    if (!trimmed) throw new Error('hayba: cannot adapt an empty input');

    const steps: AdaptationStep[] = [];
    const inventoryIpaSet = new Set(phonology.phonemes.map(p => p.ipa));
    const { tokens: rawTokens, ipa: sourceIpa } = tokenizeInput(trimmed, inventoryIpaSet);
    if (rawTokens.length === 0) {
      throw new Error(`hayba: input "${word}" produced no phonemes`);
    }

    // Phase 1 — substitute out-of-inventory phonemes.
    let tokens: string[] = [];
    for (const t of rawTokens) {
      const { out, step } = substituteOne(t);
      if (step) steps.push(step);
      if (out) tokens.push(out);
    }

    // Already legal? short-circuit.
    if (tokens.length > 0 && passesPhonotactics(tokens.join(''), phonology, phonotactics)) {
      return finalize(trimmed, sourceIpa, tokens, steps);
    }

    const epen = pickEpentheticVowel(phonology);

    // Phase 2 — cluster repair via epenthesis.
    for (let iter = 0; iter < MAX_REPAIR_ITERS; iter++) {
      const joined = tokens.join('');
      if (passesPhonotactics(joined, phonology, phonotactics)) {
        return finalize(trimmed, sourceIpa, tokens, steps);
      }
      // Find first illegal consonant cluster (run of 2+ consonants) and break it.
      const fixed = repairOnce(tokens, epen, steps, isConsonant, phonology, phonotactics);
      if (!fixed) break; // nothing more we can do
      tokens = fixed;
    }

    // Final pass: terminal-cluster fixup with paragoge or deletion.
    {
      const joined = tokens.join('');
      const result = validatePhonotactics(joined, phonology, phonotactics);
      if (!result.ok && tokens.length > 0 && isConsonant(tokens[tokens.length - 1]!)) {
        // Try paragoge first.
        if (epen) {
          const candidate = [...tokens, epen];
          if (passesPhonotactics(candidate.join(''), phonology, phonotactics)) {
            steps.push({
              kind: 'insert-vowel', before: tokens.join(''), after: candidate.join(''),
              reason: `appended vowel ${epen} after final ${tokens[tokens.length - 1]} so the word ends in a syllable nucleus`,
            });
            tokens = candidate;
          }
        }
      }
    }

    // Final validate.
    const finalWord = tokens.join('');
    if (!passesPhonotactics(finalWord, phonology, phonotactics)) {
      const err = new Error(
        `hayba: could not produce a phonotactically-legal adaptation of "${word}" after ${MAX_REPAIR_ITERS} iterations`,
      );
      (err as Error & { trail?: AdaptationStep[]; partial?: string }).trail = steps;
      (err as Error & { trail?: AdaptationStep[]; partial?: string }).partial = finalWord;
      throw err;
    }

    return finalize(trimmed, sourceIpa, tokens, steps);
  }

  function finalize(source: string, sourceIpa: string, tokens: string[], steps: AdaptationStep[]): AdaptedLoanword {
    const adapted = tokens.join('');
    const result: AdaptedLoanword = { source, sourceIpa, adapted, steps };
    if (options.romanization && options.romanization.rules.length > 0) {
      result.romanized = romanize(adapted, options.romanization);
    }
    return result;
  }

  return { adapt };
}

/**
 * Single pass: find the first illegal cluster (consecutive consonants forming
 * an onset/coda the spec rejects) and break it via epenthesis. Returns null
 * if no repair is possible.
 */
function repairOnce(
  tokens: string[],
  epen: string | undefined,
  steps: AdaptationStep[],
  isConsonant: (ipa: string) => boolean,
  phonology: Phonology,
  spec: PhonotacticSpec,
): string[] | null {
  if (!epen) return null;

  // Walk through, find runs of 2+ consonants; insert vowel between each pair
  // until that locally produces a legal pair.
  for (let i = 0; i < tokens.length - 1; i++) {
    if (isConsonant(tokens[i]!) && isConsonant(tokens[i + 1]!)) {
      const before = tokens.join('');
      const candidate = [...tokens.slice(0, i + 1), epen, ...tokens.slice(i + 1)];
      const after = candidate.join('');
      steps.push({
        kind: 'insert-vowel', before, after,
        reason: `inserted vowel ${epen} between ${tokens[i]} and ${tokens[i + 1]} to break an illegal consonant cluster`,
      });
      return candidate;
    }
  }

  // No internal CC cluster found, but word still fails — maybe word begins or
  // ends with bare consonant the templates can't accommodate. Try wrapping.
  if (tokens.length === 1 && isConsonant(tokens[0]!)) {
    const candidate = [tokens[0]!, epen];
    steps.push({
      kind: 'insert-vowel', before: tokens.join(''), after: candidate.join(''),
      reason: `appended vowel ${epen} to lone consonant ${tokens[0]} so it forms a syllable`,
    });
    return candidate;
  }

  // Last-ditch: delete a trailing consonant if no vowel can save it.
  if (tokens.length > 0 && isConsonant(tokens[tokens.length - 1]!)) {
    const candidate = tokens.slice(0, -1);
    if (candidate.length === 0) return null;
    steps.push({
      kind: 'delete', before: tokens.join(''), after: candidate.join(''),
      reason: `deleted trailing ${tokens[tokens.length - 1]} (no legal way to close the word with it)`,
    });
    return candidate;
  }

  return null;
}
