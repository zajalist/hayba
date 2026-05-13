import { describe, expect, it } from 'vitest';
import type { Phonology } from './phonology.js';
import { validatePhonotactics, passesPhonotactics } from './phonotactics.js';

const demoPhonology: Phonology = {
  languageId: 'demo',
  phonemes: [
    { id: 'p', ipa: 'p', features: { place: 'bilabial', manner: 'plosive', voicing: 'voiceless' } },
    { id: 'k', ipa: 'k', features: { place: 'velar',    manner: 'plosive', voicing: 'voiceless' } },
    { id: 't', ipa: 't', features: { place: 'alveolar', manner: 'plosive', voicing: 'voiceless' } },
    { id: 's', ipa: 's', features: { place: 'alveolar', manner: 'fricative', voicing: 'voiceless' } },
    { id: 'm', ipa: 'm', features: { place: 'bilabial', manner: 'nasal',   voicing: 'voiced' } },
    { id: 'n', ipa: 'n', features: { place: 'alveolar', manner: 'nasal',   voicing: 'voiced' } },
    { id: 'l', ipa: 'l', features: { place: 'alveolar', manner: 'lateral-approximant', voicing: 'voiced' } },
    { id: 'a', ipa: 'a', features: { height: 'open',  backness: 'front', roundness: 'unrounded' } },
    { id: 'o', ipa: 'o', features: { height: 'close-mid', backness: 'back', roundness: 'rounded' } },
  ],
};

describe('validatePhonotactics — CV templates', () => {
  it('accepts /kato/ under CV', () => {
    const r = validatePhonotactics('kato', demoPhonology, {
      phonologyId: 'demo', vowels: ['a', 'o'],
      syllable: { templates: ['CV'] },
    });
    expect(r.ok).toBe(true);
    expect(r.parse).toEqual([['k', 'a'], ['t', 'o']]);
  });

  it('rejects /kkato/ — onset cluster not in template', () => {
    expect(passesPhonotactics('kkato', demoPhonology, {
      phonologyId: 'demo', vowels: ['a', 'o'], syllable: { templates: ['CV'] },
    })).toBe(false);
  });
});

describe('feature-keyed slots', () => {
  const spec = {
    phonologyId: 'demo', vowels: ['a', 'o'],
    syllable: { templates: ['(C)V(N)'] },
  };

  it('accepts /kan/ — N slot filled by a nasal', () => {
    const r = validatePhonotactics('kan', demoPhonology, spec);
    expect(r.ok).toBe(true);
  });

  it('rejects /kas/ — /s/ is fricative, not nasal', () => {
    const r = validatePhonotactics('kas', demoPhonology, spec);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/no syllabification/);
  });

  it('accepts /a/ — both optional slots empty', () => {
    expect(passesPhonotactics('a', demoPhonology, spec)).toBe(true);
  });
});

describe('cluster blacklist', () => {
  const spec = {
    phonologyId: 'demo', vowels: ['a', 'o'],
    syllable: { templates: ['(C)(C)V'], onsetClusters: ['kt', 'pt'] },
  };

  it('rejects /ktao/ — kt onset is blacklisted', () => {
    const r = validatePhonotactics('ktao', demoPhonology, spec);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/onset cluster 'kt'/);
  });

  it('accepts /stao/ — st onset is fine', () => {
    expect(passesPhonotactics('stao', demoPhonology, spec)).toBe(true);
  });
});

describe('custom slot classes', () => {
  it('accepts /sla/ with onset = stop+liquid template SLV via custom letter', () => {
    const spec = {
      phonologyId: 'demo', vowels: ['a', 'o'],
      syllable: { templates: ['(S)LV'] },
      slotClasses: { S: ['s'], L: ['l'] },
    };
    expect(passesPhonotactics('sla', demoPhonology, spec)).toBe(true);
  });
});
