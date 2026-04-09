import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { GaeaArchetypeSchema, SearchInputSchema } from './types.js';
import { embed, cosineSimilarity } from './embedder.js';
import { ArchetypeStore } from './archetype-store.js';
import { writeFileSync, mkdirSync, rmSync } from 'fs';
import path from 'path';
import { tmpdir } from 'os';

describe('embedder', () => {
  it('produces a non-zero vector for a text input', async () => {
    const vec = await embed('coastal cliffs with erosion');
    expect(vec.length).toBe(384);
    expect(vec.some(v => v !== 0)).toBe(true);
  }, 30_000);

  it('cosine similarity: identical texts score ~1.0', async () => {
    const a = await embed('desert canyon');
    const b = await embed('desert canyon');
    expect(cosineSimilarity(a, b)).toBeCloseTo(1.0, 2);
  }, 30_000);

  it('cosine similarity: related texts score higher than unrelated', async () => {
    const query = await embed('snowy mountain peaks');
    const related = await embed('alpine ridges with snow coverage');
    const unrelated = await embed('tropical beach with palm trees');
    expect(cosineSimilarity(query, related)).toBeGreaterThan(cosineSimilarity(query, unrelated));
  }, 30_000);
});

describe('GaeaArchetypeSchema', () => {
  it('validates a well-formed archetype entry', () => {
    const entry = {
      pattern_name: 'Fluvial Desert Canyon',
      semantic_intent: 'Deep winding riverbeds in arid terrain using anastomosis and low-duration erosion',
      core_topology: ['Mountain', 'Erosion', 'Anastomosis', 'Combine'],
      heuristic_parameters: {
        'Erosion.Duration': { value: 0.05, reason: 'Keeps fluvial channels shallow for young geological age' },
      },
      biome_tags: ['desert', 'canyon'],
      scale_reference: '400m x 400m scene',
      source_video_id: 'abc123',
    };
    const result = GaeaArchetypeSchema.safeParse(entry);
    expect(result.success).toBe(true);
  });

  it('rejects entry missing required fields', () => {
    const result = GaeaArchetypeSchema.safeParse({ pattern_name: 'x' });
    expect(result.success).toBe(false);
  });

  it('allows null scale_reference and source_video_id', () => {
    const entry = {
      pattern_name: 'Minimal',
      semantic_intent: 'test',
      core_topology: ['Mountain'],
      heuristic_parameters: {},
      biome_tags: [],
      scale_reference: null,
      source_video_id: null,
    };
    const result = GaeaArchetypeSchema.safeParse(entry);
    expect(result.success).toBe(true);
  });

  it('parses archetype with all new fields (graph, node_reasoning, common_mistakes, sources)', () => {
    const entry = {
      pattern_name: 'Full Featured Canyon',
      semantic_intent: 'Deep canyon with full graph data',
      core_topology: ['Mountain', 'Canyon', 'Erosion'],
      heuristic_parameters: {},
      biome_tags: ['desert'],
      scale_reference: '1km x 1km',
      source_video_id: null,
      graph: {
        nodes: [
          { id: 'n1', type: 'Mountain', params: { Height: 0.8 } },
          { id: 'n2', type: 'Canyon', params: { Depth: 0.7 } },
        ],
        edges: [
          { from: 'n1', fromPort: 'Output', to: 'n2', toPort: 'Input' },
        ],
      },
      node_reasoning: {
        Mountain: 'Provides the initial height field',
        Canyon: 'Carves the canyon shape',
      },
      common_mistakes: [
        'Setting Canyon.Depth too high causes floating geometry',
        'Missing Erosion node leaves unrealistic sharp edges',
      ],
      sources: [
        { type: 'terrain_file', name: 'canyon_example.tor' },
        { type: 'transcript', video_id: 'abc123', timestamp: 142 },
      ],
    };
    const result = GaeaArchetypeSchema.safeParse(entry);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.graph).toBeDefined();
    expect(result.data.graph!.nodes).toHaveLength(2);
    expect(result.data.graph!.edges).toHaveLength(1);
    expect(result.data.node_reasoning).toEqual({
      Mountain: 'Provides the initial height field',
      Canyon: 'Carves the canyon shape',
    });
    expect(result.data.common_mistakes).toHaveLength(2);
    expect(result.data.sources).toHaveLength(2);
  });

  it('backwards compatibility: old entries without new fields parse with defaults', () => {
    const entry = {
      pattern_name: 'Old Style Entry',
      semantic_intent: 'Legacy entry without new fields',
      core_topology: ['Mountain', 'Erosion'],
      heuristic_parameters: {},
      biome_tags: ['mountain'],
      scale_reference: null,
      source_video_id: null,
    };
    const result = GaeaArchetypeSchema.safeParse(entry);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.graph).toBeUndefined();
    expect(result.data.node_reasoning).toEqual({});
    expect(result.data.common_mistakes).toEqual([]);
    expect(result.data.sources).toEqual([]);
  });

  it('validates source entries with all valid type values', () => {
    const makeEntry = (sourceType: string) => ({
      pattern_name: 'Source Test',
      semantic_intent: 'test',
      core_topology: ['Mountain'],
      heuristic_parameters: {},
      biome_tags: [],
      scale_reference: null,
      source_video_id: null,
      sources: [{ type: sourceType }],
    });
    for (const t of ['terrain_file', 'transcript', 'forum', 'blog']) {
      expect(GaeaArchetypeSchema.safeParse(makeEntry(t)).success).toBe(true);
    }
    expect(GaeaArchetypeSchema.safeParse(makeEntry('invalid_type')).success).toBe(false);
  });
});

describe('SearchInputSchema', () => {
  it('validates minimal search input', () => {
    const result = SearchInputSchema.safeParse({ query: 'coastal cliffs' });
    expect(result.success).toBe(true);
    expect(result.data!.limit).toBe(3); // default
  });

  it('validates full search input with filters', () => {
    const result = SearchInputSchema.safeParse({
      query: 'frozen coast',
      biome_tags: ['coastal', 'cold'],
      topology_filter: ['Snow', 'Erosion'],
      limit: 5,
    });
    expect(result.success).toBe(true);
  });
});

describe('ArchetypeStore', () => {
  const tmpDir = path.join(tmpdir(), 'archetype-store-test-' + Date.now());
  const indexPath = path.join(tmpDir, 'archetypes.json');
  const embeddingsPath = path.join(tmpDir, 'embeddings.json');
  const graphsDir = path.join(tmpDir, 'full-graphs');

  const sampleArchetypes = [
    {
      pattern_name: 'Coastal Shelf Base',
      semantic_intent: 'Creates flat coastal shelves with gradient erosion for shoreline terrain',
      core_topology: ['Gradient', 'Clamp', 'SlopeBlur', 'Erosion'],
      heuristic_parameters: {
        'Erosion.Duration': { value: 0.1, reason: 'Light erosion for coastal weathering' },
      },
      biome_tags: ['coastal', 'temperate'],
      scale_reference: '400m x 400m',
      source_video_id: 'VXJHETyCHJk',
    },
    {
      pattern_name: 'Desert Canyon Carved',
      semantic_intent: 'Deep winding canyons carved by ancient rivers in arid desert',
      core_topology: ['Mountain', 'Canyon', 'Erosion', 'Combine'],
      heuristic_parameters: {
        'Canyon.Depth': { value: 0.7, reason: 'Deep canyon walls for dramatic desert landscape' },
      },
      biome_tags: ['desert', 'canyon', 'arid'],
      scale_reference: '2km x 2km',
      source_video_id: 'abc123',
    },
    {
      pattern_name: 'Alpine Ridge Snow',
      semantic_intent: 'High altitude alpine ridges with snow coverage and sharp peaks',
      core_topology: ['Mountain', 'Erosion', 'Snow', 'Combine'],
      heuristic_parameters: {
        'Snow.Amount': { value: 0.6, reason: 'Heavy snow on exposed ridges' },
      },
      biome_tags: ['alpine', 'cold', 'mountain'],
      scale_reference: '1km x 1km',
      source_video_id: 'def456',
    },
  ];

  beforeAll(() => {
    mkdirSync(graphsDir, { recursive: true });
    writeFileSync(indexPath, JSON.stringify(sampleArchetypes, null, 2));
    writeFileSync(embeddingsPath, JSON.stringify({})); // empty — store will compute on init
    writeFileSync(
      path.join(graphsDir, 'coastal-shelf-base.json'),
      JSON.stringify({ nodes: {}, edges: [] })
    );
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('loads archetypes from JSON file', async () => {
    const store = new ArchetypeStore(indexPath, embeddingsPath, graphsDir);
    await store.ensureEmbeddings();
    expect(store.count).toBe(3);
  }, 30_000);

  it('semantic search ranks coastal query highest for coastal archetype', async () => {
    const store = new ArchetypeStore(indexPath, embeddingsPath, graphsDir);
    await store.ensureEmbeddings();
    const results = await store.search({ query: 'coastal shelf shoreline', limit: 2 });
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].pattern_name).toBe('Coastal Shelf Base');
  }, 30_000);

  it('filters by biome_tags', async () => {
    const store = new ArchetypeStore(indexPath, embeddingsPath, graphsDir);
    await store.ensureEmbeddings();
    const results = await store.search({ query: 'terrain', biome_tags: ['desert'], limit: 10 });
    expect(results.every(r => r.biome_tags.includes('desert'))).toBe(true);
  }, 30_000);

  it('boosts results containing topology_filter nodes', async () => {
    const store = new ArchetypeStore(indexPath, embeddingsPath, graphsDir);
    await store.ensureEmbeddings();
    const results = await store.search({ query: 'terrain', topology_filter: ['Snow'], limit: 10 });
    expect(results[0].pattern_name).toBe('Alpine Ridge Snow');
  }, 30_000);

  it('returns full graph JSON by pattern name', () => {
    const store = new ArchetypeStore(indexPath, embeddingsPath, graphsDir);
    const result = store.getFullGraph('Coastal Shelf Base');
    expect(result).not.toBeNull();
    expect(result!.pattern_name).toBe('Coastal Shelf Base');
    expect(result!.full_graph_json).toEqual({ nodes: {}, edges: [] });
  });

  it('returns null for missing full graph', () => {
    const store = new ArchetypeStore(indexPath, embeddingsPath, graphsDir);
    const result = store.getFullGraph('Desert Canyon Carved');
    expect(result).toBeNull();
  });

  it('LCS: ranks archetype with matching node order higher', async () => {
    const store = new ArchetypeStore(indexPath, embeddingsPath, graphsDir);
    await store.ensureEmbeddings();
    const results = await store.searchWithScoring({
      query: 'terrain',
      topology_filter: ['Gradient', 'Clamp', 'SlopeBlur', 'Erosion'],
      limit: 10,
    });
    expect(results[0].archetype.pattern_name).toBe('Coastal Shelf Base');
    expect(results[0].breakdown.sequenceScore).toBeGreaterThan(0);
  }, 30_000);

  it('phase flexibility: returns results across all phases when no phase detected', async () => {
    const store = new ArchetypeStore(indexPath, embeddingsPath, graphsDir);
    await store.ensureEmbeddings();
    const results = await store.search({ query: 'terrain with rocks', limit: 10 });
    expect(results.length).toBe(3);
  }, 30_000);

  it('word-boundary intent: "sand" should not false-positive on "sandstone"', async () => {
    const { analyzeQueryIntent } = await import('./archetype-store.js');
    const intent = analyzeQueryIntent('sand dunes in desert');
    expect(intent.requiredNodes).not.toContain('sandstone');
  });
});