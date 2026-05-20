import { describe, it, expect, vi, afterEach } from 'vitest';
import { handlePolyhavenSearch, buildSearchUrl } from '../../../src/tools/asset-sources/polyhaven-search.js';
import { pickDownloads, filesUrl } from '../../../src/tools/asset-sources/polyhaven-download.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('polyhaven search', () => {
  it('builds the expected /assets URL', () => {
    const url = buildSearchUrl({ query: 'rock', type: 'textures' } as any);
    expect(url).toContain('https://api.polyhaven.com/assets?');
    expect(url).toContain('type=textures');
    expect(url).toContain('search=rock');
  });

  it('returns a list of results from mocked /assets', async () => {
    const fakeBody = {
      rock_01: { name: 'Rock 01', tags: ['rock'], categories: ['rock'] },
      rock_02: { name: 'Rock 02', tags: ['rock'] },
    };
    vi.spyOn(global, 'fetch').mockResolvedValue(new Response(JSON.stringify(fakeBody), { status: 200 }));
    const r = await handlePolyhavenSearch({ query: 'rock', type: 'textures' } as any);
    const payload = JSON.parse((r.content as any)[0].text);
    expect(payload.source).toBe('polyhaven');
    expect(payload.count).toBe(2);
    expect(payload.results[0]).toMatchObject({ id: 'rock_01', license: 'CC0' });
  });
});

describe('polyhaven download — URL construction', () => {
  it('builds /files URL for an asset', () => {
    expect(filesUrl('rock_01')).toBe('https://api.polyhaven.com/files/rock_01');
  });

  it('picks 2k jpg map URLs from the files payload', () => {
    const files = {
      Diffuse: { '2k': { jpg: { url: 'https://cdn/d.jpg' } } },
      Normal:  { '2k': { jpg: { url: 'https://cdn/n.jpg' } }, '4k': { jpg: { url: 'https://cdn/n4.jpg' } } },
      Rough:   { '1k': { jpg: { url: 'https://cdn/r1.jpg' } } }, // wrong res — skipped
    };
    const picks = pickDownloads(files, 'textures', '2k');
    const names = picks.map(p => p.mapName).sort();
    expect(names).toEqual(['Diffuse', 'Normal']);
    expect(picks.find(p => p.mapName === 'Normal')?.url).toBe('https://cdn/n.jpg');
  });

  it('prefers HDR for hdris', () => {
    const files = { hdri: { '2k': { hdr: { url: 'https://cdn/x.hdr' } } } };
    const picks = pickDownloads(files, 'hdris', '2k');
    expect(picks).toHaveLength(1);
    expect(picks[0].url).toBe('https://cdn/x.hdr');
  });
});
