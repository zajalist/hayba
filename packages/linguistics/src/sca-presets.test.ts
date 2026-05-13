import { describe, expect, it } from 'vitest';
import { SCA_PRESETS } from './data/sca-presets.js';
import { parseRules, evolveWord } from './sound-changes.js';
import type { Phonology } from './phonology.js';

describe('L26 — historical SCA presets', () => {
  it('ships all 12 starter presets', () => {
    expect(SCA_PRESETS).toHaveLength(12);
  });

  it('each preset has all required fields populated', () => {
    for (const p of SCA_PRESETS) {
      expect(p.name, `${p.name}: name`).toBeTruthy();
      expect(p.family, `${p.name}: family`).toBeTruthy();
      expect(p.era, `${p.name}: era`).toBeTruthy();
      expect(p.description.length, `${p.name}: description`).toBeGreaterThan(20);
      expect(p.rulesText.trim(), `${p.name}: rulesText`).not.toBe('');
      expect(p.citation, `${p.name}: citation`).toMatch(/^https?:\/\//);
    }
  });

  it('every preset rulesText parses cleanly via parseRules', () => {
    for (const p of SCA_PRESETS) {
      expect(
        () => parseRules(p.rulesText),
        `${p.name} should parse without throwing`,
      ).not.toThrow();
      const rules = parseRules(p.rulesText);
      expect(rules.length, `${p.name} should yield ≥1 non-comment rule`).toBeGreaterThan(0);
    }
  });
});

/** Tiny helper to build a phonology from a flat IPA list. */
function phon(ipa: string[]): Phonology {
  return {
    languageId: 'fixture',
    phonemes: ipa.map(s => ({ id: s, ipa: s, features: {} })),
  };
}

describe('L26 — preset fixtures', () => {
  it("Grimm's law: pater → faθer", () => {
    const ph = phon(['p', 'a', 't', 'e', 'r', 'f', 'θ', 'b', 'd', 'g', 'k', 'x']);
    const grimm = SCA_PRESETS.find(p => p.name === "Grimm's law")!;
    const rules = parseRules(grimm.rulesText);
    expect(evolveWord('pater', ph, rules, {})).toBe('faθer');
  });

  it('Polynesian k-loss: talika → taliʔa', () => {
    const ph = phon(['t', 'a', 'l', 'i', 'k', 'ʔ']);
    const preset = SCA_PRESETS.find(p => p.name === 'Polynesian k-loss')!;
    const rules = parseRules(preset.rulesText);
    expect(evolveWord('talika', ph, rules, {})).toBe('taliʔa');
  });

  it('French nasalization: gran → grɑ̃', () => {
    const ph = phon(['g', 'r', 'a', 'n', 'ɑ̃']);
    const preset = SCA_PRESETS.find(p => p.name === 'French nasalization')!;
    const rules = parseRules(preset.rulesText);
    expect(evolveWord('gran', ph, rules, {})).toBe('grɑ̃');
  });

  it('Mandarin n/ŋ merger: ban → baŋ (word-final only)', () => {
    const ph = phon(['b', 'a', 'n', 'ŋ']);
    const preset = SCA_PRESETS.find(p => p.name === 'Mandarin n/ŋ merger')!;
    const rules = parseRules(preset.rulesText);
    expect(evolveWord('ban', ph, rules, {})).toBe('baŋ');
    // /n/ in non-final position should not change.
    expect(evolveWord('nan', ph, rules, {})).toBe('naŋ');
  });
});
