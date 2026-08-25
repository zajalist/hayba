import { describe, it, expect, vi } from 'vitest';
import { rankAssetsByIntent, type AssetCandidate, type RankDeps } from './asset-intent-match.js';

/** Vectors chosen so the expected ordering is arithmetic, not vibes. */
const VEC = {
  intent: [1, 0, 0],
  looksRight: [0.9, 0.1, 0],
  looksWrong: [0, 1, 0],
  opposite: [-1, 0, 0],
};

function deps(over: Partial<RankDeps> = {}): RankDeps {
  return {
    embedText: vi.fn(async () => ({ embeddings: [VEC.intent], dim: 3 })),
    embedImage: vi.fn(async () => ({ embedding: VEC.looksRight, dim: 3 })),
    ...over,
  } as RankDeps;
}

const asset = (name: string, thumb = 'AAAA'): AssetCandidate =>
  ({ path: `/Game/${name}.${name}`, name, thumbnail_b64: thumb });

describe('ranking assets by what they look like', () => {
  it('puts the closer match first', async () => {
    const byThumb: Record<string, number[]> = { GOOD: VEC.looksRight, BAD: VEC.looksWrong };
    const r = await rankAssetsByIntent('a mossy boulder', [asset('BAD', 'BAD'), asset('GOOD', 'GOOD')], deps({
      embedImage: vi.fn(async (b64: string) => ({ embedding: byThumb[b64]!, dim: 3 })),
    }));

    expect(r.ranked.map((x) => x.name)).toEqual(['GOOD', 'BAD']);
    expect(r.ranked[0]!.score).toBeGreaterThan(r.ranked[1]!.score);
  });

  it('embeds the intent once, however many candidates there are', async () => {
    const d = deps();
    await rankAssetsByIntent('rock', [asset('A'), asset('B'), asset('C')], d);

    // The text side does not change per candidate; paying for it forty times
    // would be forty round-trips to a GPU for one answer.
    expect(d.embedText).toHaveBeenCalledTimes(1);
    expect(d.embedImage).toHaveBeenCalledTimes(3);
  });

  it('separates what it could not look at from what scored badly', async () => {
    const r = await rankAssetsByIntent('rock', [
      asset('HasThumb'),
      { path: '/Game/NoThumb.NoThumb', name: 'NoThumb' },
    ], deps());

    // Scoring a thumbnail-less asset 0 would sort it among the poor matches,
    // as though it had been looked at and judged. It was not looked at.
    expect(r.ranked.map((x) => x.name)).toEqual(['HasThumb']);
    expect(r.unscored).toEqual([
      { path: '/Game/NoThumb.NoThumb', reason: 'no thumbnail — nothing to look at' },
    ]);
  });

  it('loses one bad thumbnail, not the whole run', async () => {
    const r = await rankAssetsByIntent('rock', [asset('OK', 'OK'), asset('BROKEN', 'BROKEN')], deps({
      embedImage: vi.fn(async (b64: string) => {
        if (b64 === 'BROKEN') throw new Error('bad image: cannot identify');
        return { embedding: VEC.looksRight, dim: 3 };
      }),
    }));

    expect(r.ranked.map((x) => x.name)).toEqual(['OK']);
    expect(r.unscored[0]!.reason).toMatch(/bad image/);
    expect(r.unavailable).toBeUndefined();
  });

  it('says the whole run failed when the intent cannot be embedded', async () => {
    const r = await rankAssetsByIntent('rock', [asset('A')], deps({
      embedText: vi.fn(async () => { throw new Error('sidecar unavailable'); }),
    }));

    // There is nothing to compare against, so this is fatal rather than
    // per-candidate -- and the caller must be able to tell "ranked nothing"
    // from "ranked everything and found nothing good".
    expect(r.unavailable).toMatch(/sidecar unavailable/);
    expect(r.ranked).toEqual([]);
  });

  it('treats an empty embedding as a failure, not a score', async () => {
    const r = await rankAssetsByIntent('rock', [asset('A')], deps({
      embedText: vi.fn(async () => ({ embeddings: [[]], dim: 0 })),
    }));

    expect(r.unavailable).toMatch(/no embedding/);
  });

  it('ranks an opposite match below an unrelated one', async () => {
    const byThumb: Record<string, number[]> = {
      OPP: VEC.opposite, ORTH: VEC.looksWrong, NEAR: VEC.looksRight,
    };
    const r = await rankAssetsByIntent('x', [asset('OPP', 'OPP'), asset('ORTH', 'ORTH'), asset('NEAR', 'NEAR')], deps({
      embedImage: vi.fn(async (b64: string) => ({ embedding: byThumb[b64]!, dim: 3 })),
    }));

    expect(r.ranked.map((x) => x.name)).toEqual(['NEAR', 'ORTH', 'OPP']);
    expect(r.ranked[2]!.score).toBeLessThan(0);
  });

  it('does not call the sidecar for an empty candidate list', async () => {
    const d = deps();
    const r = await rankAssetsByIntent('rock', [], d);

    expect(r.ranked).toEqual([]);
    expect(d.embedText).not.toHaveBeenCalled();
  });

  it('breaks ties by path so the order is stable', async () => {
    const r = await rankAssetsByIntent('x', [asset('Zed'), asset('Alpha')], deps());
    expect(r.ranked.map((x) => x.name)).toEqual(['Alpha', 'Zed']);
  });
});
