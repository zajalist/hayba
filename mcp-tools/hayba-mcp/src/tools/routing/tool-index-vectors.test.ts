import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ToolIndex, type ToolDoc, type EmbeddingBackend } from './tool-index.js';

// Vector search behaviour, exercised with a deterministic stub backend so the
// tests say something exact and do not depend on a model being installed.

function doc(name: string, summary: string, description = ''): ToolDoc {
  return { name, summary, description, tags: [], packs: ['test'], cost: 'low' };
}

const DOCS: ToolDoc[] = [
  doc('actor_delete', 'removing an actor from the level', 'Delete an actor.'),
  doc('material_set_param', 'setting a material parameter', 'Set roughness, metallic, colour.'),
  doc('ui_validate', 'checking a screen against UI standards', 'Text overflow and contrast.'),
  doc('landscape_list', 'listing landscapes', 'Enumerate landscape actors.'),
];

/** Deterministic stand-in: each document gets a one-hot vector, and a query
 *  maps to whichever document name it mentions. Lets the fusion be tested
 *  without asserting anything about a real model's judgement. */
function stubBackend(queryTarget: Record<string, string>): EmbeddingBackend {
  const index = new Map(DOCS.map((d, i) => [d.name, i]));
  const vec = (slot: number): Float32Array => {
    const v = new Float32Array(DOCS.length);
    if (slot >= 0) v[slot] = 1;
    return v;
  };
  let callCount = 0;
  return {
    id: 'stub',
    async embed(texts: string[]): Promise<Float32Array[]> {
      callCount++;
      return texts.map((t) => {
        // Documents are embedded in DOCS order on the bulk call.
        const owner = DOCS.find((d) => t.includes(d.summary));
        if (owner) return vec(index.get(owner.name)!);
        const target = queryTarget[t];
        return vec(target ? index.get(target)! : -1);
      });
    },
    get calls() {
      return callCount;
    },
  } as EmbeddingBackend & { calls: number };
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hayba-vecidx-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('vector persistence', () => {
  it('writes vectors to the cache and reuses them on the next build', async () => {
    const backend = stubBackend({}) as EmbeddingBackend & { calls: number };
    await ToolIndex.build(DOCS, { embeddings: backend, cacheDir: dir });

    const vecPath = join(dir, 'tool-index.vec.json');
    expect(existsSync(vecPath), 'vectors should be cached to disk').toBe(true);

    const callsAfterCold = backend.calls;
    await ToolIndex.build(DOCS, { embeddings: backend, cacheDir: dir });
    // A warm build must not re-embed the corpus. Re-embedding costs seconds on
    // the path between a request arriving and anything happening.
    expect(backend.calls).toBe(callsAfterCold);
  });

  it('re-embeds rather than trusting a corrupt cache', async () => {
    const backend = stubBackend({}) as EmbeddingBackend & { calls: number };
    await ToolIndex.build(DOCS, { embeddings: backend, cacheDir: dir });

    writeFileSync(join(dir, 'tool-index.vec.json'), '{ not json');
    const before = backend.calls;
    const idx = await ToolIndex.build(DOCS, { embeddings: backend, cacheDir: dir });

    expect(backend.calls).toBeGreaterThan(before);
    expect((await idx.search('actor_delete', { k: 1 })).length).toBeGreaterThan(0);
  });

  it('re-embeds when the cache is missing a document', async () => {
    const backend = stubBackend({}) as EmbeddingBackend & { calls: number };
    await ToolIndex.build(DOCS, { embeddings: backend, cacheDir: dir });

    const raw = JSON.parse(readFileSync(join(dir, 'tool-index.vec.json'), 'utf-8')) as Record<string, number[]>;
    delete raw['ui_validate'];
    writeFileSync(join(dir, 'tool-index.vec.json'), JSON.stringify(raw));

    const before = backend.calls;
    await ToolIndex.build(DOCS, { embeddings: backend, cacheDir: dir });
    // A partial cache would silently leave one tool unrankable by meaning.
    expect(backend.calls).toBeGreaterThan(before);
  });
});

describe('vector fusion', () => {
  it('lets semantics decide when no document contains every query term', async () => {
    // "make the surface shiny" shares no full term set with any document, so
    // the lexical pass is guessing and the embedding should lead.
    const backend = stubBackend({ 'make the surface shiny': 'material_set_param' });
    const idx = await ToolIndex.build(DOCS, { embeddings: backend });
    const hits = await idx.search('make the surface shiny', { k: 3 });
    expect(hits[0]?.name).toBe('material_set_param');
  });

  it('still answers an exact lexical query from the lexical side', async () => {
    // When the name matches outright, semantics must not override it.
    const backend = stubBackend({ landscape_list: 'material_set_param' });
    const idx = await ToolIndex.build(DOCS, { embeddings: backend });
    const hits = await idx.search('landscape_list', { k: 3 });
    expect(hits[0]?.name).toBe('landscape_list');
  });

  it('returns nothing for a query that matches neither lexically nor semantically', async () => {
    // Without a similarity floor every query returns something, because some
    // document is always the least dissimilar — which quietly undoes the
    // "no confident wrong answers" property that BM25-only search has.
    const backend = stubBackend({});
    const idx = await ToolIndex.build(DOCS, { embeddings: backend });
    const hits = await idx.search('zorblax quibbleflum wuzzlewump', { k: 5 });
    expect(hits).toHaveLength(0);
  });

  it('works with no embedding backend at all', async () => {
    const idx = await ToolIndex.build(DOCS, { embeddings: null });
    const hits = await idx.search('actor', { k: 3 });
    expect(hits.map((h) => h.name)).toContain('actor_delete');
  });
});
