import { describe, expect, it } from 'vitest';
import type { Phonology } from './phonology.js';
import { validatePhonotactics, passesPhonotactics, clusterLegality, userCustomLegalityToClusters } from './phonotactics.js';

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

describe('clusterLegality — onsetClusters=["p"] under CV+CVC: every (p, *) cell is restricted', () => {
  const vowels = ['a', 'o'];
  const cells = clusterLegality(
    {
      phonologyId: 'demo', vowels,
      syllable: { templates: ['CV', 'CVC'], onsetClusters: ['p'] },
    },
    demoPhonology,
  );

  it('every (p, *) cell — both no-coda and with-coda — is restricted', () => {
    const pRow = cells.filter(c => c.onset === 'p');
    expect(pRow.length).toBeGreaterThan(0);
    for (const c of pRow) {
      expect(c.legality).toBe('restricted');
      expect(c.reason).toMatch(/disallowed onset cluster/);
    }
  });

  it('other onsets stay legal under same template', () => {
    const tRow = cells.filter(c => c.onset === 't');
    expect(tRow.length).toBeGreaterThan(0);
    for (const c of tRow) expect(c.legality).toBe('legal');
  });
});

describe('userCustomLegalityToClusters — UI ↔ spec sync helper', () => {
  it('routes a non-empty-coda override to codaClusters', () => {
    const out = userCustomLegalityToClusters({ 'p|t': 'illegal' });
    expect(out.codaClusters).toEqual(['t']);
    expect(out.onsetClusters).toEqual([]);
  });

  it('routes a "(no coda)" override to onsetClusters', () => {
    const out = userCustomLegalityToClusters({ 'p|': 'illegal' });
    expect(out.onsetClusters).toEqual(['p']);
    expect(out.codaClusters).toEqual([]);
  });

  it('treats restricted the same as illegal (no restrictedClusters field on spec)', () => {
    const out = userCustomLegalityToClusters({ 'k|s': 'restricted' });
    expect(out.codaClusters).toEqual(['s']);
  });

  it('drops user-set legal — only illegal/restricted blacklists', () => {
    const out = userCustomLegalityToClusters({ 'k|s': 'legal' });
    expect(out.codaClusters).toEqual([]);
    expect(out.onsetClusters).toEqual([]);
  });

  it('round-trip: illegal cell → blacklist → clusterLegality sees that cell as restricted', () => {
    // Simulate: user clicks (p, t) and cycles it to illegal. The buildSpec
    // sync writes 't' to codaClusters. clusterLegality then re-reads the spec
    // and marks every (*, t) cell as restricted with a disallowed-coda reason.
    const overrides: Record<string, 'legal' | 'restricted' | 'illegal'> = { 'p|t': 'illegal' };
    const { codaClusters, onsetClusters } = userCustomLegalityToClusters(overrides);
    const cells = clusterLegality(
      {
        phonologyId: 'demo', vowels: ['a', 'o'],
        syllable: { templates: ['CV', 'CVC'], onsetClusters, codaClusters },
      },
      demoPhonology,
    );
    const pt = cells.find(c => c.onset === 'p' && c.coda === 't');
    expect(pt).toBeDefined();
    expect(pt!.legality).toBe('restricted');
    expect(pt!.reason).toMatch(/disallowed coda cluster/);
  });

  it('null/undefined input yields empty blacklists', () => {
    expect(userCustomLegalityToClusters(null)).toEqual({ onsetClusters: [], codaClusters: [] });
    expect(userCustomLegalityToClusters(undefined)).toEqual({ onsetClusters: [], codaClusters: [] });
  });

  it('deduplicates repeated cluster strings', () => {
    const out = userCustomLegalityToClusters({ 'p|t': 'illegal', 'k|t': 'illegal' });
    expect(out.codaClusters).toEqual(['t']);
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
