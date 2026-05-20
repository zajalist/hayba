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

class FakeEmbeddings {
  id = 'fake';
  async embed(texts: string[]): Promise<Float32Array[]> {
    // Hand-crafted: text containing planet/dynamo/magnetic → vector close to [1,0,0]
    // Text containing pcg/graph                            → [0,1,0]
    // Everything else                                      → [0,0,1]
    return texts.map(t => {
      if (/planet|dynamo|magnetic/i.test(t)) return new Float32Array([1, 0, 0]);
      if (/pcg|graph/i.test(t))              return new Float32Array([0, 1, 0]);
      return new Float32Array([0, 0, 1]);
    });
  }
}

describe('ToolIndex hybrid', () => {
  it('embedding hit boosts a term BM25 misses', async () => {
    const idx = await ToolIndex.build(docs, { embeddings: new FakeEmbeddings() });
    // "magnetic" appears in the description but not name/summary tokens for
    // hayba_planet_dynamo_field. BM25 alone may rank it weakly; embedding
    // similarity should rescue it via reciprocal-rank fusion.
    const hits = await idx.search('magnetic field generation', { k: 3 });
    expect(hits.some(h => h.name === 'hayba_planet_dynamo_field')).toBe(true);
  });
});
