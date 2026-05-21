import { describe, it, expect, vi, afterEach } from 'vitest';
import { handleAmbientCgSearch, buildSearchUrl } from '../../../src/tools/asset-sources/ambientcg-search.js';
import { pickZipUrl, assetInfoUrl } from '../../../src/tools/asset-sources/ambientcg-download.js';

afterEach(() => { vi.restoreAllMocks(); });

describe('ambientcg search', () => {
  it('builds the full_json URL with query', () => {
    const url = buildSearchUrl({ query: 'brick', type: 'Material', limit: 5 } as any);
    expect(url).toContain('https://ambientCG.com/api/v2/full_json?');
    expect(url).toContain('q=brick');
    expect(url).toContain('type=Material');
    expect(url).toContain('limit=5');
  });

  it('parses foundAssets into result shape', async () => {
    const body = {
      foundAssets: [
        { assetId: 'Bricks075A', displayName: 'Bricks 075A', previewImage: { '512-PNG': 'https://cdn/b.png' }, tags: ['brick'], category: 'Bricks' },
      ],
    };
    vi.spyOn(global, 'fetch').mockResolvedValue(new Response(JSON.stringify(body), { status: 200 }));
    const r = await handleAmbientCgSearch({ query: 'brick', type: 'Material', limit: 1 } as any);
    const payload = JSON.parse((r.content as any)[0].text);
    expect(payload.source).toBe('ambientcg');
    expect(payload.results[0]).toMatchObject({ id: 'Bricks075A', license: 'CC0', thumbnail: 'https://cdn/b.png' });
  });
});

describe('ambientcg download — URL construction', () => {
  it('builds info URL', () => {
    expect(assetInfoUrl('Bricks075A')).toContain('id=Bricks075A');
  });

  it('picks the zip matching requested attribute', () => {
    const json = {
      foundAssets: [{
        assetId: 'Bricks075A',
        downloadFolders: [{
          downloadFiletypeCategories: {
            zip: {
              downloads: [
                { attribute: '1K-JPG', fullDownloadPath: 'https://cdn/1k.zip' },
                { attribute: '2K-JPG', fullDownloadPath: 'https://cdn/2k.zip' },
                { attribute: '4K-JPG', fullDownloadPath: 'https://cdn/4k.zip' },
              ],
            },
          },
        }],
      }],
    };
    expect(pickZipUrl(json, '2K-JPG')).toBe('https://cdn/2k.zip');
    expect(pickZipUrl(json, '4K-JPG')).toBe('https://cdn/4k.zip');
  });

  it('falls back to first available zip when attribute not found', () => {
    const json = {
      foundAssets: [{
        downloadFolders: [{ downloadFiletypeCategories: { zip: { downloads: [{ attribute: '8K-PNG', fullDownloadPath: 'https://cdn/only.zip' }] } } }],
      }],
    };
    expect(pickZipUrl(json, '2K-JPG')).toBe('https://cdn/only.zip');
  });
});
