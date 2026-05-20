import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { ToolIndex, type ToolDoc } from '../tool-index.js';
import { searchToolsHandler, searchToolsSchema } from './search-tools.js';

const docs: ToolDoc[] = [
  { name: 'actor_spawn', summary: 'Spawn an actor', description: '', tags: [], packs: ['actor'], cost: 'low' },
];

describe('hayba_search_tools', () => {
  it('returns ranked hits', async () => {
    const idx = await ToolIndex.build(docs, { embeddings: null });
    const res = await searchToolsHandler({ query: 'spawn', k: 3 }, { index: idx });
    expect(res.hits[0].name).toBe('actor_spawn');
  });

  it('schema accepts optional filterPack', () => {
    const parsed = z.object(searchToolsSchema).parse({ query: 'x', filterPack: 'biome' });
    expect(parsed.filterPack).toBe('biome');
  });
});
