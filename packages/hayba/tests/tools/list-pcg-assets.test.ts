import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockSend = vi.fn();
vi.mock('../../src/tcp-client.js', () => ({
  ensureConnected: vi.fn(async () => ({ send: mockSend })),
}));

describe('list-pcg-assets', () => {
  beforeEach(() => { mockSend.mockReset(); });

  it('returns asset data from UE', async () => {
    const { listPcgAssets } = await import('../../src/tools/list-pcg-assets.js');
    mockSend.mockResolvedValue({ id: '1', ok: true, data: { assets: [{ name: 'MyGraph', path: '/Game/PCG/MyGraph' }] } });
    const result = await listPcgAssets({});
    expect(result).toEqual({ assets: [{ name: 'MyGraph', path: '/Game/PCG/MyGraph' }] });
    expect(mockSend).toHaveBeenCalledWith('list_pcg_assets', { path: '/Game/' });
  });

  it('uses custom path when provided', async () => {
    const { listPcgAssets } = await import('../../src/tools/list-pcg-assets.js');
    mockSend.mockResolvedValue({ id: '2', ok: true, data: { assets: [] } });
    await listPcgAssets({ path: '/Game/MyProject/PCG' });
    expect(mockSend).toHaveBeenCalledWith('list_pcg_assets', { path: '/Game/MyProject/PCG' });
  });

  it('throws on TCP error', async () => {
    const { listPcgAssets } = await import('../../src/tools/list-pcg-assets.js');
    mockSend.mockResolvedValue({ id: '3', ok: false, error: 'Not found' });
    await expect(listPcgAssets({})).rejects.toThrow('Not found');
  });

  it('throws on network error', async () => {
    const { listPcgAssets } = await import('../../src/tools/list-pcg-assets.js');
    mockSend.mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(listPcgAssets({})).rejects.toThrow('ECONNREFUSED');
  });

  it('defaults path to /Game/ when undefined', async () => {
    const { listPcgAssets } = await import('../../src/tools/list-pcg-assets.js');
    mockSend.mockResolvedValue({ id: '4', ok: true, data: { assets: [] } });
    await listPcgAssets({ path: undefined });
    expect(mockSend).toHaveBeenCalledWith('list_pcg_assets', { path: '/Game/' });
  });
});
