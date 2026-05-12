import type { Phonology } from './phonology.js';
import { validatePhonotactics } from './phonotactics.js';
import type { PhonotacticSpec } from './phonotactics.js';

export type NameCategory = 'person' | 'place' | 'faction';

export interface NameGeneratorProfile {
  /** Supported: CV or CVC per syllable */
  syllableTemplate: 'CV' | 'CVC';
  vowels: string[];
  onsetPool: string[];
  /** Used as final consonant in CVC; falls back to onsetPool when empty */
  codaPool?: string[];
}

export interface GenerateNameParams {
  phonology: Phonology;
  phonotactics: PhonotacticSpec;
  profile: NameGeneratorProfile;
  category?: NameCategory;
  syllableCount: number;
  seed: number;
}

function mulberry32(a: number): () => number {
  return () => {
    let t = (a += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(arr: T[], rnd: () => number): T {
  return arr[Math.floor(rnd() * arr.length)]!;
}

function categorySalt(cat?: NameCategory): number {
  if (!cat) return 0;
  let h = 0;
  for (let i = 0; i < cat.length; i++) h = (h * 31 + cat.charCodeAt(i)) | 0;
  return h;
}

function buildSyllable(profile: NameGeneratorProfile, rnd: () => number): string {
  const codas = profile.codaPool?.length ? profile.codaPool : profile.onsetPool;
  if (profile.syllableTemplate === 'CV') {
    return pick(profile.onsetPool, rnd) + pick(profile.vowels, rnd);
  }
  return pick(profile.onsetPool, rnd) + pick(profile.vowels, rnd) + pick(codas, rnd);
}

export function generatePhonotacticName(p: GenerateNameParams): string {
  const salt = categorySalt(p.category);
  for (let attempt = 0; attempt < 1000; attempt++) {
    const rnd = mulberry32(p.seed + salt + attempt * 7919);
    let word = '';
    for (let syl = 0; syl < p.syllableCount; syl++) {
      word += buildSyllable(p.profile, rnd);
    }
    if (validatePhonotactics(word, p.phonology, p.phonotactics)) return word;
  }
  throw new Error('hayba: could not sample a phonotactic name — widen pools or templates');
}
