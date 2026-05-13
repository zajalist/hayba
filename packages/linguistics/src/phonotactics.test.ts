import { describe, expect, it } from 'vitest';
import type { Phonology } from './phonology.js';
import { validatePhonotactics, passesPhonotactics, clusterLegality } from './phonotactics.js';

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

describe('clusterLegality — heatmap cells', () => {
  const vowels = ['a', 'o'];

  it('all-CV inventory: every (onset, "") cell is legal', () => {
    const cells = clusterLegality(
      { phonologyId: 'demo', vowels, syllable: { templates: ['CV'] } },
      demoPhonology,
    );
    const noCoda = cells.filter(c => c.coda === '');
    expect(noCoda.length).toBeGreaterThan(0);
    for (const c of noCoda) expect(c.legality).toBe('legal');
  });

  it('codaClusters=["t"] under CVC: (onset, "t") cell is restricted', () => {
    const cells = clusterLegality(
      {
        phonologyId: 'demo', vowels,
        syllable: { templates: ['CVC'], codaClusters: ['t'] },
      },
      demoPhonology,
    );
    const pt = cells.find(c => c.onset === 'p' && c.coda === 't');
    expect(pt).toBeDefined();
    expect(pt!.legality).toBe('restricted');
    expect(pt!.reason).toMatch(/disallowed coda cluster/);
  });

  it('CV-only templates: every (onset, non-empty coda) cell is illegal', () => {
    const cells = clusterLegality(
      { phonologyId: 'demo', vowels, syllable: { templates: ['CV'] } },
      demoPhonology,
    );
    const withCoda = cells.filter(c => c.coda !== '');
    expect(withCoda.length).toBeGreaterThan(0);
    for (const c of withCoda) expect(c.legality).toBe('illegal');
  });

  it('CV+CVC templates with no blacklists: every (onset, coda) cell is legal', () => {
    const cells = clusterLegality(
      { phonologyId: 'demo', vowels, syllable: { templates: ['CV', 'CVC'] } },
      demoPhonology,
    );
    expect(cells.length).toBeGreaterThan(0);
    for (const c of cells) expect(c.legality).toBe('legal');
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
