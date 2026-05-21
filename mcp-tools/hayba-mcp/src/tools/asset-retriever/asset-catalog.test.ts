import { describe, it, expect } from 'vitest';
import { AssetCatalog } from './asset-catalog.js';
import type { AssetDoc } from './types.js';

const fixtureDocs: AssetDoc[] = [
  { path: '/Game/A/SM_One', name: 'SM_One', class: 'StaticMesh', tags: ['tree'], source: 'project', lastModified: 0 },
  { path: '/Game/A/SM_Two', name: 'SM_Two', class: 'StaticMesh', tags: ['rock'], source: 'project', lastModified: 0 },
  { path: '/Game/B/M_Three', name: 'M_Three', class: 'Material', tags: ['tree'], source: 'polyhaven', lastModified: 0 },
];

describe('AssetCatalog', () => {
  it('lists all when no filter', () => {
    const cat = new AssetCatalog(fixtureDocs);
    const page = cat.list({}, 0, 50);
    expect(page.total).toBe(3);
    expect(page.docs).toHaveLength(3);
  });

  it('prefix-matches path', () => {
    const cat = new AssetCatalog(fixtureDocs);
    const page = cat.list({ path: '/Game/A/' }, 0, 50);
    expect(page.total).toBe(2);
  });

  it('exact-matches class + source + tag', () => {
    const cat = new AssetCatalog(fixtureDocs);
    expect(cat.list({ class: 'Material' }, 0, 50).total).toBe(1);
    expect(cat.list({ source: 'polyhaven' }, 0, 50).total).toBe(1);
    expect(cat.list({ tag: 'tree' }, 0, 50).total).toBe(2);
  });

  it('paginates correctly', () => {
    const cat = new AssetCatalog(fixtureDocs);
    const page = cat.list({}, 1, 1);
    expect(page.offset).toBe(1);
    expect(page.limit).toBe(1);
    expect(page.docs).toHaveLength(1);
    expect(page.total).toBe(3);
  });

  it('offset past end returns empty', () => {
    const cat = new AssetCatalog(fixtureDocs);
    const page = cat.list({}, 999, 50);
    expect(page.docs).toEqual([]);
    expect(page.total).toBe(3);
  });

  it('caps limit at 200', () => {
    const cat = new AssetCatalog(fixtureDocs);
    const page = cat.list({}, 0, 9999);
    expect(page.limit).toBe(200);
  });
});
