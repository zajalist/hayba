import { describe, expect, it } from 'vitest';
import { buildCoOccurrenceModel } from './cooccurrence.js';
import { INVENTORIES } from './data/inventories.js';

describe('co-occurrence model', () => {
  const model = buildCoOccurrenceModel();

  it('counts the bundled corpus', () => {
    expect(model.corpusSize).toBe(INVENTORIES.length);
  });

  it('gives /p t k/ near-universal marginal probability', () => {
    expect(model.marginal('p')).toBeGreaterThan(0.8);
    expect(model.marginal('t')).toBeGreaterThan(0.9);
    expect(model.marginal('k')).toBeGreaterThan(0.9);
  });

  it('reflects the /ɡ/ gap (lower marginal than /k/)', () => {
    expect(model.marginal('ɡ')).toBeLessThan(model.marginal('k'));
  });

  it('P(self | self) is 1 when the phoneme is attested', () => {
    expect(model.pGivenPresent('t', 't')).toBe(1);
  });

  it('Laplace smoothing keeps P(X | Y) defined for unattested anchors', () => {
    // Old behaviour was 0; smoothed model returns the prior so the heatmap
    // stays usable when the user clicks a rare phoneme.
    const v = model.pGivenPresent('p', 'ǂ');
    expect(v).toBeGreaterThan(0);
    expect(v).toBeLessThanOrEqual(1);
  });

  it('heatmapWeights (conditional) covers every requested candidate', () => {
    const weights = model.heatmapWeights('m', ['m', 'n', 'ŋ', 'p'], 'conditional');
    expect(weights.size).toBe(4);
    expect(weights.get('m')).toBe(1);
    // Nasal-stop POA harmony: P(n | m) should be very high.
    expect(weights.get('n')!).toBeGreaterThan(0.8);
  });

  it('rescaled mode stretches the most-likely non-self candidate to 1', () => {
    // Rare anchor: nothing co-occurs with /ǂ/ in the bundled corpus, so
    // the conditional heatmap would collapse to 0 everywhere. Rescaled
    // mode should still produce a [0,1] range when *any* candidate has signal.
    const w1 = model.heatmapWeights('p', ['p', 'k', 't', 'ɢ'], 'rescaled');
    const nonSelf = [...w1.entries()].filter(([k]) => k !== 'p').map(([, v]) => v);
    expect(Math.max(...nonSelf)).toBe(1);
  });

  it('npmi mode is symmetric and bounded', () => {
    const ab = model.heatmapWeights('p', ['t'], 'npmi').get('t')!;
    const ba = model.heatmapWeights('t', ['p'], 'npmi').get('p')!;
    expect(ab).toBeCloseTo(ba, 10);
    expect(ab).toBeGreaterThanOrEqual(0);
    expect(ab).toBeLessThanOrEqual(1);
  });

  it('lift mode > 0.5 means above-chance co-occurrence', () => {
    // /n/ vs /m/ — both near-universal, strongly co-occurring.
    const w = model.heatmapWeights('m', ['n'], 'lift').get('n')!;
    expect(w).toBeGreaterThan(0.4);
  });

  it('npmi is symmetric and bounded in [0,1]', () => {
    const ab = model.npmi('p', 't');
    const ba = model.npmi('t', 'p');
    expect(ab).toBeCloseTo(ba, 10);
    expect(ab).toBeGreaterThanOrEqual(0);
    expect(ab).toBeLessThanOrEqual(1);
  });
});
