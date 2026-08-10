import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { selectEmbeddingBackend } from './embedding-backends.js';
import { ToolIndex, type ToolDoc } from './tool-index.js';

const docs: ToolDoc[] = [
  {
    name: 'actor_spawn',
    summary: 'Spawn an actor',
    description: 'Place a static mesh actor in the level',
    tags: ['actor', 'level'],
    packs: ['actor'],
    cost: 'low',
  },
  {
    name: 'material_set_param',
    summary: 'Set a material parameter',
    description: 'Change roughness or metallic material values',
    tags: ['material'],
    packs: ['material'],
    cost: 'low',
  },
];

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('embedding backend fallback', () => {
  it('bounds the optional Ollama probe and returns null when the network is offline', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('network unavailable'));
    vi.stubGlobal('fetch', fetchMock);

    await expect(selectEmbeddingBackend()).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/api\/embeddings$/);
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('builds a cold lexical cache and returns deterministic results after an offline probe', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hayba-offline-index-'));
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('offline')));

    try {
      const backend = await selectEmbeddingBackend();
      expect(backend).toBeNull();
      expect(existsSync(join(dir, 'tool-index.meta.json'))).toBe(false);

      const cold = await ToolIndex.build(docs, { embeddings: backend, cacheDir: dir });
      const coldHits = await cold.search('spawn actor', { k: 2 });
      expect(existsSync(join(dir, 'tool-index.meta.json'))).toBe(true);
      expect(existsSync(join(dir, 'tool-index.bm25.json'))).toBe(true);
      expect(existsSync(join(dir, 'tool-index.vec.json'))).toBe(false);

      const warm = await ToolIndex.build(docs, { embeddings: backend, cacheDir: dir });
      const warmHits = await warm.search('spawn actor', { k: 2 });
      expect(coldHits.map(({ name, score }) => ({ name, score }))).toEqual(
        warmHits.map(({ name, score }) => ({ name, score })),
      );
      expect(coldHits[0]?.name).toBe('actor_spawn');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
