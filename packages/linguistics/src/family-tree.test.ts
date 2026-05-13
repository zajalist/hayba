import { describe, expect, it } from 'vitest';
import { buildFamilyTree } from './family-tree.js';
import { autoCognatesFromDiachrony, type Wordlink } from './wordlinks.js';

describe('buildFamilyTree', () => {
  it('single root: one language with no wordlinks', () => {
    const roots = buildFamilyTree(['proto'], []);
    expect(roots).toHaveLength(1);
    expect(roots[0]!.id).toBe('proto');
    expect(roots[0]!.children).toEqual([]);
    expect(roots[0]!.parentId).toBeUndefined();
  });

  it('parent + daughter: cognate wordlinks produce a 2-level tree', () => {
    const cognates = autoCognatesFromDiachrony('proto', 'daughter', [
      { concept: 'water', lemma: 'wata', evolved: 'vada' },
      { concept: 'fire',  lemma: 'pira', evolved: 'fira' },
    ]);
    const roots = buildFamilyTree(['proto', 'daughter'], cognates);
    expect(roots).toHaveLength(1);
    expect(roots[0]!.id).toBe('proto');
    expect(roots[0]!.children).toHaveLength(1);
    const d = roots[0]!.children[0]!;
    expect(d.id).toBe('daughter');
    expect(d.parentId).toBe('proto');
    expect(d.children).toEqual([]);
  });

  it('multi-generation: proto → daughter → granddaughter', () => {
    const wls: Wordlink[] = [
      ...autoCognatesFromDiachrony('proto', 'daughter', [
        { concept: 'sun', lemma: 'sora', evolved: 'sara' },
      ]),
      ...autoCognatesFromDiachrony('daughter', 'granddaughter', [
        { concept: 'sun', lemma: 'sara', evolved: 'ʃara' },
      ]),
    ];
    const roots = buildFamilyTree(['proto', 'daughter', 'granddaughter'], wls);
    expect(roots).toHaveLength(1);
    expect(roots[0]!.id).toBe('proto');
    expect(roots[0]!.children).toHaveLength(1);
    const d = roots[0]!.children[0]!;
    expect(d.id).toBe('daughter');
    expect(d.children).toHaveLength(1);
    const gd = d.children[0]!;
    expect(gd.id).toBe('granddaughter');
    expect(gd.children).toEqual([]);
  });

  it('multiple sisters: one parent with two daughters', () => {
    const wls: Wordlink[] = [
      ...autoCognatesFromDiachrony('proto', 'north', [
        { concept: 'stone', lemma: 'kara', evolved: 'kar' },
      ]),
      ...autoCognatesFromDiachrony('proto', 'south', [
        { concept: 'stone', lemma: 'kara', evolved: 'gala' },
      ]),
    ];
    const roots = buildFamilyTree(['proto', 'north', 'south'], wls);
    expect(roots).toHaveLength(1);
    expect(roots[0]!.id).toBe('proto');
    expect(roots[0]!.children.map(c => c.id)).toEqual(['north', 'south']);
    for (const c of roots[0]!.children) {
      expect(c.parentId).toBe('proto');
      expect(c.children).toEqual([]);
    }
  });

  it('rule summary picks the biggest edit-distance change', () => {
    // Three cognates between the same pair — the biggest delta is "pipapa → piba"
    // (edit distance 3), so that's what should surface as the edge label.
    const cognates = autoCognatesFromDiachrony('proto', 'daughter', [
      { concept: 'a', lemma: 'tata',   evolved: 'tada'   }, // dist 1
      { concept: 'b', lemma: 'kama',   evolved: 'gama'   }, // dist 1
      { concept: 'c', lemma: 'pipapa', evolved: 'piba'   }, // dist 3
    ]);
    const roots = buildFamilyTree(['proto', 'daughter'], cognates);
    const d = roots[0]!.children[0]!;
    expect(d.ruleSummary).toBe('pipapa → piba');
    expect(d.sampleChange).toEqual({ concept: 'c', lemma: 'pipapa', evolved: 'piba' });
  });
});
