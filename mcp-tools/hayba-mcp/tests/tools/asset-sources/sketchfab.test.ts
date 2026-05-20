import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { handleSketchfabSearch, buildSearchUrl } from '../../../src/tools/asset-sources/sketchfab-search.js';
import { pickFlavourUrl, downloadInfoUrl } from '../../../src/tools/asset-sources/sketchfab-download.js';

afterEach(() => { vi.restoreAllMocks(); });

describe('sketchfab search', () => {
  beforeEach(() => { delete process.env.SKETCHFAB_API_TOKEN; });

  it('builds /search URL with downloadable=true', () => {
    const url = buildSearchUrl({ query: 'tree', downloadable: true, count: 24 } as any);
    expect(url).toContain('https://api.sketchfab.com/v3/search?');
    expect(url).toContain('type=models');
    expect(url).toContain('q=tree');
    expect(url).toContain('downloadable=true');
    expect(url).toContain('archives_flavours=true');
  });

  it('returns actionable error when token is missing', async () => {
    const r = await handleSketchfabSearch({ query: 'tree' } as any);
    expect(r.isError).toBe(true);
    expect((r.content as any)[0].text).toContain('SKETCHFAB_API_TOKEN');
    expect((r.content as any)[0].text).toContain('https://sketchfab.com/settings/password');
  });

  it('parses results when token is present', async () => {
    process.env.SKETCHFAB_API_TOKEN = 'test-token';
    const body = {
      next: null,
      results: [
        { uid: 'abc', name: 'Tree', thumbnails: { images: [{ url: 'https://cdn/t.jpg' }] }, license: { label: 'CC-BY' }, viewerUrl: 'https://sketchfab/abc', isDownloadable: true },
      ],
    };
    const fetchMock = vi.spyOn(global, 'fetch').mockResolvedValue(new Response(JSON.stringify(body), { status: 200 }));
    const r = await handleSketchfabSearch({ query: 'tree' } as any);
    const payload = JSON.parse((r.content as any)[0].text);
    expect(payload.results[0]).toMatchObject({ uid: 'abc', license: 'CC-BY' });
    // Verify Authorization header was sent
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect((init.headers as any).Authorization).toBe('Token test-token');
  });
});

describe('sketchfab download — URL construction', () => {
  it('builds /models/<uid>/download URL', () => {
    expect(downloadInfoUrl('abc-123')).toBe('https://api.sketchfab.com/v3/models/abc-123/download');
  });

  it('picks the gltf signed URL', () => {
    const info = { gltf: { url: 'https://signed/g.zip' }, usdz: { url: 'https://signed/u.zip' } };
    expect(pickFlavourUrl(info, 'gltf')).toBe('https://signed/g.zip');
    expect(pickFlavourUrl(info, 'usdz')).toBe('https://signed/u.zip');
    expect(pickFlavourUrl(info, 'source')).toBeNull();
  });
});
