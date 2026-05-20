import { describe, it, expect } from 'vitest';
import { ToolIndex, type ToolDoc } from './tool-index.js';

const docs: ToolDoc[] = [
  { name: 'actor_spawn', summary: 'Spawn an actor', description: 'Spawn an actor in the UE level', tags: ['ue', 'editor'], packs: ['actor', 'biome'], cost: 'low' },
  { name: 'create_pcg_graph', summary: 'Create a PCG graph', description: 'Create a procedural content generation graph', tags: ['pcg'], packs: ['biome'], cost: 'medium' },
  { name: 'hayba_planet_dynamo_field', summary: 'Compute dynamo field', description: 'Planetary magnetic dynamo field strength', tags: ['planet', 'physics'], packs: ['planet'], cost: 'high' },
];

describe('ToolIndex BM25', () => {
  it('ranks exact-token matches first', async () => {
    const idx = await ToolIndex.build(docs, { embeddings: null });
    const hits = await idx.search('spawn actor', { k: 3 });
    expect(hits[0].name).toBe('actor_spawn');
  });

  it('returns empty array on no hits', async () => {
    const idx = await ToolIndex.build(docs, { embeddings: null });
    const hits = await idx.search('zzzzzzz nomatch', { k: 3 });
    expect(hits).toEqual([]);
  });

  it('filterPack restricts results', async () => {
    const idx = await ToolIndex.build(docs, { embeddings: null });
    const hits = await idx.search('graph', { k: 5, filterPack: 'planet' });
    expect(hits.find(h => h.name === 'create_pcg_graph')).toBeUndefined();
  });
});
