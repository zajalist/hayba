import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const fetchMock = vi.fn();
const ORIG_FETCH = globalThis.fetch;

beforeEach(() => {
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  fetchMock.mockReset();
});

afterEach(() => {
  globalThis.fetch = ORIG_FETCH;
  delete process.env.HAYBA_IMAGEGEN_URL;
  delete process.env.HAYBA_REFERENCE_DIR;
});

import { haybaGenerateMoodboardHandler } from '../../src/tools/visual/hayba-generate-moodboard.js';
import { haybaFetchReferencesHandler } from '../../src/tools/visual/hayba-fetch-references.js';
import { haybaCompareClipScoreHandler } from '../../src/tools/visual/hayba-compare-clip-score.js';
import { cosineSimilarity } from '../../src/tools/visual/sidecar-client.js';

const fakeSession = {} as any;

describe('cosineSimilarity', () => {
  it('returns 1 for identical vectors', () => {
    expect(cosineSimilarity([1, 0, 0], [1, 0, 0])).toBeCloseTo(1);
  });
  it('returns 0 for orthogonal vectors', () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
  });
  it('returns 0 for empty or mismatched', () => {
    expect(cosineSimilarity([], [])).toBe(0);
    expect(cosineSimilarity([1], [1, 2])).toBe(0);
  });
});

describe('hayba_generate_moodboard', () => {
  it('errors when HAYBA_IMAGEGEN_URL unset', async () => {
    const r = await haybaGenerateMoodboardHandler({ prompt: 'forest at dusk' }, fakeSession);
    expect(r.isError).toBe(true);
  });

  it('forwards to image gen + enriches with embeddings', async () => {
    process.env.HAYBA_IMAGEGEN_URL = 'http://imggen.test/gen';
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ images: [{ base64: 'aGVsbG8=' }, { base64: 'd29ybGQ=' }] }),
      } as Response)
      .mockResolvedValue({ ok: true, json: async () => ({ embedding: [0.1, 0.2, 0.3], dim: 3 }) } as Response);

    const r = await haybaGenerateMoodboardHandler({ prompt: 'forest at dusk' }, fakeSession);
    expect(r.isError).toBeFalsy();
    const payload = JSON.parse(r.content[0].text);
    expect(payload.images).toHaveLength(2);
    expect(payload.images[0].clip_embedding).toEqual([0.1, 0.2, 0.3]);
  });

  it('rejects empty prompt', async () => {
    process.env.HAYBA_IMAGEGEN_URL = 'http://imggen.test/gen';
    const r = await haybaGenerateMoodboardHandler({ prompt: '' }, fakeSession);
    expect(r.isError).toBe(true);
  });
});

describe('hayba_fetch_references', () => {
  it('returns empty result with note when reference dir missing', async () => {
    process.env.HAYBA_REFERENCE_DIR = '/no/such/dir/should/exist/here';
    const r = await haybaFetchReferencesHandler({ keywords: ['forest'] }, fakeSession);
    expect(r.isError).toBeFalsy();
    const payload = JSON.parse(r.content[0].text);
    expect(payload.references).toHaveLength(0);
    expect(payload.note).toContain('HAYBA_REFERENCE_DIR');
  });

  it('rejects empty keywords', async () => {
    const r = await haybaFetchReferencesHandler({ keywords: [] }, fakeSession);
    expect(r.isError).toBe(true);
  });
});

describe('hayba_compare_clip_score', () => {
  it('computes cosine sim of two embeddings', async () => {
    fetchMock
      .mockResolvedValueOnce({ ok: true, json: async () => ({ embedding: [1, 0, 0], dim: 3 }) } as Response)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ embedding: [1, 0, 0], dim: 3 }) } as Response);
    const r = await haybaCompareClipScoreHandler({ image_a_base64: 'a', image_b_base64: 'b' }, fakeSession);
    expect(r.isError).toBeFalsy();
    const payload = JSON.parse(r.content[0].text);
    expect(payload.cosine_similarity).toBeCloseTo(1);
  });

  it('rejects empty image data', async () => {
    const r = await haybaCompareClipScoreHandler({ image_a_base64: '', image_b_base64: 'b' }, fakeSession);
    expect(r.isError).toBe(true);
  });

  it('surfaces sidecar error', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500, text: async () => 'sidecar down' } as Response);
    const r = await haybaCompareClipScoreHandler({ image_a_base64: 'a', image_b_base64: 'b' }, fakeSession);
    expect(r.isError).toBe(true);
  });
});
