import { describe, it, expect, vi, beforeEach } from 'vitest';

const executeCommandMock = vi.fn();
vi.mock('../tool-executor.js', () => ({
  executeCommand: (...args: unknown[]) => executeCommandMock(...(args as [])),
}));

const rankMock = vi.fn();
vi.mock('./asset-intent-match.js', () => ({
  rankAssetsByIntent: (...args: unknown[]) => rankMock(...(args as [])),
}));

const { assetFindByLook, THUMBNAIL_CAP } = await import('./asset-find-by-look.js');

const found = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    path: `/Game/A${i}.A${i}`, name: `A${i}`, thumbnail_b64: `THUMB${i}`,
  }));

beforeEach(() => {
  executeCommandMock.mockReset();
  rankMock.mockReset();
  rankMock.mockResolvedValue({ ranked: [], unscored: [] });
});

describe('asset_find_by_look', () => {
  it('asks for thumbnails, because otherwise there is nothing to look at', async () => {
    executeCommandMock.mockResolvedValue({ assets: found(2) });

    await assetFindByLook({ intent: 'a mossy boulder' });

    const [cmd, params] = executeCommandMock.mock.calls[0]!;
    expect(cmd).toBe('asset_search');
    expect((params as { include_thumbnails: boolean }).include_thumbnails).toBe(true);
  });

  it('passes the filters through so fewer assets are embedded', async () => {
    executeCommandMock.mockResolvedValue({ assets: found(1) });

    await assetFindByLook({ intent: 'rock', path: '/Game/Env', class_filter: 'StaticMesh' });

    const params = executeCommandMock.mock.calls[0]![1] as Record<string, unknown>;
    expect(params.path).toBe('/Game/Env');
    expect(params.class_filter).toBe('StaticMesh');
  });

  it('says so when it looked at only some of the matches', async () => {
    // asset_search stops emitting thumbnails after 50. Ranking the first 50 and
    // reporting them as "the assets" would be a different and untrue claim.
    executeCommandMock.mockResolvedValue({ assets: found(120) });

    const r = await assetFindByLook({ intent: 'rock' });

    expect(r.candidates_considered).toBe(THUMBNAIL_CAP);
    expect(r.truncated?.returned).toBe(120);
    expect(r.truncated?.note).toMatch(/only the first 50 were looked at/);
  });

  it('does not claim truncation when everything was considered', async () => {
    executeCommandMock.mockResolvedValue({ assets: found(3) });

    const r = await assetFindByLook({ intent: 'rock' });

    expect(r.truncated).toBeUndefined();
    expect(r.candidates_considered).toBe(3);
  });

  it('reports failure when the ranker could not run', async () => {
    executeCommandMock.mockResolvedValue({ assets: found(2) });
    rankMock.mockResolvedValue({ ranked: [], unscored: [], unavailable: 'sidecar unavailable' });

    const r = await assetFindByLook({ intent: 'rock' });

    // An empty ranking with ok:true would read as "no asset looks like that",
    // which is a claim this run is in no position to make.
    expect(r.ok).toBe(false);
    expect(r.unavailable).toMatch(/sidecar unavailable/);
  });

  it('carries the unscored list out to the caller', async () => {
    executeCommandMock.mockResolvedValue({ assets: found(1) });
    rankMock.mockResolvedValue({
      ranked: [{ path: '/Game/A0.A0', name: 'A0', score: 0.3 }],
      unscored: [{ path: '/Game/B.B', reason: 'no thumbnail — nothing to look at' }],
    });

    const r = await assetFindByLook({ intent: 'rock' });

    expect(r.ranked).toHaveLength(1);
    expect(r.unscored[0]!.reason).toMatch(/no thumbnail/);
  });

  it('survives a search that returns nothing', async () => {
    executeCommandMock.mockResolvedValue({});

    const r = await assetFindByLook({ intent: 'rock' });

    expect(r.ok).toBe(true);
    expect(r.candidates_considered).toBe(0);
  });
});
