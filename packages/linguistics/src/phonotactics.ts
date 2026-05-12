import type { Phonology } from './phonology.js';
import { tokenize } from './phonology.js';

export interface SyllableProfile {
  /** Syllable shapes as sequences of C / V using onset–nucleus–coda grammar */
  templates: string[];
  /** Symbols allowed in onset clusters (optional pair notation as two phoneme strings concatenated in inventory) */
  onsetClusters?: string[];
  /** Symbols allowed in coda clusters */
  codaClusters?: string[];
}

export interface PhonotacticSpec {
  phonologyId: string;
  /** Symbols treated as nuclei (vowels). */
  vowels: string[];
  syllable: SyllableProfile;
}

function classifySymbols(tokens: string[], vowels: Set<string>): ('C' | 'V')[] {
  return tokens.map(t => (vowels.has(t) ? 'V' : 'C'));
}

/** Validate word against syllable templates (CV, CVC, …). */
export function validatePhonotactics(word: string, phonology: Phonology, spec: PhonotacticSpec): boolean {
  const tokens = tokenize(word, phonology);
  if (!tokens) return false;
  const vset = new Set(spec.vowels);
  const kinds = classifySymbols(tokens, vset);
  const flat = kinds.join('');
  return spec.syllable.templates.some(tpl => syllableMatch(flat, tpl));
}

function syllableMatch(sequence: string, template: string): boolean {
  const need = template.replace(/\s+/g, '');
  const parts = splitBySyllables(sequence, need);
  return parts !== null;
}

/** Greedy partition of CV sequence into syllables matching repeated template. */
function splitBySyllables(seq: string, template: string): string[] | null {
  if (seq.length % template.length !== 0) return null;
  const nSyl = seq.length / template.length;
  const out: string[] = [];
  for (let s = 0; s < nSyl; s++) {
    const chunk = seq.slice(s * template.length, (s + 1) * template.length);
    for (let i = 0; i < template.length; i++) {
      if (chunk[i] !== template[i]) return null;
    }
    out.push(chunk);
  }
  return out;
}
