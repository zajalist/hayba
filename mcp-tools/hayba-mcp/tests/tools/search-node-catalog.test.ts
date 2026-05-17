import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockSearchCatalog = vi.fn();
const mockGetCategories = vi.fn();
const mockGetNodesByCategory = vi.fn();

vi.mock('../../src/catalog.js', () => ({
  searchCatalog: mockSearchCatalog,
  getCategories: mockGetCategories,
  getNodesByCategory: mockGetNodesByCategory,
}));

describe('search-node-catalog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns category results when query matches a category name', async () => {
    const { searchNodeCatalog } = await import('../../src/tools/search-node-catalog.js');

    mockGetCategories.mockReturnValue(['Clustering', 'Spatial']);
    mockGetNodesByCategory.mockReturnValue([
      { class: 'PCGExCluster', category: 'Clustering', description: '', inputs: [], outputs: [], key_properties: [], common_patterns: [] },
    ]);

    const result = await searchNodeCatalog({ query: 'clustering' });
    expect(result.matchType).toBe('category');
    expect(result.results).toHaveLength(1);
    expect(mockGetNodesByCategory).toHaveBeenCalledWith('Clustering');
    expect(mockSearchCatalog).not.toHaveBeenCalled();
  });

  it('falls back to keyword search when no category matches', async () => {
    const { searchNodeCatalog } = await import('../../src/tools/search-node-catalog.js');

    mockGetCategories.mockReturnValue(['Clustering', 'Spatial']);
    mockSearchCatalog.mockReturnValue([{ class: 'PCGExBuildGraph', category: 'Spatial', description: '', inputs: [], outputs: [], key_properties: [], common_patterns: [] }]);

    const result = await searchNodeCatalog({ query: 'graph' });
    expect(result.matchType).toBe('keyword');
    expect(result.results).toHaveLength(1);
    expect(mockSearchCatalog).toHaveBeenCalledWith('graph');
  });

  it('rejects empty query', async () => {
    const { searchNodeCatalog } = await import('../../src/tools/search-node-catalog.js');
    await expect(searchNodeCatalog({ query: '' })).rejects.toThrow();
  });

  it('is case-insensitive for category matching', async () => {
    const { searchNodeCatalog } = await import('../../src/tools/search-node-catalog.js');

    mockGetCategories.mockReturnValue(['Noise And Patterns']);
    mockGetNodesByCategory.mockReturnValue([]);

    const result = await searchNodeCatalog({ query: 'NOISE AND PATTERNS' });
    expect(result.matchType).toBe('category');
    expect(mockGetNodesByCategory).toHaveBeenCalledWith('Noise And Patterns');
  });
});
