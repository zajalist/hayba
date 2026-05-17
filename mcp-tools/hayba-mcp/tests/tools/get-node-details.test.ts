import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockSend = vi.fn();
vi.mock('../../src/tcp-client.js', () => ({
  ensureConnected: vi.fn(async () => ({ send: mockSend })),
}));

const mockGetNodeByClass = vi.fn();
vi.mock('../../src/catalog.js', () => ({
  getNodeByClass: mockGetNodeByClass,
}));

describe('get-node-details', () => {
  beforeEach(() => {
    mockSend.mockReset();
    mockGetNodeByClass.mockReset();
  });

  it('returns catalog entry when found locally', async () => {
    const { getNodeDetails } = await import('../../src/tools/get-node-details.js');
    mockGetNodeByClass.mockReturnValue({ class: 'PCGExBuildGraph', category: 'Spatial', description: 'Builds a graph', inputs: [], outputs: [], key_properties: [], common_patterns: [] });

    const result = await getNodeDetails({ class: 'PCGExBuildGraph' });
    expect(result.source).toBe('catalog');
    expect(result.class).toBe('PCGExBuildGraph');
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('falls back to UE runtime when not in catalog', async () => {
    const { getNodeDetails } = await import('../../src/tools/get-node-details.js');
    mockGetNodeByClass.mockReturnValue(undefined);
    mockSend.mockResolvedValue({ id: '1', ok: true, data: { class: 'PCGExCustomNode', pins: [] } });

    const result = await getNodeDetails({ class: 'PCGExCustomNode' });
    expect(result.source).toBe('ue_runtime');
    expect(mockSend).toHaveBeenCalledWith('get_node_details', { class: 'PCGExCustomNode' });
  });

  it('throws when not found in catalog or UE', async () => {
    const { getNodeDetails } = await import('../../src/tools/get-node-details.js');
    mockGetNodeByClass.mockReturnValue(undefined);
    mockSend.mockResolvedValue({ id: '2', ok: false, error: 'Unknown node class' });

    await expect(getNodeDetails({ class: 'NonExistent' })).rejects.toThrow('NonExistent');
  });

  it('throws on network failure', async () => {
    const { getNodeDetails } = await import('../../src/tools/get-node-details.js');
    mockGetNodeByClass.mockReturnValue(undefined);
    mockSend.mockRejectedValue(new Error('Timeout'));

    await expect(getNodeDetails({ class: 'PCGExTest' })).rejects.toThrow('Timeout');
  });

  it('rejects empty class name', async () => {
    const { getNodeDetails } = await import('../../src/tools/get-node-details.js');
    await expect(getNodeDetails({ class: '' })).rejects.toThrow();
  });
});
