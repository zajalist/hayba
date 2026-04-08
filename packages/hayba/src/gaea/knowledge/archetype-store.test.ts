import { describe, it, expect } from 'vitest';
import { GaeaArchetypeSchema, SearchInputSchema } from './types.js';
import { embed, cosineSimilarity } from './embedder.js';

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