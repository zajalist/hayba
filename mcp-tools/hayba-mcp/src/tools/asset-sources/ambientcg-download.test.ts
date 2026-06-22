import { describe, it, expect } from 'vitest';
import { assetInfoUrl, pickZipUrl } from './ambientcg-download.js';

// Real v2 full_json shape: downloadFolders is an OBJECT keyed by folder name,
// each with a downloadFiletypeCategories.zip.downloads[] list.
const SAMPLE = {
  foundAssets: [
    {
      assetId: 'Ground037',
      downloadFolders: {
        default: {
          downloadFiletypeCategories: {
            zip: {
              downloads: [
                { attribute: '1K-JPG', fullDownloadPath: 'https://ambientcg.com/get?file=Ground037_1K-JPG.zip' },
                { attribute: '2K-JPG', fullDownloadPath: 'https://ambientcg.com/get?file=Ground037_2K-JPG.zip' },
                { attribute: '4K-PNG', downloadLink: 'https://ambientcg.com/get?file=Ground037_4K-PNG.zip' },
              ],
            },
          },
        },
      },
    },
  ],
};

describe('ambientcg-download', () => {
  it('requests include=downloadData (else downloadFolders is empty)', () => {
    expect(assetInfoUrl('Ground037')).toContain('include=downloadData');
  });

  it('resolves an exact attribute match from the object-shaped folders', () => {
    expect(pickZipUrl(SAMPLE, '2K-JPG')).toBe('https://ambientcg.com/get?file=Ground037_2K-JPG.zip');
  });

  it('is case-insensitive on the attribute', () => {
    expect(pickZipUrl(SAMPLE, '2k-jpg')).toBe('https://ambientcg.com/get?file=Ground037_2K-JPG.zip');
  });

  it('falls back to downloadLink when fullDownloadPath is absent', () => {
    expect(pickZipUrl(SAMPLE, '4K-PNG')).toBe('https://ambientcg.com/get?file=Ground037_4K-PNG.zip');
  });

  it('falls back to the first available zip for an unknown attribute', () => {
    expect(pickZipUrl(SAMPLE, 'nope')).toBe('https://ambientcg.com/get?file=Ground037_1K-JPG.zip');
  });

  it('returns null when there are no download folders', () => {
    expect(pickZipUrl({ foundAssets: [{ downloadFolders: {} }] }, '2K-JPG')).toBeNull();
  });
});
