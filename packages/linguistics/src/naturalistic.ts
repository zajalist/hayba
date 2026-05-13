/**
 * L29 — Naturalistic suggestion engine.
 *
 * Two surfaces:
 *
 * 1. `suggestPhonotactics(spec, phonology)` — for each (onset, coda) pair in
 *    the inventory (with `coda=''` representing an open syllable / no coda),
 *    return whether the pair is `legal`, `restricted`, or `illegal` under the
 *    Sonority Sequencing Principle. Single consonants on either side are
 *    universally permitted.
 *
 * 2. `suggestAllophony(phonology)` — pattern-match the inventory against a
 *    catalogue of well-attested cross-linguistic processes (lenition, final
 *    devoicing, NPA, palatalization, flapping, …) and emit candidate rules
 *    the user can drop into their allophony grammar.
 *
 * Both engines are deliberately *suggestions* — they don't mutate the
 * inventory or the rule list. The host UI decides whether to apply them.
 */

import type { Phonology, Phoneme } from './phonology.js';
import type { PhonotacticSpec } from './phonotactics.js';
import type { AllophonyRule } from './allophony.js';

/* ────────────────────── Phonotactics ────────────────────── */

export interface PhonotacticSuggestion {
  /** [onset, coda] — coda='' means open syllable / no coda. */
  pair: [string, string];
  suggestedLegality: 'legal' | 'illegal' | 'restricted';
  rationale: string;
  /** 0..1, higher = more confident. */
  confidence: number;
  basis: 'sonority' | 'corpus' | 'universal';
}

/** Sonority class for a phoneme. Higher = more sonorous (closer to nucleus). */
function sonority(p: Phoneme): number {
  const f = p.features;
  if ('height' in f) return 6; // vowel
  const m = f.manner;
  const place = f.place;
  // Glides — labial-velar/labial-palatal/palatal approximants (j w ɥ ɰ)
  if (m === 'approximant' && (place === 'labial-velar' || place === 'labial-palatal' || place === 'palatal' || place === 'velar')) {
    return 5;
  }
  // Liquids
  if (m === 'lateral-approximant' || m === 'lateral-fricative' || m === 'trill' || m === 'tap' || m === 'lateral-tap') {
    return 4;
  }
  // Plain approximants that aren't glides (e.g. ɹ) — also liquids
  if (m === 'approximant') return 4;
  if (m === 'nasal') return 3;
  if (m === 'fricative' || m === 'sibilant-fricative') return 2;
  // plosives, affricates, implosives, ejectives, clicks
  return 1;
}

const STOP_MANNERS = new Set(['plosive', 'stop', 'affricate', 'implosive', 'ejective', 'click']);

function isStop(p: Phoneme): boolean {
  return STOP_MANNERS.has(p.features.manner ?? '');
}

function isSibilant(p: Phoneme): boolean {
  return p.ipa === 's' || p.ipa === 'z' || p.features.manner === 'sibilant-fricative';
}

function isVowel(p: Phoneme): boolean {
  return 'height' in p.features;
}

export function suggestPhonotactics(
  spec: PhonotacticSpec,
  phonology: Phonology,
): PhonotacticSuggestion[] {
  const vset = new Set(spec.vowels);
  const consonants = phonology.phonemes.filter(p => !vset.has(p.ipa) && !isVowel(p));
  const byIpa = new Map<string, Phoneme>();
  for (const p of consonants) byIpa.set(p.ipa, p);

  const codas = ['', ...consonants.map(p => p.ipa)];
  const out: PhonotacticSuggestion[] = [];

  for (const onP of consonants) {
    for (const coda of codas) {
      const onset = onP.ipa;
      const codaP = coda === '' ? undefined : byIpa.get(coda);
      // Single C onset + (no coda or single C coda) — universally legal.
      if (!codaP) {
        out.push({
          pair: [onset, coda],
          suggestedLegality: 'legal',
          rationale: 'single onset/coda consonants are universally permitted',
          confidence: 0.95,
          basis: 'universal',
        });
        continue;
      }
      // Both single Cs — universally legal (CVC).
      out.push({
        pair: [onset, coda],
        suggestedLegality: 'legal',
        rationale: 'single onset/coda consonants are universally permitted',
        confidence: 0.95,
        basis: 'universal',
      });
    }
  }

  // Now score user-defined clusters (multi-C onsets / codas) for sonority compliance.
  const tokenizePairOrSequence = (seq: string): Phoneme[] | null => {
    // Greedy longest-match against inventory ipa.
    const syms = consonants.map(p => p.ipa).sort((a, b) => b.length - a.length);
    const segs: Phoneme[] = [];
    let i = 0;
    while (i < seq.length) {
      let hit: string | undefined;
      for (const s of syms) {
        if (s.length > 0 && seq.startsWith(s, i)) { hit = s; break; }
      }
      if (!hit) return null;
      segs.push(byIpa.get(hit)!);
      i += hit.length;
    }
    return segs;
  };

  const scoreOnsetCluster = (cluster: string): PhonotacticSuggestion => {
    const segs = tokenizePairOrSequence(cluster);
    if (!segs || segs.length < 2) {
      return {
        pair: [cluster, ''],
        suggestedLegality: 'illegal',
        rationale: 'cluster does not tokenize against the inventory',
        confidence: 0.4,
        basis: 'sonority',
      };
    }
    // S + stop exception
    if (segs.length === 2 && isSibilant(segs[0]!) && isStop(segs[1]!)) {
      return {
        pair: [cluster, ''],
        suggestedLegality: 'restricted',
        rationale: 'S+stop onsets violate sonority but are widely attested (e.g. English, Italian)',
        confidence: 0.8,
        basis: 'corpus',
      };
    }
    // Sonority must rise strictly toward the nucleus.
    for (let i = 0; i < segs.length - 1; i++) {
      if (sonority(segs[i + 1]!) <= sonority(segs[i]!)) {
        return {
          pair: [cluster, ''],
          suggestedLegality: 'illegal',
          rationale: `onset cluster violates rising sonority at position ${i + 1}`,
          confidence: 0.7,
          basis: 'sonority',
        };
      }
    }
    return {
      pair: [cluster, ''],
      suggestedLegality: 'legal',
      rationale: 'onset cluster has rising sonority toward the nucleus',
      confidence: 0.75,
      basis: 'sonority',
    };
  };

  const scoreCodaCluster = (cluster: string): PhonotacticSuggestion => {
    const segs = tokenizePairOrSequence(cluster);
    if (!segs || segs.length < 2) {
      return {
        pair: ['', cluster],
        suggestedLegality: 'illegal',
        rationale: 'cluster does not tokenize against the inventory',
        confidence: 0.4,
        basis: 'sonority',
      };
    }
    // Stop + s exception (Greek -ps, -ks)
    if (segs.length === 2 && isStop(segs[0]!) && isSibilant(segs[1]!)) {
      return {
        pair: ['', cluster],
        suggestedLegality: 'restricted',
        rationale: 'stop+S codas violate sonority but are widely attested (e.g. Greek -ps, -ks)',
        confidence: 0.8,
        basis: 'corpus',
      };
    }
    for (let i = 0; i < segs.length - 1; i++) {
      if (sonority(segs[i + 1]!) >= sonority(segs[i]!)) {
        return {
          pair: ['', cluster],
          suggestedLegality: 'illegal',
          rationale: `coda cluster violates falling sonority at position ${i + 1}`,
          confidence: 0.7,
          basis: 'sonority',
        };
      }
    }
    return {
      pair: ['', cluster],
      suggestedLegality: 'legal',
      rationale: 'coda cluster has falling sonority away from the nucleus',
      confidence: 0.75,
      basis: 'sonority',
    };
  };

  for (const cluster of spec.syllable.onsetClusters ?? []) {
    out.push(scoreOnsetCluster(cluster));
  }
  for (const cluster of spec.syllable.codaClusters ?? []) {
    out.push(scoreCodaCluster(cluster));
  }

  return out;
}

/* ────────────────────── Allophony ────────────────────── */

export interface AllophonySuggestion {
  rule: AllophonyRule;
  rationale: string;
  /** Language families / languages where this process is attested. */
  attestation: string[];
  /** 0..1, higher = more confident this fits the inventory. */
  confidence: number;
}

const FRONT_VOWEL_HEIGHTS = new Set(['close', 'near-close', 'close-mid', 'mid', 'open-mid', 'near-open']);

function has(phonology: Phonology, ipa: string): boolean {
  return phonology.phonemes.some(p => p.ipa === ipa);
}

function find(phonology: Phonology, ipa: string): Phoneme | undefined {
  return phonology.phonemes.find(p => p.ipa === ipa);
}

function vowelsOf(phonology: Phonology): Phoneme[] {
  return phonology.phonemes.filter(isVowel);
}

function frontVowels(phonology: Phonology): Phoneme[] {
  return vowelsOf(phonology).filter(v => v.features.backness === 'front' && FRONT_VOWEL_HEIGHTS.has(v.features.height ?? ''));
}

function consonantsBy(phonology: Phonology, predicate: (p: Phoneme) => boolean): Phoneme[] {
  return phonology.phonemes.filter(p => !isVowel(p) && predicate(p));
}

function distinctPlaces(phonology: Phonology): Set<string> {
  const out = new Set<string>();
  for (const p of phonology.phonemes) {
    if (!isVowel(p) && p.features.place) out.add(p.features.place);
  }
  return out;
}

export function suggestAllophony(phonology: Phonology): AllophonySuggestion[] {
  const out: AllophonySuggestion[] = [];
  const vs = vowelsOf(phonology);

  /* 1. Intervocalic spirantization (b/d/g → β/ð/ɣ / V _ V) */
  if (vs.length >= 2 && (has(phonology, 'b') || has(phonology, 'd') || has(phonology, 'ɡ') || has(phonology, 'g'))) {
    const pairs: [string, string][] = [
      ['b', 'β'], ['d', 'ð'], ['ɡ', 'ɣ'],
    ];
    for (const [stop, fric] of pairs) {
      const stopIn = has(phonology, stop) || (stop === 'ɡ' && has(phonology, 'g'));
      if (!stopIn) continue;
      out.push({
        rule: {
          phoneme: has(phonology, stop) ? stop : 'g',
          surface: fric,
          before: ['[V]'],
          after: ['[V]'],
          label: 'intervocalic spirantization',
        },
        rationale: `voiced stop /${stop}/ lenites to fricative [${fric}] between vowels`,
        attestation: ['Spanish', 'Italian', 'Celtic', 'some Bantu'],
        confidence: 0.7,
      });
    }
  }

  /* 2. Final devoicing */
  {
    const pairs: [string, string][] = [['b', 'p'], ['d', 't'], ['ɡ', 'k']];
    for (const [voiced, voiceless] of pairs) {
      const v = has(phonology, voiced) || (voiced === 'ɡ' && has(phonology, 'g'));
      if (!v || !has(phonology, voiceless)) continue;
      out.push({
        rule: {
          phoneme: has(phonology, voiced) ? voiced : 'g',
          surface: voiceless,
          before: [],
          after: ['#'],
          label: 'final devoicing',
        },
        rationale: `voiced obstruent /${voiced}/ devoices to [${voiceless}] word-finally`,
        attestation: ['German', 'Russian', 'Catalan', 'Dutch', 'Turkish'],
        confidence: 0.6,
      });
    }
  }

  /* 3. Nasal place assimilation */
  {
    const nasals = consonantsBy(phonology, p => p.features.manner === 'nasal');
    const places = distinctPlaces(phonology);
    if (nasals.length >= 1 && places.size >= 2) {
      const n = find(phonology, 'n');
      if (n) {
        const hasLabial = phonology.phonemes.some(p => !isVowel(p) && (p.features.place === 'bilabial' || p.features.place === 'labiodental'));
        const hasVelar = phonology.phonemes.some(p => !isVowel(p) && p.features.place === 'velar');
        if (hasLabial && has(phonology, 'm')) {
          out.push({
            rule: { phoneme: 'n', surface: 'm', before: [], after: ['[labial]'], label: 'nasal place assimilation (→ labial)' },
            rationale: '/n/ assimilates to [m] before labials',
            attestation: ['English', 'Spanish', 'Japanese', 'universally common'],
            confidence: 0.85,
          });
        }
        if (hasVelar && has(phonology, 'ŋ')) {
          out.push({
            rule: { phoneme: 'n', surface: 'ŋ', before: [], after: ['[velar]'], label: 'nasal place assimilation (→ velar)' },
            rationale: '/n/ assimilates to [ŋ] before velars',
            attestation: ['English', 'Spanish', 'Japanese', 'universally common'],
            confidence: 0.85,
          });
        }
      }
    }
  }

  /* 4. Velar palatalization */
  {
    const fronts = frontVowels(phonology);
    const kIn = has(phonology, 'k');
    const gIn = has(phonology, 'ɡ') || has(phonology, 'g');
    if (fronts.length >= 1 && (kIn || gIn)) {
      if (kIn) {
        const surface = has(phonology, 't͡ʃ') ? 't͡ʃ' : has(phonology, 'tʃ') ? 'tʃ' : has(phonology, 'c') ? 'c' : 't͡ʃ';
        out.push({
          rule: { phoneme: 'k', surface, before: [], after: ['[front_vowel]'], label: 'velar palatalization' },
          rationale: `/k/ palatalizes to [${surface}] before front vowels`,
          attestation: ['Slavic', 'Romance', 'some West African'],
          confidence: 0.65,
        });
      }
      if (gIn) {
        const stop = has(phonology, 'ɡ') ? 'ɡ' : 'g';
        const surface = has(phonology, 'd͡ʒ') ? 'd͡ʒ' : has(phonology, 'dʒ') ? 'dʒ' : has(phonology, 'ɟ') ? 'ɟ' : 'd͡ʒ';
        out.push({
          rule: { phoneme: stop, surface, before: [], after: ['[front_vowel]'], label: 'velar palatalization' },
          rationale: `/${stop}/ palatalizes to [${surface}] before front vowels`,
          attestation: ['Slavic', 'Romance', 'some West African'],
          confidence: 0.65,
        });
      }
    }
  }

  /* 5. Intervocalic flapping */
  if (has(phonology, 't') && vs.length >= 2) {
    out.push({
      rule: { phoneme: 't', surface: 'ɾ', before: ['[V]'], after: ['[V]'], label: 'intervocalic flapping' },
      rationale: '/t/ flaps to [ɾ] between vowels',
      attestation: ['American English', 'some Spanish dialects', 'Japanese (related processes)'],
      confidence: 0.5,
    });
  }

  /* 6. Word-final stop unrelease */
  {
    const pairs: [string, string][] = [['p', 'p̚'], ['t', 't̚'], ['k', 'k̚']];
    for (const [stop, unrel] of pairs) {
      if (!has(phonology, stop)) continue;
      out.push({
        rule: { phoneme: stop, surface: unrel, before: [], after: ['#'], label: 'word-final stop unrelease' },
        rationale: `/${stop}/ is unreleased word-finally`,
        attestation: ['Korean', 'Vietnamese', 'Cantonese'],
        confidence: 0.5,
      });
    }
  }

  /* 7. Vowel reduction in unstressed position (draft) */
  if (has(phonology, 'ə')) {
    out.push({
      rule: { phoneme: '[V]', surface: 'ə', before: [], after: [], label: 'unstressed vowel reduction (draft)' },
      rationale: 'unstressed vowels reduce to schwa [ə] — requires stress information; fill in context manually',
      attestation: ['English', 'Russian (akanye)'],
      confidence: 0.4,
    });
  }

  /* 8. Glottal stop epenthesis at vowel onset (draft) */
  if (has(phonology, 'ʔ') && vs.length >= 1) {
    out.push({
      rule: { phoneme: '[V]', surface: 'ʔ', before: ['#'], after: [], label: 'glottal stop epenthesis (draft)' },
      rationale: 'epenthetic [ʔ] inserted before word-initial vowels — the engine has no null target, so this is a draft note',
      attestation: ['German (formal)', 'Arabic', 'some Polynesian'],
      confidence: 0.45,
    });
  }

  // Order by confidence desc.
  out.sort((a, b) => b.confidence - a.confidence);
  return out;
}
