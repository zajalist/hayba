/**
 * L2 — Phonotactic constraint engine.
 *
 * Templates are written as sequences of slot symbols, e.g. `(C)(C)V(N)(C)`:
 *   `(` … `)` — optional slot
 *   `C`        — any consonant in inventory
 *   `V`        — any vowel
 *   `N`        — nasal-only consonant
 *   `F`        — fricative-only consonant
 *   `L`        — liquid (lateral or rhotic)
 *   `S`        — stop / plosive
 *   custom     — any single uppercase letter, defined via `slotClasses`
 *
 * Cluster rules are blacklists, evaluated per word *position* (onset,
 * nucleus, coda). A failed cluster rule short-circuits validation.
 *
 * The validator returns either { ok: true, parses } or { ok: false, reason }
 * so UI can show position-of-failure.
 */

import type { Phoneme, Phonology } from './phonology.js';
import { tokenize, findPhonemeByIpa } from './phonology.js';

export interface SyllableProfile {
  templates: string[];
  /** Disallowed onset sequences (as IPA strings concatenated, e.g. ['pt','kp']). */
  onsetClusters?: string[];
  /** Disallowed coda sequences. */
  codaClusters?: string[];
  /** Disallowed cross-syllable boundary sequences (CC across a syllable break). */
  boundaryClusters?: string[];
}

export interface PhonotacticSpec {
  phonologyId: string;
  /** Surface IPA of phonemes treated as nuclei. */
  vowels: string[];
  syllable: SyllableProfile;
  /** Map of slot letter → IPA list. Built-ins C/V/N/F/L/S can be overridden. */
  slotClasses?: Record<string, string[]>;
}

export interface PhonotacticResult {
  ok: boolean;
  /** When ok, the syllable segmentation that succeeded (list of token-index ranges). */
  parse?: string[][];
  /** When !ok, a human-readable cause. */
  reason?: string;
}

const BUILTIN_FEATURE_FILTERS: Record<string, (p: Phoneme) => boolean> = {
  N: p => p.features.manner === 'nasal',
  F: p => p.features.manner === 'fricative',
  L: p => p.features.manner === 'lateral-approximant'
       || p.features.manner === 'lateral-fricative'
       || p.features.manner === 'trill'
       || p.features.manner === 'tap',
  S: p => p.features.manner === 'plosive' || p.features.manner === 'stop',
};

function expandSlotClasses(phonology: Phonology, spec: PhonotacticSpec): Record<string, Set<string>> {
  const vset = new Set(spec.vowels);
  const out: Record<string, Set<string>> = {
    V: vset,
    C: new Set(phonology.phonemes.map(p => p.ipa).filter(ipa => !vset.has(ipa))),
  };
  for (const [letter, fn] of Object.entries(BUILTIN_FEATURE_FILTERS)) {
    out[letter] = new Set(phonology.phonemes.filter(fn).map(p => p.ipa));
  }
  for (const [letter, list] of Object.entries(spec.slotClasses ?? {})) {
    out[letter] = new Set(list);
  }
  return out;
}

interface ParsedTemplate {
  /** Slot letter per position. */
  slots: string[];
  /** True if that position is optional. */
  optional: boolean[];
}

function parseTemplate(template: string): ParsedTemplate {
  const slots: string[] = [];
  const optional: boolean[] = [];
  let i = 0;
  while (i < template.length) {
    const ch = template[i]!;
    if (ch === ' ') { i++; continue; }
    if (ch === '(') {
      const end = template.indexOf(')', i);
      if (end < 0) throw new Error(`hayba: unbalanced '(' in template "${template}"`);
      const inner = template.slice(i + 1, end);
      for (const c of inner) { slots.push(c); optional.push(true); }
      i = end + 1;
    } else {
      slots.push(ch); optional.push(false);
      i++;
    }
  }
  return { slots, optional };
}

/** Yield every valid consumption length when matching `template` at `start`. */
function* matchTemplate(
  tokens: string[],
  start: number,
  parsed: ParsedTemplate,
  classes: Record<string, Set<string>>,
): Generator<{ consumed: number; tokens: string[] }> {
  const optIndices = parsed.optional
    .map((o, idx) => (o ? idx : -1))
    .filter(idx => idx >= 0);

  // Try longer matches first — prefer maximal syllable consumption.
  for (let mask = (1 << optIndices.length) - 1; mask >= 0; mask--) {
    const skip = new Set<number>();
    for (let k = 0; k < optIndices.length; k++) {
      if ((mask & (1 << k)) === 0) skip.add(optIndices[k]!);
    }
    const wantSlots: string[] = [];
    for (let j = 0; j < parsed.slots.length; j++) {
      if (!skip.has(j)) wantSlots.push(parsed.slots[j]!);
    }
    if (start + wantSlots.length > tokens.length) continue;
    let ok = true;
    const chunk: string[] = [];
    for (let j = 0; j < wantSlots.length; j++) {
      const letter = wantSlots[j]!;
      const pool = classes[letter];
      const tok = tokens[start + j]!;
      if (!pool || !pool.has(tok)) { ok = false; break; }
      chunk.push(tok);
    }
    if (ok) yield { consumed: wantSlots.length, tokens: chunk };
  }
}

function violatesClusterRules(
  syllables: string[][],
  spec: PhonotacticSpec,
  vowels: Set<string>,
): string | null {
  for (let s = 0; s < syllables.length; s++) {
    const syl = syllables[s]!;
    const nucleusAt = syl.findIndex(t => vowels.has(t));
    const onset = nucleusAt >= 0 ? syl.slice(0, nucleusAt).join('') : '';
    const coda = nucleusAt >= 0 ? syl.slice(nucleusAt + 1).join('') : syl.join('');
    if (onset && spec.syllable.onsetClusters?.some(c => onset === c || onset.includes(c))) {
      return `disallowed onset cluster '${onset}' in syllable ${s + 1}`;
    }
    if (coda && spec.syllable.codaClusters?.some(c => coda === c || coda.includes(c))) {
      return `disallowed coda cluster '${coda}' in syllable ${s + 1}`;
    }
    if (s > 0 && spec.syllable.boundaryClusters?.length) {
      const prev = syllables[s - 1]!;
      const boundary = prev[prev.length - 1] + (syl[0] ?? '');
      if (spec.syllable.boundaryClusters.some(c => boundary === c)) {
        return `disallowed boundary cluster '${boundary}'`;
      }
    }
  }
  return null;
}

export function validatePhonotactics(
  word: string,
  phonology: Phonology,
  spec: PhonotacticSpec,
): PhonotacticResult {
  const tokens = tokenize(word, phonology);
  if (!tokens) return { ok: false, reason: 'word contains characters outside the inventory' };
  const toks: string[] = tokens;
  const classes = expandSlotClasses(phonology, spec);
  const templates = spec.syllable.templates.map(parseTemplate);
  const vset = new Set(spec.vowels);

  // Greedy left-to-right syllabification; on failure, backtrack across template choices.
  function recur(start: number): string[][] | null {
    if (start === toks.length) return [];
    for (const tpl of templates) {
      for (const m of matchTemplate(toks, start, tpl, classes)) {
        if (m.consumed === 0) continue;
        if (!m.tokens.some(t => vset.has(t))) continue;
        const rest = recur(start + m.consumed);
        if (rest) return [m.tokens, ...rest];
      }
    }
    return null;
  }

  const parse = recur(0);
  if (!parse) return { ok: false, reason: 'no syllabification matches any template' };

  const clusterFail = violatesClusterRules(parse, spec, vset);
  if (clusterFail) return { ok: false, reason: clusterFail };

  return { ok: true, parse };
}

/** Boolean shorthand for callers that don't care about the parse details. */
export function passesPhonotactics(word: string, phonology: Phonology, spec: PhonotacticSpec): boolean {
  return validatePhonotactics(word, phonology, spec).ok;
}

// `findPhonemeByIpa` is intentionally re-exported elsewhere; touch it here so the import
// stays load-bearing for future feature-based slot extensions (e.g. NPA harmony).
void findPhonemeByIpa;

/* ───────────────────── L19 — legality heatmap ───────────────────── */

export type ClusterLegality = 'legal' | 'illegal' | 'restricted';

export interface ClusterCell {
  onset: string;
  coda: string;
  legality: ClusterLegality;
  /** Sample syllable that demonstrates this onset/coda pair, e.g. "pak". */
  sample?: string;
  /** Reason for non-legal status, if applicable. */
  reason?: string;
}

/**
 * For each (onset-consonant × coda-consonant + a sentinel "no coda" column),
 * build a candidate syllable `onset + nucleus + coda` and classify it via
 * `validatePhonotactics`.
 *
 * - `ok` → legal, with the candidate as `sample`.
 * - validator reason mentions "disallowed onset/coda cluster" → restricted.
 * - anything else → illegal.
 */
export function clusterLegality(
  spec: PhonotacticSpec,
  phonology: Phonology,
): ClusterCell[] {
  const vset = new Set(spec.vowels);
  const consonants = phonology.phonemes
    .map(p => p.ipa)
    .filter(ipa => !vset.has(ipa));
  const nucleus = spec.vowels[0];
  const cells: ClusterCell[] = [];
  if (!nucleus) return cells;

  // First column: "(no coda)" sentinel, represented as coda='' .
  const codas = ['', ...consonants];

  for (const onset of consonants) {
    for (const coda of codas) {
      const candidate = onset + nucleus + coda;
      const result = validatePhonotactics(candidate, phonology, spec);
      if (result.ok) {
        cells.push({ onset, coda, legality: 'legal', sample: candidate });
      } else {
        const reason = result.reason ?? 'invalid';
        if (/disallowed (?:onset|coda) cluster/i.test(reason)) {
          cells.push({ onset, coda, legality: 'restricted', sample: candidate, reason });
        } else {
          cells.push({ onset, coda, legality: 'illegal', reason });
        }
      }
    }
  }
  return cells;
}
