import { describe, it, expect, vi } from 'vitest';
import { AssetVerifier } from './asset-verifier.js';

describe('AssetVerifier', () => {
  it('exists=true when registry confirms', async () => {
    const dispatch = vi.fn(async () => ({
      assets: [{ path: '/Game/A/SM_X', name: 'SM_X', class: 'StaticMesh', tags: [], lastModified: 1 }],
    }));
    const v = new AssetVerifier(dispatch);
    const r = await v.verifyPath('/Game/A/SM_X');
    expect(r.exists).toBe(true);
    if (r.exists) expect(r.doc.name).toBe('SM_X');
  });

  it('exists=false when registry returns empty', async () => {
    const dispatch = vi.fn(async () => ({ assets: [] }));
    const v = new AssetVerifier(dispatch);
    const r = await v.verifyPath('/Game/A/SM_Missing');
    expect(r.exists).toBe(false);
    if (!r.exists) expect(r.reason).toBe('not_in_registry');
  });

  it('path_mismatch when registry returns wrong path', async () => {
    const dispatch = vi.fn(async () => ({
      assets: [{ path: '/Game/A/SM_Other', name: 'SM_Other', class: 'StaticMesh', tags: [], lastModified: 1 }],
    }));
    const v = new AssetVerifier(dispatch);
    const r = await v.verifyPath('/Game/A/SM_X');
    expect(r.exists).toBe(false);
    if (!r.exists) expect(r.reason).toBe('path_mismatch');
  });

  it('registry_unavailable on transport error', async () => {
    const dispatch = vi.fn(async () => { throw new Error('transport down'); });
    const v = new AssetVerifier(dispatch);
    const r = await v.verifyPath('/Game/A/SM_X');
    expect(r.exists).toBe(false);
    if (!r.exists) expect(r.reason).toBe('registry_unavailable');
  });
});
