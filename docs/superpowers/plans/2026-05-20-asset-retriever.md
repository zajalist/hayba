# Asset Retriever (Layer 3a) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add local semantic + keyword search over the user's UE Content Browser via three new always-on meta-tools, and close the silent-success hole in the existing asset connectors by routing every claimed download through an asset-registry verifier.

**Architecture:** New `src/tools/asset-retriever/` module mirroring Layer 1's routing shape: `AssetIndexer` (TCP fetch + fallback), `AssetIndex` (hybrid BM25 + Ollama/transformers.js embeddings + delta merge + persisted vectors.bin), `AssetCatalog` (paginated filter), `AssetVerifier` (single-path registry lookup). Three new always-on meta-tools: `hayba_asset_search`, `hayba_asset_browse`, `hayba_asset_reindex`. Connector downloaders (polyhaven/ambientcg/sketchfab) route their success claim through `AssetVerifier`.

**Tech Stack:** TypeScript, `@modelcontextprotocol/sdk`, vitest, zod, `minisearch`, Ollama HTTP, `@huggingface/transformers`. All deps already in package.json from Layer 1.

**Spec:** `docs/superpowers/specs/2026-05-20-asset-retriever-design.md`

---

### Task 1: Scaffold + AssetDoc type

**Files:**
- Create: `mcp-tools/hayba-mcp/src/tools/asset-retriever/README.md`
- Create: `mcp-tools/hayba-mcp/src/tools/asset-retriever/types.ts`

- [ ] **Step 1: Create dir + README**

PowerShell:
```
mkdir mcp-tools/hayba-mcp/src/tools/asset-retriever/meta-tools -Force
```

Write `mcp-tools/hayba-mcp/src/tools/asset-retriever/README.md`:
```markdown
# Asset Retriever (Layer 3a)

See `docs/superpowers/specs/2026-05-20-asset-retriever-design.md`.

- `types.ts` — `AssetDoc`, `AssetSource`.
- `asset-indexer.ts` — UE TCP fetch + fallback to list_pcg_assets.
- `asset-index.ts` — hybrid BM25 + embedding store; delta merge; persisted vectors.
- `asset-catalog.ts` — paginated filtered enumeration.
- `asset-verifier.ts` — single-path registry lookup.
- `meta-tools/` — hayba_asset_{search,browse,reindex}.
```

- [ ] **Step 2: Write types**

`mcp-tools/hayba-mcp/src/tools/asset-retriever/types.ts`:
```ts
export type AssetSource = 'project' | 'polyhaven' | 'ambientcg' | 'sketchfab' | 'fab' | 'unknown';

export interface AssetDoc {
  path: string;          // /Game/...
  name: string;          // basename
  class: string;         // StaticMesh, Material, ...
  tags: string[];        // from UE asset registry or external metadata sidecar
  source: AssetSource;
  lastModified: number;  // unix epoch ms
}

/** Infer source from a /Game/ path prefix. */
export function inferSource(path: string): AssetSource {
  if (/^\/Game\/Hayba\/Polyhaven\//i.test(path)) return 'polyhaven';
  if (/^\/Game\/Hayba\/AmbientCG\//i.test(path)) return 'ambientcg';
  if (/^\/Game\/Hayba\/Sketchfab\//i.test(path)) return 'sketchfab';
  if (/^\/Game\/Hayba\/Fab\//i.test(path)) return 'fab';
  if (/^\/Game\//.test(path)) return 'project';
  return 'unknown';
}
```

- [ ] **Step 3: Verify typecheck + commit**

```
cd mcp-tools/hayba-mcp; npm run typecheck
cd D:/Hackathons/hayba; git add mcp-tools/hayba-mcp/src/tools/asset-retriever/README.md mcp-tools/hayba-mcp/src/tools/asset-retriever/types.ts; git commit -m "chore(asset-retriever): scaffold module + AssetDoc type"
```

---

### Task 2: AssetIndexer with describe_assets fallback

**Files:**
- Create: `mcp-tools/hayba-mcp/src/tools/asset-retriever/asset-indexer.ts`
- Create: `mcp-tools/hayba-mcp/src/tools/asset-retriever/asset-indexer.test.ts`

- [ ] **Step 1: Write failing test**

```ts
import { describe, it, expect, vi } from 'vitest';
import { AssetIndexer } from './asset-indexer.js';

describe('AssetIndexer', () => {
  it('uses describe_assets when available', async () => {
    const dispatch = vi.fn(async (cmd: string) => ({
      assets: [
        { path: '/Game/Foo/SM_Rock', name: 'SM_Rock', class: 'StaticMesh', tags: ['rock'], lastModified: 1 },
      ],
    }));
    const idx = new AssetIndexer(dispatch);
    const r = await idx.build();
    expect(r.fallbackUsed).toBe(false);
    expect(r.docs).toHaveLength(1);
    expect(r.docs[0].source).toBe('project');
    expect(r.snapshotHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('falls back to list_pcg_assets on unknown_command', async () => {
    const dispatch = vi.fn(async (cmd: string) => {
      if (cmd === 'describe_assets') throw new Error('unknown_command');
      return { assets: [{ path: '/Game/Bar/SM_Foo' }] };
    });
    const idx = new AssetIndexer(dispatch);
    const r = await idx.build();
    expect(r.fallbackUsed).toBe(true);
    expect(r.docs[0].name).toBe('SM_Foo');
    expect(r.docs[0].class).toBe('Unknown');
    expect(r.docs[0].tags).toEqual([]);
  });

  it('describeDelta calls describe_assets with paths', async () => {
    const dispatch = vi.fn(async (cmd: string, args: any) => ({
      assets: args.paths.map((p: string) => ({ path: p, name: p.split('/').pop(), class: 'X', tags: [], lastModified: 1 })),
    }));
    const idx = new AssetIndexer(dispatch);
    const docs = await idx.describeDelta(['/Game/A', '/Game/B']);
    expect(docs).toHaveLength(2);
  });

  it('stable snapshotHash across builds with identical data', async () => {
    const dispatch = vi.fn(async () => ({
      assets: [{ path: '/Game/A', name: 'A', class: 'X', tags: [], lastModified: 10 }],
    }));
    const idx = new AssetIndexer(dispatch);
    const r1 = await idx.build();
    const r2 = await idx.build();
    expect(r1.snapshotHash).toBe(r2.snapshotHash);
  });
});
```

- [ ] **Step 2: Confirm failure**

`cd mcp-tools/hayba-mcp; npx vitest run src/tools/asset-retriever/asset-indexer.test.ts`
Expect: FAIL (missing module).

- [ ] **Step 3: Implement**

```ts
import { createHash } from 'node:crypto';
import { inferSource, type AssetDoc } from './types.js';

export type Dispatch = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;

export interface BuildResult {
  docs: AssetDoc[];
  snapshotHash: string;
  fallbackUsed: boolean;
}

interface DescribeAssetsResponse {
  assets: Array<{ path: string; name?: string; class?: string; tags?: string[]; lastModified?: number }>;
}

interface ListPcgAssetsResponse {
  assets: Array<{ path: string } | string>;
}

export class AssetIndexer {
  private fallbackWarned = false;

  constructor(private dispatch: Dispatch) {}

  async build(opts: { forceRefresh?: boolean } = {}): Promise<BuildResult> {
    void opts.forceRefresh; // caller handles cache invalidation
    try {
      const r = await this.dispatch('describe_assets', { path: '/Game/' }) as DescribeAssetsResponse;
      const docs = r.assets.map(a => normalize(a));
      return { docs, snapshotHash: hashDocs(docs), fallbackUsed: false };
    } catch (e) {
      if (/unknown_command/i.test((e as Error).message)) {
        if (!this.fallbackWarned) {
          console.warn('[asset-retriever] describe_assets unavailable; falling back to list_pcg_assets (path-only)');
          this.fallbackWarned = true;
        }
        const r = await this.dispatch('list_pcg_assets', { path: '/Game/' }) as ListPcgAssetsResponse;
        const docs = r.assets.map(a => {
          const path = typeof a === 'string' ? a : a.path;
          return normalize({ path });
        });
        return { docs, snapshotHash: hashDocs(docs), fallbackUsed: true };
      }
      throw e;
    }
  }

  async describeDelta(paths: string[]): Promise<AssetDoc[]> {
    if (paths.length === 0) return [];
    const r = await this.dispatch('describe_assets', { paths }) as DescribeAssetsResponse;
    return r.assets.map(a => normalize(a));
  }
}

function normalize(a: { path: string; name?: string; class?: string; tags?: string[]; lastModified?: number }): AssetDoc {
  const path = a.path;
  return {
    path,
    name: a.name ?? path.split('/').pop() ?? path,
    class: a.class ?? 'Unknown',
    tags: a.tags ?? [],
    source: inferSource(path),
    lastModified: a.lastModified ?? 0,
  };
}

function hashDocs(docs: AssetDoc[]): string {
  const h = createHash('sha256');
  for (const d of [...docs].sort((a, b) => a.path.localeCompare(b.path))) {
    h.update(`${d.path}|${d.lastModified}\n`);
  }
  return h.digest('hex');
}
```

- [ ] **Step 4: Verify + commit**

```
cd mcp-tools/hayba-mcp; npx vitest run src/tools/asset-retriever/asset-indexer.test.ts
cd D:/Hackathons/hayba; git add mcp-tools/hayba-mcp/src/tools/asset-retriever/asset-indexer.ts mcp-tools/hayba-mcp/src/tools/asset-retriever/asset-indexer.test.ts; git commit -m "feat(asset-retriever): AssetIndexer + describe_assets fallback to list_pcg_assets"
```

---

### Task 3: AssetIndex — BM25 + hybrid embeddings + delta merge + persisted vectors

**Files:**
- Create: `mcp-tools/hayba-mcp/src/tools/asset-retriever/asset-index.ts`
- Create: `mcp-tools/hayba-mcp/src/tools/asset-retriever/asset-index.test.ts`

- [ ] **Step 1: Write failing test**

```ts
import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AssetIndex } from './asset-index.js';
import type { AssetDoc } from './types.js';

const docs: AssetDoc[] = [
  { path: '/Game/Foo/SM_PineTree', name: 'SM_PineTree', class: 'StaticMesh', tags: ['tree', 'pine'], source: 'project', lastModified: 1 },
  { path: '/Game/Foo/SM_OakTree', name: 'SM_OakTree', class: 'StaticMesh', tags: ['tree', 'oak'], source: 'project', lastModified: 1 },
  { path: '/Game/Foo/M_Rock', name: 'M_Rock', class: 'Material', tags: ['rock'], source: 'project', lastModified: 1 },
];

class FakeEmb {
  id = 'fake';
  async embed(texts: string[]): Promise<Float32Array[]> {
    return texts.map(t => {
      if (/tree|pine|oak/i.test(t)) return new Float32Array([1, 0, 0]);
      if (/rock/i.test(t))          return new Float32Array([0, 1, 0]);
      return new Float32Array([0, 0, 1]);
    });
  }
}

describe('AssetIndex BM25', () => {
  it('ranks exact-token matches', async () => {
    const idx = await AssetIndex.build(docs, { embeddings: null });
    const hits = await idx.search('pine tree');
    expect(hits[0].path).toBe('/Game/Foo/SM_PineTree');
  });

  it('filterClass restricts results', async () => {
    const idx = await AssetIndex.build(docs, { embeddings: null });
    const hits = await idx.search('rock', { filterClass: 'StaticMesh' });
    expect(hits.find(h => h.path === '/Game/Foo/M_Rock')).toBeUndefined();
  });

  it('filterSource restricts results', async () => {
    const idx = await AssetIndex.build(docs, { embeddings: null });
    const hits = await idx.search('tree', { filterSource: 'polyhaven' });
    expect(hits).toEqual([]);
  });
});

describe('AssetIndex hybrid', () => {
  it('embedding hit surfaces semantic match', async () => {
    const idx = await AssetIndex.build(docs, { embeddings: new FakeEmb() });
    const hits = await idx.search('forest canopy', { k: 3 });
    // forest canopy → axis [0,0,1] for query? Actually FakeEmb maps non-tree-non-rock to [0,0,1]
    // so the test must pick a query that hits the tree axis:
    // change: search "evergreen needles" — FakeEmb returns [0,0,1] for non-keyword too...
    // Better: search "pine" which is in keyword set → embedding gives all-trees high
    const hits2 = await idx.search('pine', { k: 3 });
    expect(hits2.some(h => h.path === '/Game/Foo/SM_OakTree')).toBe(true);
  });
});

describe('AssetIndex cache', () => {
  it('cache files written + corruption recovery', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hayba-ai-'));
    try {
      const a = await AssetIndex.build(docs, { embeddings: null, cacheDir: dir });
      expect(existsSync(join(dir, 'asset-index.meta.json'))).toBe(true);
      expect(existsSync(join(dir, 'asset-index.bm25.json'))).toBe(true);

      const b = await AssetIndex.build(docs, { embeddings: null, cacheDir: dir });
      expect((await b.search('pine')).map(h => h.path)).toEqual(
        (await a.search('pine')).map(h => h.path),
      );

      writeFileSync(join(dir, 'asset-index.meta.json'), '{not json');
      const c = await AssetIndex.build(docs, { embeddings: null, cacheDir: dir });
      expect((await c.search('pine'))[0]?.path).toBe('/Game/Foo/SM_PineTree');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('AssetIndex delta', () => {
  it('addOrUpdate merges new docs', async () => {
    const idx = await AssetIndex.build(docs, { embeddings: null });
    const newDoc: AssetDoc = { path: '/Game/Foo/SM_BirchTree', name: 'SM_BirchTree', class: 'StaticMesh', tags: ['tree', 'birch'], source: 'project', lastModified: 2 };
    await idx.addOrUpdate([newDoc]);
    const hits = await idx.search('birch');
    expect(hits[0]?.path).toBe('/Game/Foo/SM_BirchTree');
  });

  it('addOrUpdate replaces existing path', async () => {
    const idx = await AssetIndex.build(docs, { embeddings: null });
    const updated: AssetDoc = { ...docs[0], tags: ['tree', 'pine', 'tall'] };
    await idx.addOrUpdate([updated]);
    const hits = await idx.search('tall');
    expect(hits[0]?.path).toBe('/Game/Foo/SM_PineTree');
  });
});
```

- [ ] **Step 2: Confirm failure**

`cd mcp-tools/hayba-mcp; npx vitest run src/tools/asset-retriever/asset-index.test.ts`
Expect: FAIL.

- [ ] **Step 3: Implement**

```ts
import MiniSearch from 'minisearch';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { AssetDoc, AssetSource } from './types.js';
import type { EmbeddingBackend } from '../routing/tool-index.js';

export interface SearchHit {
  path: string;
  name: string;
  class: string;
  tags: string[];
  source: AssetSource;
  score: number;
}

export interface SearchOpts {
  k?: number;
  filterClass?: string;
  filterSource?: AssetSource;
}

export interface BuildOpts {
  embeddings: EmbeddingBackend | null;
  cacheDir?: string;
}

const VECTORS_FORMAT_VERSION = 1;

export class AssetIndex {
  private constructor(
    private bm25: MiniSearch<AssetDoc>,
    private docs: Map<string, AssetDoc>,
    private vectors: Map<string, Float32Array> | null,
    private embeddings: EmbeddingBackend | null,
    private cacheDir: string | undefined,
  ) {}

  static async build(docs: AssetDoc[], opts: BuildOpts): Promise<AssetIndex> {
    // Try cache load
    if (opts.cacheDir) {
      const cached = tryLoadCache(opts.cacheDir, docs, opts.embeddings?.id ?? 'none');
      if (cached) {
        return new AssetIndex(
          cached.bm25, cached.docMap, cached.vectors, opts.embeddings, opts.cacheDir,
        );
      }
    }
    // Build fresh
    const bm25 = newMiniSearch();
    bm25.addAll(docs);
    let vectors: Map<string, Float32Array> | null = null;
    if (opts.embeddings) {
      vectors = new Map();
      const texts = docs.map(d => embedText(d));
      const embedded = await opts.embeddings.embed(texts);
      docs.forEach((d, i) => vectors!.set(d.path, embedded[i]));
    }
    const docMap = new Map(docs.map(d => [d.path, d]));
    if (opts.cacheDir) {
      writeCache(opts.cacheDir, docs, bm25, vectors, opts.embeddings?.id ?? 'none');
    }
    return new AssetIndex(bm25, docMap, vectors, opts.embeddings, opts.cacheDir);
  }

  async search(query: string, opts: SearchOpts = {}): Promise<SearchHit[]> {
    const k = opts.k ?? 8;
    const bm25Raw = this.bm25.search(query, { prefix: true, fuzzy: 0.2 });
    const bm25Rank = new Map<string, number>();
    bm25Raw.forEach((r, i) => bm25Rank.set(r.id as string, i + 1));

    const embRank = new Map<string, number>();
    if (this.embeddings && this.vectors && this.vectors.size > 0) {
      const qv = (await this.embeddings.embed([query]))[0];
      const scored: Array<[string, number]> = [];
      for (const [path, v] of this.vectors) scored.push([path, cosine(qv, v)]);
      scored.sort((a, b) => b[1] - a[1]);
      scored.forEach(([path], i) => embRank.set(path, i + 1));
    }

    const K_RRF = 60;
    const fused = new Map<string, number>();
    const all = new Set<string>([...bm25Rank.keys(), ...embRank.keys()]);
    for (const id of all) {
      const a = bm25Rank.get(id);
      const b = embRank.get(id);
      fused.set(id, (a ? 1 / (K_RRF + a) : 0) + (b ? 1 / (K_RRF + b) : 0));
    }

    return Array.from(fused.entries())
      .sort((x, y) => y[1] - x[1])
      .map(([path, score]) => {
        const d = this.docs.get(path)!;
        return { path: d.path, name: d.name, class: d.class, tags: d.tags, source: d.source, score };
      })
      .filter(h => (!opts.filterClass || h.class === opts.filterClass) && (!opts.filterSource || h.source === opts.filterSource))
      .slice(0, k);
  }

  async addOrUpdate(newDocs: AssetDoc[]): Promise<void> {
    for (const d of newDocs) {
      if (this.docs.has(d.path)) {
        this.bm25.discard(d.path);
      }
      this.docs.set(d.path, d);
      this.bm25.add(d);
    }
    if (this.embeddings && this.vectors) {
      const texts = newDocs.map(embedText);
      const embedded = await this.embeddings.embed(texts);
      newDocs.forEach((d, i) => this.vectors!.set(d.path, embedded[i]));
    }
    if (this.cacheDir) {
      writeCache(this.cacheDir, Array.from(this.docs.values()), this.bm25, this.vectors, this.embeddings?.id ?? 'none');
    }
  }

  allDocs(): AssetDoc[] { return Array.from(this.docs.values()); }
}

function newMiniSearch(): MiniSearch<AssetDoc> {
  return new MiniSearch<AssetDoc>({
    fields: ['path', 'name', 'class', 'tags'],
    storeFields: ['path', 'name', 'class', 'tags', 'source'],
    idField: 'path',
    extractField: (d, f) => {
      const v = (d as Record<string, unknown>)[f];
      return Array.isArray(v) ? v.join(' ') : String(v ?? '');
    },
  });
}

function embedText(d: AssetDoc): string {
  return `${d.name}. ${d.class}. ${d.tags.join(', ')}. path: ${d.path}`;
}

function hashDocs(docs: AssetDoc[]): string {
  const h = createHash('sha256');
  for (const d of [...docs].sort((a, b) => a.path.localeCompare(b.path))) {
    h.update(`${d.path}|${d.lastModified}\n`);
  }
  return h.digest('hex');
}

function packVectors(docs: AssetDoc[], vectors: Map<string, Float32Array>): Buffer {
  const sorted = [...docs].sort((a, b) => a.path.localeCompare(b.path));
  const dim = vectors.get(sorted[0]?.path)?.length ?? 0;
  const out = Buffer.alloc(8 + sorted.length * dim * 4);
  out.writeUInt32LE(dim, 0);
  out.writeUInt32LE(sorted.length, 4);
  let offset = 8;
  for (const d of sorted) {
    const v = vectors.get(d.path);
    if (!v || v.length !== dim) continue;
    for (let i = 0; i < dim; i++) {
      out.writeFloatLE(v[i], offset);
      offset += 4;
    }
  }
  return out;
}

function unpackVectors(buf: Buffer, docs: AssetDoc[]): Map<string, Float32Array> | null {
  if (buf.length < 8) return null;
  const dim = buf.readUInt32LE(0);
  const count = buf.readUInt32LE(4);
  const sorted = [...docs].sort((a, b) => a.path.localeCompare(b.path));
  if (sorted.length !== count) return null;
  if (buf.length !== 8 + count * dim * 4) return null;
  const out = new Map<string, Float32Array>();
  let offset = 8;
  for (const d of sorted) {
    const v = new Float32Array(dim);
    for (let i = 0; i < dim; i++) {
      v[i] = buf.readFloatLE(offset);
      offset += 4;
    }
    out.set(d.path, v);
  }
  return out;
}

function tryLoadCache(
  dir: string,
  docs: AssetDoc[],
  backendId: string,
): { bm25: MiniSearch<AssetDoc>; docMap: Map<string, AssetDoc>; vectors: Map<string, Float32Array> | null } | null {
  try {
    mkdirSync(dir, { recursive: true });
    const metaPath = join(dir, 'asset-index.meta.json');
    const bm25Path = join(dir, 'asset-index.bm25.json');
    const vecPath  = join(dir, 'asset-index.vectors.bin');
    if (!existsSync(metaPath) || !existsSync(bm25Path)) return null;
    const meta = JSON.parse(readFileSync(metaPath, 'utf-8')) as { hash: string; backendId: string; vectorsFormatVersion: number };
    if (meta.hash !== hashDocs(docs)) return null;
    if (meta.backendId !== backendId) return null;
    if (meta.vectorsFormatVersion !== VECTORS_FORMAT_VERSION) return null;
    const bm25 = MiniSearch.loadJSON<AssetDoc>(readFileSync(bm25Path, 'utf-8'), {
      fields: ['path', 'name', 'class', 'tags'],
      storeFields: ['path', 'name', 'class', 'tags', 'source'],
      idField: 'path',
    });
    let vectors: Map<string, Float32Array> | null = null;
    if (backendId !== 'none' && existsSync(vecPath)) {
      vectors = unpackVectors(readFileSync(vecPath), docs);
    }
    return { bm25, docMap: new Map(docs.map(d => [d.path, d])), vectors };
  } catch {
    return null;
  }
}

function writeCache(
  dir: string,
  docs: AssetDoc[],
  bm25: MiniSearch<AssetDoc>,
  vectors: Map<string, Float32Array> | null,
  backendId: string,
): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'asset-index.bm25.json'), JSON.stringify(bm25));
  writeFileSync(
    join(dir, 'asset-index.meta.json'),
    JSON.stringify({ hash: hashDocs(docs), backendId, vectorsFormatVersion: VECTORS_FORMAT_VERSION, docCount: docs.length }),
  );
  if (vectors && vectors.size > 0) {
    writeFileSync(join(dir, 'asset-index.vectors.bin'), packVectors(docs, vectors));
  }
}

function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0, na = 0, nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) + 1e-9);
}
```

- [ ] **Step 4: Verify + commit**

```
cd mcp-tools/hayba-mcp; npx vitest run src/tools/asset-retriever/asset-index.test.ts
cd D:/Hackathons/hayba; git add mcp-tools/hayba-mcp/src/tools/asset-retriever/asset-index.ts mcp-tools/hayba-mcp/src/tools/asset-retriever/asset-index.test.ts; git commit -m "feat(asset-retriever): AssetIndex with hybrid BM25+embedding + delta merge + persisted vectors"
```

---

### Task 4: AssetCatalog

**Files:**
- Create: `mcp-tools/hayba-mcp/src/tools/asset-retriever/asset-catalog.ts`
- Create: `mcp-tools/hayba-mcp/src/tools/asset-retriever/asset-catalog.test.ts`

- [ ] **Step 1: Write failing test**

```ts
import { describe, it, expect } from 'vitest';
import { AssetCatalog } from './asset-catalog.js';
import type { AssetDoc } from './types.js';

const fixtureDocs: AssetDoc[] = [
  { path: '/Game/A/SM_One', name: 'SM_One', class: 'StaticMesh', tags: ['tree'], source: 'project', lastModified: 0 },
  { path: '/Game/A/SM_Two', name: 'SM_Two', class: 'StaticMesh', tags: ['rock'], source: 'project', lastModified: 0 },
  { path: '/Game/B/M_Three', name: 'M_Three', class: 'Material', tags: ['tree'], source: 'polyhaven', lastModified: 0 },
];

describe('AssetCatalog', () => {
  it('lists all when no filter', () => {
    const cat = new AssetCatalog(fixtureDocs);
    const page = cat.list({}, 0, 50);
    expect(page.total).toBe(3);
    expect(page.docs).toHaveLength(3);
  });

  it('prefix-matches path', () => {
    const cat = new AssetCatalog(fixtureDocs);
    const page = cat.list({ path: '/Game/A/' }, 0, 50);
    expect(page.total).toBe(2);
  });

  it('exact-matches class + source + tag', () => {
    const cat = new AssetCatalog(fixtureDocs);
    expect(cat.list({ class: 'Material' }, 0, 50).total).toBe(1);
    expect(cat.list({ source: 'polyhaven' }, 0, 50).total).toBe(1);
    expect(cat.list({ tag: 'tree' }, 0, 50).total).toBe(2);
  });

  it('paginates correctly', () => {
    const cat = new AssetCatalog(fixtureDocs);
    const page = cat.list({}, 1, 1);
    expect(page.offset).toBe(1);
    expect(page.limit).toBe(1);
    expect(page.docs).toHaveLength(1);
    expect(page.total).toBe(3);
  });

  it('offset past end returns empty', () => {
    const cat = new AssetCatalog(fixtureDocs);
    const page = cat.list({}, 999, 50);
    expect(page.docs).toEqual([]);
    expect(page.total).toBe(3);
  });

  it('caps limit at 200', () => {
    const cat = new AssetCatalog(fixtureDocs);
    const page = cat.list({}, 0, 9999);
    expect(page.limit).toBe(200);
  });
});
```

- [ ] **Step 2: Confirm failure**

`cd mcp-tools/hayba-mcp; npx vitest run src/tools/asset-retriever/asset-catalog.test.ts`
Expect: FAIL.

- [ ] **Step 3: Implement**

```ts
import type { AssetDoc, AssetSource } from './types.js';

export interface Filter {
  path?: string;
  class?: string;
  tag?: string;
  source?: AssetSource;
}

export interface Page {
  total: number;
  offset: number;
  limit: number;
  docs: AssetDoc[];
}

const MAX_LIMIT = 200;

export class AssetCatalog {
  constructor(private docs: AssetDoc[]) {}

  list(filter: Filter, offset = 0, limit = 50): Page {
    const cappedLimit = Math.min(Math.max(limit, 1), MAX_LIMIT);
    const filtered = this.docs.filter(d => match(d, filter));
    const slice = filtered.slice(offset, offset + cappedLimit);
    return { total: filtered.length, offset, limit: cappedLimit, docs: slice };
  }
}

function match(d: AssetDoc, f: Filter): boolean {
  if (f.path && !d.path.startsWith(f.path)) return false;
  if (f.class && d.class !== f.class) return false;
  if (f.source && d.source !== f.source) return false;
  if (f.tag && !d.tags.includes(f.tag)) return false;
  return true;
}
```

- [ ] **Step 4: Verify + commit**

```
cd mcp-tools/hayba-mcp; npx vitest run src/tools/asset-retriever/asset-catalog.test.ts
cd D:/Hackathons/hayba; git add mcp-tools/hayba-mcp/src/tools/asset-retriever/asset-catalog.ts mcp-tools/hayba-mcp/src/tools/asset-retriever/asset-catalog.test.ts; git commit -m "feat(asset-retriever): AssetCatalog with prefix-path + multi-filter pagination"
```

---

### Task 5: AssetVerifier

**Files:**
- Create: `mcp-tools/hayba-mcp/src/tools/asset-retriever/asset-verifier.ts`
- Create: `mcp-tools/hayba-mcp/src/tools/asset-retriever/asset-verifier.test.ts`

- [ ] **Step 1: Write failing test**

```ts
import { describe, it, expect, vi } from 'vitest';
import { AssetVerifier } from './asset-verifier.js';

describe('AssetVerifier', () => {
  it('exists=true when registry confirms', async () => {
    const dispatch = vi.fn(async () => ({
      assets: [{ path: '/Game/A/SM_X', name: 'SM_X', class: 'StaticMesh', tags: [], lastModified: 1 }],
    }));
    const v = new AssetVerifier(dispatch);
    const r = await v.verifyPath('/Game/A/SM_X');
    expect(r.exists).toBe(true);
    if (r.exists) expect(r.doc.name).toBe('SM_X');
  });

  it('exists=false when registry returns empty', async () => {
    const dispatch = vi.fn(async () => ({ assets: [] }));
    const v = new AssetVerifier(dispatch);
    const r = await v.verifyPath('/Game/A/SM_Missing');
    expect(r.exists).toBe(false);
    if (!r.exists) expect(r.reason).toBe('not_in_registry');
  });

  it('path_mismatch when registry returns wrong path', async () => {
    const dispatch = vi.fn(async () => ({
      assets: [{ path: '/Game/A/SM_Other', name: 'SM_Other', class: 'StaticMesh', tags: [], lastModified: 1 }],
    }));
    const v = new AssetVerifier(dispatch);
    const r = await v.verifyPath('/Game/A/SM_X');
    expect(r.exists).toBe(false);
    if (!r.exists) expect(r.reason).toBe('path_mismatch');
  });

  it('registry_unavailable on transport error', async () => {
    const dispatch = vi.fn(async () => { throw new Error('transport down'); });
    const v = new AssetVerifier(dispatch);
    const r = await v.verifyPath('/Game/A/SM_X');
    expect(r.exists).toBe(false);
    if (!r.exists) expect(r.reason).toBe('registry_unavailable');
  });
});
```

- [ ] **Step 2: Confirm failure**

`cd mcp-tools/hayba-mcp; npx vitest run src/tools/asset-retriever/asset-verifier.test.ts`
Expect: FAIL.

- [ ] **Step 3: Implement**

```ts
import { inferSource, type AssetDoc } from './types.js';
import type { Dispatch } from './asset-indexer.js';

export type VerifyResult =
  | { exists: true; doc: AssetDoc }
  | { exists: false; reason: 'not_in_registry' | 'path_mismatch' | 'registry_unavailable'; attempted: string };

interface DescribeAssetsResponse {
  assets: Array<{ path: string; name?: string; class?: string; tags?: string[]; lastModified?: number }>;
}

export class AssetVerifier {
  constructor(private dispatch: Dispatch) {}

  async verifyPath(expectedPath: string): Promise<VerifyResult> {
    try {
      const r = await this.dispatch('describe_assets', { paths: [expectedPath] }) as DescribeAssetsResponse;
      if (!r.assets || r.assets.length === 0) {
        return { exists: false, reason: 'not_in_registry', attempted: expectedPath };
      }
      const a = r.assets[0];
      if (a.path !== expectedPath) {
        return { exists: false, reason: 'path_mismatch', attempted: expectedPath };
      }
      return {
        exists: true,
        doc: {
          path: a.path,
          name: a.name ?? a.path.split('/').pop() ?? a.path,
          class: a.class ?? 'Unknown',
          tags: a.tags ?? [],
          source: inferSource(a.path),
          lastModified: a.lastModified ?? 0,
        },
      };
    } catch {
      return { exists: false, reason: 'registry_unavailable', attempted: expectedPath };
    }
  }
}
```

- [ ] **Step 4: Verify + commit**

```
cd mcp-tools/hayba-mcp; npx vitest run src/tools/asset-retriever/asset-verifier.test.ts
cd D:/Hackathons/hayba; git add mcp-tools/hayba-mcp/src/tools/asset-retriever/asset-verifier.ts mcp-tools/hayba-mcp/src/tools/asset-retriever/asset-verifier.test.ts; git commit -m "feat(asset-retriever): AssetVerifier — strict single-path registry lookup"
```

---

### Task 6: Orchestrator — AssetRetriever facade with lazy build + delta-stale + mutex

**Files:**
- Create: `mcp-tools/hayba-mcp/src/tools/asset-retriever/asset-retriever.ts`
- Create: `mcp-tools/hayba-mcp/src/tools/asset-retriever/asset-retriever.test.ts`

- [ ] **Step 1: Write failing test**

```ts
import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AssetRetriever } from './asset-retriever.js';

function makeDispatch(initial: any[]) {
  let assets = [...initial];
  const fn = vi.fn(async (cmd: string, args: any) => {
    if (cmd === 'describe_assets') {
      if (args?.paths) return { assets: assets.filter((a: any) => args.paths.includes(a.path)) };
      return { assets };
    }
    return {};
  });
  return { fn, push: (a: any) => assets.push(a) };
}

describe('AssetRetriever', () => {
  it('lazy build — no fetch until first search', async () => {
    const { fn } = makeDispatch([{ path: '/Game/A', name: 'A', class: 'X', tags: [], lastModified: 1 }]);
    const dir = mkdtempSync(join(tmpdir(), 'hayba-ar-'));
    try {
      const ar = new AssetRetriever(fn, { cacheDir: dir });
      expect(fn).not.toHaveBeenCalled();
      await ar.search('a');
      expect(fn).toHaveBeenCalledWith('describe_assets', { path: '/Game/' });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('reindex forces fresh fetch', async () => {
    const { fn, push } = makeDispatch([{ path: '/Game/A', name: 'A', class: 'X', tags: [], lastModified: 1 }]);
    const dir = mkdtempSync(join(tmpdir(), 'hayba-ar-'));
    try {
      const ar = new AssetRetriever(fn, { cacheDir: dir });
      await ar.search('a');
      push({ path: '/Game/B', name: 'B', class: 'X', tags: [], lastModified: 2 });
      const r = await ar.reindex();
      expect(r.docCount).toBe(2);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('markDeltaStale triggers delta-merge on next search', async () => {
    const { fn, push } = makeDispatch([{ path: '/Game/A', name: 'A', class: 'X', tags: [], lastModified: 1 }]);
    const dir = mkdtempSync(join(tmpdir(), 'hayba-ar-'));
    try {
      const ar = new AssetRetriever(fn, { cacheDir: dir });
      await ar.search('a');
      push({ path: '/Game/B', name: 'B', class: 'X', tags: ['birch'], lastModified: 2 });
      ar.markDeltaStale(['/Game/B']);
      const hits = await ar.search('birch');
      expect(hits.some(h => h.path === '/Game/B')).toBe(true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('concurrent reindex calls return same in-flight promise', async () => {
    const { fn } = makeDispatch([{ path: '/Game/A', name: 'A', class: 'X', tags: [], lastModified: 1 }]);
    const dir = mkdtempSync(join(tmpdir(), 'hayba-ar-'));
    try {
      const ar = new AssetRetriever(fn, { cacheDir: dir });
      await ar.search('a');
      fn.mockClear();
      const [a, b] = await Promise.all([ar.reindex(), ar.reindex()]);
      expect(a.docCount).toBe(b.docCount);
      // Only one extra describe_assets call (the second reindex returned the in-flight result)
      expect(fn).toHaveBeenCalledTimes(1);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('browse triggers lazy build too', async () => {
    const { fn } = makeDispatch([{ path: '/Game/A', name: 'A', class: 'X', tags: [], lastModified: 1 }]);
    const dir = mkdtempSync(join(tmpdir(), 'hayba-ar-'));
    try {
      const ar = new AssetRetriever(fn, { cacheDir: dir });
      const page = await ar.browse({}, 0, 50);
      expect(page.total).toBe(1);
      expect(fn).toHaveBeenCalled();
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
```

- [ ] **Step 2: Confirm failure**

`cd mcp-tools/hayba-mcp; npx vitest run src/tools/asset-retriever/asset-retriever.test.ts`
Expect: FAIL.

- [ ] **Step 3: Implement**

```ts
import { AssetIndexer, type Dispatch } from './asset-indexer.js';
import { AssetIndex, type SearchHit, type SearchOpts } from './asset-index.js';
import { AssetCatalog, type Filter, type Page } from './asset-catalog.js';
import type { EmbeddingBackend } from '../routing/tool-index.js';
import { selectEmbeddingBackend } from '../routing/embedding-backends.js';

export interface ReindexResult {
  ok: boolean;
  durationMs: number;
  docCount: number;
  backend: 'ollama' | 'transformers' | 'bm25';
  fallbackUsed: boolean;
}

export interface AssetRetrieverOpts {
  cacheDir?: string;
  embeddings?: EmbeddingBackend | null;
}

export class AssetRetriever {
  private indexer: AssetIndexer;
  private index: AssetIndex | null = null;
  private catalog: AssetCatalog | null = null;
  private deltaStale = new Set<string>();
  private buildLock: Promise<void> | null = null;
  private embeddings: EmbeddingBackend | null | undefined;

  constructor(dispatch: Dispatch, private opts: AssetRetrieverOpts = {}) {
    this.indexer = new AssetIndexer(dispatch);
    this.embeddings = opts.embeddings;
  }

  markDeltaStale(paths: string[]): void {
    for (const p of paths) this.deltaStale.add(p);
  }

  async search(query: string, opts: SearchOpts = {}): Promise<SearchHit[]> {
    await this.ensureBuilt();
    await this.applyDeltaIfStale();
    return this.index!.search(query, opts);
  }

  async browse(filter: Filter, offset: number, limit: number): Promise<Page> {
    await this.ensureBuilt();
    await this.applyDeltaIfStale();
    return this.catalog!.list(filter, offset, limit);
  }

  async reindex(): Promise<ReindexResult> {
    if (this.buildLock) {
      await this.buildLock;
      // Caller can re-derive; return current state.
      return this.summarize(true);
    }
    const t0 = Date.now();
    const p = this.doBuild(true);
    this.buildLock = p.then(() => undefined);
    try {
      await p;
    } finally {
      this.buildLock = null;
    }
    const r = this.summarize(true);
    return { ...r, durationMs: Date.now() - t0 };
  }

  private async ensureBuilt(): Promise<void> {
    if (this.index) return;
    if (this.buildLock) { await this.buildLock; return; }
    const p = this.doBuild(false);
    this.buildLock = p.then(() => undefined);
    try {
      await p;
    } finally {
      this.buildLock = null;
    }
  }

  private async doBuild(_force: boolean): Promise<void> {
    if (this.embeddings === undefined) this.embeddings = await selectEmbeddingBackend();
    const r = await this.indexer.build();
    this.index = await AssetIndex.build(r.docs, { embeddings: this.embeddings, cacheDir: this.opts.cacheDir });
    this.catalog = new AssetCatalog(this.index.allDocs());
    this.deltaStale.clear();
  }

  private async applyDeltaIfStale(): Promise<void> {
    if (!this.index || this.deltaStale.size === 0) return;
    const paths = Array.from(this.deltaStale);
    this.deltaStale.clear();
    try {
      const newDocs = await this.indexer.describeDelta(paths);
      if (newDocs.length !== paths.length) {
        // At least one path missing from registry — full rebuild as last-known-good fallback.
        await this.doBuild(true);
        return;
      }
      await this.index.addOrUpdate(newDocs);
      this.catalog = new AssetCatalog(this.index.allDocs());
    } catch {
      // Delta fetch failed — keep current index; paths re-marked for next attempt.
      for (const p of paths) this.deltaStale.add(p);
    }
  }

  private summarize(fallbackUsed: boolean): ReindexResult {
    const docCount = this.index?.allDocs().length ?? 0;
    const backend: ReindexResult['backend'] = this.embeddings
      ? (/^ollama:/.test(this.embeddings.id) ? 'ollama' : 'transformers')
      : 'bm25';
    return { ok: true, durationMs: 0, docCount, backend, fallbackUsed };
  }
}
```

- [ ] **Step 4: Verify + commit**

```
cd mcp-tools/hayba-mcp; npx vitest run src/tools/asset-retriever/asset-retriever.test.ts
cd D:/Hackathons/hayba; git add mcp-tools/hayba-mcp/src/tools/asset-retriever/asset-retriever.ts mcp-tools/hayba-mcp/src/tools/asset-retriever/asset-retriever.test.ts; git commit -m "feat(asset-retriever): AssetRetriever facade — lazy build + delta-stale + mutex"
```

---

### Task 7: Three meta-tools

**Files:**
- Create: `mcp-tools/hayba-mcp/src/tools/asset-retriever/meta-tools/search.ts`
- Create: `mcp-tools/hayba-mcp/src/tools/asset-retriever/meta-tools/browse.ts`
- Create: `mcp-tools/hayba-mcp/src/tools/asset-retriever/meta-tools/reindex.ts`
- Create: `mcp-tools/hayba-mcp/src/tools/asset-retriever/meta-tools/meta-tools.test.ts`

- [ ] **Step 1: Write failing test**

```ts
import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AssetRetriever } from '../asset-retriever.js';
import { assetSearchHandler, assetSearchSchema } from './search.js';
import { assetBrowseHandler, assetBrowseSchema } from './browse.js';
import { assetReindexHandler } from './reindex.js';

function ar() {
  const dispatch = vi.fn(async (cmd: string) => ({
    assets: [
      { path: '/Game/A/SM_Pine', name: 'SM_Pine', class: 'StaticMesh', tags: ['tree'], lastModified: 1 },
    ],
  }));
  const dir = mkdtempSync(join(tmpdir(), 'hayba-mt-'));
  const r = new AssetRetriever(dispatch, { cacheDir: dir, embeddings: null });
  return { r, dir };
}

describe('asset meta-tools', () => {
  it('search returns hits', async () => {
    const { r, dir } = ar();
    try {
      const res = await assetSearchHandler({ query: 'pine' }, { retriever: r });
      expect(res.hits[0].path).toBe('/Game/A/SM_Pine');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('search schema accepts optional filters', () => {
    const parsed = z.object(assetSearchSchema).parse({ query: 'x', filterClass: 'StaticMesh', filterSource: 'project' });
    expect(parsed.filterClass).toBe('StaticMesh');
  });

  it('browse returns paginated page', async () => {
    const { r, dir } = ar();
    try {
      const res = await assetBrowseHandler({}, { retriever: r });
      expect(res.total).toBe(1);
      expect(res.docs).toHaveLength(1);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('reindex returns summary', async () => {
    const { r, dir } = ar();
    try {
      const res = await assetReindexHandler({}, { retriever: r });
      expect(res.ok).toBe(true);
      expect(res.docCount).toBe(1);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
```

- [ ] **Step 2: Confirm failure**

`cd mcp-tools/hayba-mcp; npx vitest run src/tools/asset-retriever/meta-tools/meta-tools.test.ts`

- [ ] **Step 3: Implement search.ts**

```ts
import { z } from 'zod';
import type { AssetRetriever } from '../asset-retriever.js';
import type { SearchHit } from '../asset-index.js';

export const assetSearchSchema = {
  query: z.string().min(1),
  k: z.number().int().min(1).max(50).optional(),
  filterClass: z.string().optional(),
  filterSource: z.enum(['project', 'polyhaven', 'ambientcg', 'sketchfab', 'fab', 'unknown']).optional(),
};

export interface AssetSearchCtx { retriever: AssetRetriever; }
export interface AssetSearchResult { hits: SearchHit[]; }

export async function assetSearchHandler(
  args: { query: string; k?: number; filterClass?: string; filterSource?: 'project' | 'polyhaven' | 'ambientcg' | 'sketchfab' | 'fab' | 'unknown' },
  ctx: AssetSearchCtx,
): Promise<AssetSearchResult> {
  const hits = await ctx.retriever.search(args.query, {
    k: args.k ?? 8,
    filterClass: args.filterClass,
    filterSource: args.filterSource,
  });
  return { hits };
}

export const meta = {
  cost: 'low' as const,
  effects: ['read'],
  when: 'You need to find an asset in the user\'s UE Content Browser by semantic intent or keyword.',
  not_when: 'You need to download a new asset from an external catalog — use hayba_polyhaven_search etc. instead.',
  pack: 'core',
};
```

- [ ] **Step 4: Implement browse.ts**

```ts
import { z } from 'zod';
import type { AssetRetriever } from '../asset-retriever.js';
import type { Page } from '../asset-catalog.js';

export const assetBrowseSchema = {
  filter: z.object({
    path: z.string().optional(),
    class: z.string().optional(),
    tag: z.string().optional(),
    source: z.enum(['project', 'polyhaven', 'ambientcg', 'sketchfab', 'fab', 'unknown']).optional(),
  }).optional(),
  offset: z.number().int().min(0).optional(),
  limit: z.number().int().min(1).max(200).optional(),
};

export interface AssetBrowseCtx { retriever: AssetRetriever; }

export async function assetBrowseHandler(
  args: { filter?: { path?: string; class?: string; tag?: string; source?: 'project' | 'polyhaven' | 'ambientcg' | 'sketchfab' | 'fab' | 'unknown' }; offset?: number; limit?: number },
  ctx: AssetBrowseCtx,
): Promise<Page> {
  return ctx.retriever.browse(args.filter ?? {}, args.offset ?? 0, args.limit ?? 50);
}

export const meta = {
  cost: 'low' as const,
  effects: ['read'],
  when: 'You want to enumerate assets by filter (path prefix, class, tag, source) without semantic ranking.',
  not_when: 'You have a semantic query — use hayba_asset_search.',
  pack: 'core',
};
```

- [ ] **Step 5: Implement reindex.ts**

```ts
import type { AssetRetriever, ReindexResult } from '../asset-retriever.js';

export const assetReindexSchema = {};

export interface AssetReindexCtx { retriever: AssetRetriever; }

export async function assetReindexHandler(_args: Record<string, never>, ctx: AssetReindexCtx): Promise<ReindexResult> {
  return ctx.retriever.reindex();
}

export const meta = {
  cost: 'medium' as const,
  effects: ['rebuild_index'],
  when: 'The user just imported a batch of new assets outside the MCP-tracked download flow.',
  not_when: 'You just called a connector download — the retriever auto-deltas those.',
  pack: 'core',
};
```

- [ ] **Step 6: Verify + commit**

```
cd mcp-tools/hayba-mcp; npx vitest run src/tools/asset-retriever/meta-tools/meta-tools.test.ts
cd D:/Hackathons/hayba; git add mcp-tools/hayba-mcp/src/tools/asset-retriever/meta-tools/; git commit -m "feat(asset-retriever): three meta-tools — search, browse, reindex"
```

---

### Task 8: Wire into deferred routing — extend ALWAYS_ON_META + register handlers

**Files:**
- Modify: `mcp-tools/hayba-mcp/src/tools/routing/register.ts`

- [ ] **Step 1: Extend ALWAYS_ON_META**

Edit the `ALWAYS_ON_META` set near the top of `register.ts` to add the three new tool names:

```ts
export const ALWAYS_ON_META = new Set<string>([
  'hayba_search_tools',
  'hayba_pack_list',
  'hayba_pack_load',
  'hayba_invoke',
  'hayba_check_ue_status',
  'list_tool_categories',
  'get_tool_signature',
  'hayba_asset_search',
  'hayba_asset_browse',
  'hayba_asset_reindex',
]);
```

- [ ] **Step 2: Register the three meta-tools in `registerDeferredRouting`**

Add these imports at the top of `register.ts`:
```ts
import { AssetRetriever } from '../asset-retriever/asset-retriever.js';
import { assetSearchHandler, assetSearchSchema } from '../asset-retriever/meta-tools/search.js';
import { assetBrowseHandler, assetBrowseSchema } from '../asset-retriever/meta-tools/browse.js';
import { assetReindexHandler, assetReindexSchema } from '../asset-retriever/meta-tools/reindex.js';
```

In `registerDeferredRouting`, after the existing `hayba_invoke` registration block, add:

```ts
  // ── Asset retriever (Layer 3a) ─────────────────────────────────────────────
  const retriever = new AssetRetriever(
    (cmd, params) => executeCommand(cmd, params ?? {}),
    { cacheDir: effectiveCacheDir },
  );

  server.tool(
    'hayba_asset_search',
    'Find an asset in the user\'s UE Content Browser by semantic intent or keyword. Hybrid BM25 + embedding search.',
    assetSearchSchema,
    async (args: { query: string; k?: number; filterClass?: string; filterSource?: 'project' | 'polyhaven' | 'ambientcg' | 'sketchfab' | 'fab' | 'unknown' }) => {
      const r = await assetSearchHandler(args, { retriever });
      return { content: [{ type: 'text' as const, text: JSON.stringify(r, null, 2) }] };
    },
  );

  server.tool(
    'hayba_asset_browse',
    'Enumerate assets by filter (path/class/tag/source) without semantic ranking. Paginated.',
    assetBrowseSchema,
    async (args: { filter?: { path?: string; class?: string; tag?: string; source?: 'project' | 'polyhaven' | 'ambientcg' | 'sketchfab' | 'fab' | 'unknown' }; offset?: number; limit?: number }) => {
      const r = await assetBrowseHandler(args, { retriever });
      return { content: [{ type: 'text' as const, text: JSON.stringify(r, null, 2) }] };
    },
  );

  server.tool(
    'hayba_asset_reindex',
    'Force a rebuild of the asset index. Use after a batch import outside the MCP-tracked download flow.',
    assetReindexSchema,
    async () => {
      const r = await assetReindexHandler({}, { retriever });
      return { content: [{ type: 'text' as const, text: JSON.stringify(r, null, 2) }] };
    },
  );

  // Expose retriever via the returned RoutingHandle so connector downloaders
  // can call markDeltaStale post-verification.
```

- [ ] **Step 3: Add retriever to RoutingHandle export**

Update the `RoutingHandle` interface and the `return` at the bottom of `registerDeferredRouting`:

```ts
export interface RoutingHandle {
  registry: PackRegistry;
  index: ToolIndex;
  retriever: AssetRetriever;
  onUeConnected: () => Promise<void>;
}
```

Return statement:
```ts
  return {
    registry,
    index,
    retriever,
    onUeConnected: () => registry.maybeAutoLoad('ue_connected'),
  };
```

- [ ] **Step 4: Build + verify**

```
cd mcp-tools/hayba-mcp; npm run typecheck
cd mcp-tools/hayba-mcp; npx vitest run tests/routing-integration.test.ts
```

Existing routing-integration test should pass with the 3 new meta-tools now showing in the always-on count (10 instead of 7).

If that test's assertion lists exact 7 names, UPDATE it to include the 3 new ones:

```ts
expect(names).toEqual([
  'get_tool_signature',
  'hayba_asset_browse',
  'hayba_asset_reindex',
  'hayba_asset_search',
  'hayba_check_ue_status',
  'hayba_invoke',
  'hayba_pack_list',
  'hayba_pack_load',
  'hayba_search_tools',
  'list_tool_categories',
]);
```

- [ ] **Step 5: Commit**

```
cd D:/Hackathons/hayba; git add mcp-tools/hayba-mcp/src/tools/routing/register.ts mcp-tools/hayba-mcp/tests/routing-integration.test.ts; git commit -m "feat(asset-retriever): wire three meta-tools into deferred routing always-on set"
```

---

### Task 9: Connector verification — modify polyhaven/ambientcg/sketchfab downloaders

**Files:**
- Modify: `mcp-tools/hayba-mcp/src/tools/asset-sources/polyhaven-download.ts`
- Modify: `mcp-tools/hayba-mcp/src/tools/asset-sources/ambientcg-download.ts`
- Modify: `mcp-tools/hayba-mcp/src/tools/asset-sources/sketchfab-download.ts`
- Modify: `mcp-tools/hayba-mcp/src/tools/asset-sources/shared.ts`

- [ ] **Step 1: Read shared.ts and identify the importIntoUe call**

Run: `cat D:/Hackathons/hayba/mcp-tools/hayba-mcp/src/tools/asset-sources/shared.ts`.

Find `importIntoUe` (or equivalent). Note the call site in each of the three download files.

- [ ] **Step 2: Add a `verifyDownload` helper to shared.ts**

Append to `shared.ts`:

```ts
import { AssetVerifier } from '../asset-retriever/asset-verifier.js';
import type { Dispatch } from '../asset-retriever/asset-indexer.js';

export type VerifiedDownload =
  | { ok: true; path: string; doc: import('../asset-retriever/types.js').AssetDoc }
  | { ok: false; error: { kind: 'verification_failed'; reason: 'not_in_registry' | 'path_mismatch' | 'registry_unavailable'; attempted: string; stderr?: string } };

/**
 * Wraps an import-into-UE call with strict registry verification.
 * Replaces the old silent `imported: true` pattern.
 */
export async function verifyDownload(
  expectedPath: string,
  dispatch: Dispatch,
  stderr?: string,
): Promise<VerifiedDownload> {
  const verifier = new AssetVerifier(dispatch);
  const r = await verifier.verifyPath(expectedPath);
  if (r.exists) return { ok: true, path: r.doc.path, doc: r.doc };
  return { ok: false, error: { kind: 'verification_failed', reason: r.reason, attempted: r.attempted, stderr } };
}
```

- [ ] **Step 3: Update polyhaven-download.ts to use verifyDownload**

In `polyhaven-download.ts`, locate where the function currently returns `{ imported: true, ... }`. Replace that path with:

```ts
import { verifyDownload, type VerifiedDownload } from './shared.js';
import { executeCommand } from '../tool-executor.js';

// ... existing setup ...
// After the import-into-UE step succeeds (or appears to), do:
const result: VerifiedDownload = await verifyDownload(
  expectedGamePath,  // the /Game/Hayba/Polyhaven/... path the import targeted
  (cmd, params) => executeCommand(cmd, params ?? {}),
);
return result;
```

The handler's return shape changes from the old `{ imported, ... }` to `VerifiedDownload`. If existing TS callers rely on the old shape, they'll fail typecheck — fix them inline (likely only the dashboard or a couple of tests).

- [ ] **Step 4: Update ambientcg-download.ts the same way**

Same pattern. Locate the `imported: true` return, wrap with `verifyDownload`.

- [ ] **Step 5: Update sketchfab-download.ts the same way**

Same pattern.

- [ ] **Step 6: Update existing download tests to assert the new shape**

For each of `polyhaven-download.test.ts`, `ambientcg-download.test.ts`, `sketchfab-download.test.ts`:

- Mock `executeCommand` to return `{ assets: [{ path: expectedPath, name: 'X', class: 'StaticMesh', tags: [], lastModified: 1 }] }` for the verifier call.
- Assert the new return shape: `{ ok: true, path, doc }`.
- Add a test where the verifier mock returns `{ assets: [] }` and assert `{ ok: false, error: { kind: 'verification_failed', reason: 'not_in_registry' } }`.

- [ ] **Step 7: Run + commit**

```
cd mcp-tools/hayba-mcp; npx vitest run src/tools/asset-sources/
cd D:/Hackathons/hayba; git add mcp-tools/hayba-mcp/src/tools/asset-sources/; git commit -m "fix(asset-sources): route every downloader claim through AssetVerifier (closes silent-success)"
```

---

### Task 10: Auto-delta — connector calls markDeltaStale on success

**Files:**
- Modify: `mcp-tools/hayba-mcp/src/tools/asset-sources/polyhaven-download.ts`
- Modify: `mcp-tools/hayba-mcp/src/tools/asset-sources/ambientcg-download.ts`
- Modify: `mcp-tools/hayba-mcp/src/tools/asset-sources/sketchfab-download.ts`
- Modify: `mcp-tools/hayba-mcp/src/tools/routing/register.ts`

The handler needs access to the `AssetRetriever` instance to call `markDeltaStale`. Pass it via a module-level setter (same pattern as `tool-executor`'s `setDefaultSender`).

- [ ] **Step 1: Add a getter/setter to asset-retriever.ts**

Append to `mcp-tools/hayba-mcp/src/tools/asset-retriever/asset-retriever.ts`:

```ts
let DEFAULT_RETRIEVER: AssetRetriever | null = null;
export function setDefaultRetriever(r: AssetRetriever): void { DEFAULT_RETRIEVER = r; }
export function getDefaultRetriever(): AssetRetriever | null { return DEFAULT_RETRIEVER; }
```

- [ ] **Step 2: register.ts calls setDefaultRetriever**

In `register.ts` `registerDeferredRouting`, after constructing `retriever`:

```ts
import { setDefaultRetriever } from '../asset-retriever/asset-retriever.js';
// ...
setDefaultRetriever(retriever);
```

- [ ] **Step 3: Each downloader calls markDeltaStale on success**

In each of the three download files, after the successful `verifyDownload` result:

```ts
import { getDefaultRetriever } from '../asset-retriever/asset-retriever.js';

const result = await verifyDownload(expectedGamePath, dispatch);
if (result.ok) {
  getDefaultRetriever()?.markDeltaStale([result.path]);
}
return result;
```

- [ ] **Step 4: Verify + commit**

```
cd mcp-tools/hayba-mcp; npm run typecheck
cd mcp-tools/hayba-mcp; npx vitest run
cd D:/Hackathons/hayba; git add mcp-tools/hayba-mcp/src/tools/asset-retriever/asset-retriever.ts mcp-tools/hayba-mcp/src/tools/asset-sources/ mcp-tools/hayba-mcp/src/tools/routing/register.ts; git commit -m "feat(asset-retriever): auto-delta on connector download success"
```

---

### Task 11: Integration test

**Files:**
- Create: `mcp-tools/hayba-mcp/tests/asset-retriever-integration.test.ts`

- [ ] **Step 1: Write integration test**

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AssetRetriever } from '../src/tools/asset-retriever/asset-retriever.js';

describe('asset-retriever integration', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'hayba-arint-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it('end-to-end search → download → delta → search-includes-new', async () => {
    const initialAssets = [
      { path: '/Game/A/SM_PineTree', name: 'SM_PineTree', class: 'StaticMesh', tags: ['tree', 'pine'], lastModified: 1 },
      { path: '/Game/A/SM_OakTree',  name: 'SM_OakTree',  class: 'StaticMesh', tags: ['tree', 'oak'],  lastModified: 1 },
    ];
    let current = [...initialAssets];
    const dispatch = vi.fn(async (cmd: string, args: any) => {
      if (cmd === 'describe_assets') {
        if (args?.paths) return { assets: current.filter((a: any) => args.paths.includes(a.path)) };
        return { assets: current };
      }
      return {};
    });

    const ar = new AssetRetriever(dispatch, { cacheDir: dir, embeddings: null });

    // 1) Initial search
    const hits1 = await ar.search('pine', { k: 5 });
    expect(hits1[0].path).toBe('/Game/A/SM_PineTree');

    // 2) Simulated download — verifier confirms, then markDeltaStale
    current.push({ path: '/Game/A/SM_Birch', name: 'SM_Birch', class: 'StaticMesh', tags: ['tree', 'birch'], lastModified: 2 });
    ar.markDeltaStale(['/Game/A/SM_Birch']);

    // 3) Next search includes the new asset
    const hits2 = await ar.search('birch', { k: 5 });
    expect(hits2.some(h => h.path === '/Game/A/SM_Birch')).toBe(true);

    // 4) Reindex produces correct summary
    const r = await ar.reindex();
    expect(r.docCount).toBe(3);
    expect(r.backend).toBe('bm25');
  });

  it('full rebuild fallback when delta path is missing from registry', async () => {
    const dispatch = vi.fn(async (cmd: string, args: any) => {
      if (cmd === 'describe_assets') {
        // Initial: 1 asset
        if (!args?.paths) return { assets: [{ path: '/Game/A/SM_X', name: 'SM_X', class: 'X', tags: [], lastModified: 1 }] };
        // Delta probe: always return empty (the registry doesn't have what was claimed)
        return { assets: [] };
      }
      return {};
    });
    const ar = new AssetRetriever(dispatch, { cacheDir: dir, embeddings: null });
    await ar.search('x');
    ar.markDeltaStale(['/Game/A/SM_Missing']);
    // Next search triggers delta — which fails — which triggers full rebuild
    const hits = await ar.search('x');
    expect(hits.length).toBeGreaterThan(0);  // index still works
  });
});
```

- [ ] **Step 2: Run + commit**

```
cd mcp-tools/hayba-mcp; npx vitest run tests/asset-retriever-integration.test.ts
cd D:/Hackathons/hayba; git add mcp-tools/hayba-mcp/tests/asset-retriever-integration.test.ts; git commit -m "test(asset-retriever): integration test — search → download → delta → search"
```

---

### Task 12: CONTEXT.md + CHANGELOG updates

**Files:**
- Modify: `mcp-tools/hayba-mcp/CONTEXT.md`
- Modify: `mcp-tools/hayba-mcp/CHANGELOG.md`

- [ ] **Step 1: Append asset-retriever section to CONTEXT.md**

Insert after the existing "Tool Routing (γ hybrid)" entry:

```markdown
- **Asset Retriever (Layer 3a, since 2026-05-20)** — `src/tools/asset-retriever/`. Local semantic + keyword search over the UE Content Browser. Three always-on meta-tools: `hayba_asset_search` (hybrid BM25+embedding), `hayba_asset_browse` (paginated filtered enumeration), `hayba_asset_reindex` (manual refresh). Auto-fallback through Ollama → @huggingface/transformers → BM25-only. Lazy first-call build; auto-delta on MCP-dispatched downloads via `markDeltaStale`. Cache at `Saved/HaybaMCP/asset-index.{meta.json,bm25.json,vectors.bin}` keyed by registry-snapshot hash.
- **AssetVerifier** — `src/tools/asset-retriever/asset-verifier.ts`. Single-path lookup against the UE asset registry via `describe_assets`. The polyhaven/ambientcg/sketchfab downloaders now route every claimed import through this verifier; the old silent `imported: true` is removed in favor of `{ ok, error: { kind: 'verification_failed' } | undefined }`.
```

- [ ] **Step 2: Update CHANGELOG**

In `mcp-tools/hayba-mcp/CHANGELOG.md` under `[Unreleased]`:

```markdown
### Added
- Asset Retriever (Layer 3a): `hayba_asset_search`, `hayba_asset_browse`, `hayba_asset_reindex` meta-tools backed by hybrid BM25+embedding index over the UE Content Browser. Auto-fallback for no-Ollama/no-GPU users.
- `describe_assets` UE TCP command consumed by the retriever (with graceful fallback to `list_pcg_assets` when plugin not yet updated).

### Changed
- **Breaking (return shape):** `hayba_polyhaven_download`, `hayba_ambientcg_download`, `hayba_sketchfab_download` now return `{ ok: true, path, doc } | { ok: false, error: { kind: 'verification_failed', reason, attempted, stderr? } }` instead of the silent `{ imported: true }`. Callers reading `.ok` keep working; callers reading `.imported` need to migrate.
```

- [ ] **Step 3: Commit**

```
cd D:/Hackathons/hayba; git add mcp-tools/hayba-mcp/CONTEXT.md mcp-tools/hayba-mcp/CHANGELOG.md; git commit -m "docs(asset-retriever): CONTEXT + CHANGELOG entries"
```

---

### Task 13: UE plugin `describe_assets` stub note + manual verification

**Files:** None (documentation / verification step).

- [ ] **Step 1: Document the UE-side prerequisite**

The C++ plugin needs a new `describe_assets` TCP command that returns asset registry metadata. Until shipped, the indexer falls back to `list_pcg_assets` (path-only, no tags). Note this in `mcp-tools/hayba-mcp/CHANGELOG.md` under `[Unreleased] / Pending`:

```markdown
### Pending (UE plugin sub-PR)
- `describe_assets` TCP command — returns `{assets: AssetDoc[]}` for paths under a root or for an explicit list. Once shipped, the asset retriever picks up full tag metadata; until then it gracefully falls back to path-only.
```

- [ ] **Step 2: Build + run the live verifier from Layer 1 to confirm no regressions**

```
cd mcp-tools/hayba-mcp; npm run build:server
cd D:/Hackathons/hayba; node .scratch/verify-routing.mjs 2>&1 | tail -30
```

Expect: still 13/13 probes pass (Layer 1 untouched). The new tools appear in the tool-list count (10 always-on instead of 7).

- [ ] **Step 3: Commit pending-note + final verification artifacts**

```
cd D:/Hackathons/hayba; git add mcp-tools/hayba-mcp/CHANGELOG.md; git commit -m "docs(asset-retriever): note describe_assets UE-plugin prerequisite"
```

---

### Task 14: PR

**Files:** None.

- [ ] **Step 1: Run full test suite**

```
cd mcp-tools/hayba-mcp; npm test 2>&1 | tail -10
```

Expect: ~270 passing (Layer 1 baseline + ~25 new asset-retriever tests). 26 pre-existing TCP-sender failures unchanged.

- [ ] **Step 2: Push branch + open PR (only if user has explicitly authorized push)**

```
git push -u origin spec/mcp-tool-routing
gh pr create --title "Asset Retriever (Layer 3a) — local semantic+keyword index + verified connector downloads" --body "$(cat <<'EOF'
## Summary
- Three always-on meta-tools (hayba_asset_search, hayba_asset_browse, hayba_asset_reindex) backed by hybrid BM25+embedding index over UE Content Browser
- Auto-fallback Ollama → @huggingface/transformers → BM25-only
- Lazy build, hash-keyed disk cache, auto-delta on MCP-dispatched downloads
- AssetVerifier closes silent-success hole in polyhaven/ambientcg/sketchfab downloaders (mcp-architectural-issues #4)
- Connector return shape now { ok, error? } — breaking but covered in CHANGELOG

## Spec / Plan
- docs/superpowers/specs/2026-05-20-asset-retriever-design.md
- docs/superpowers/plans/2026-05-20-asset-retriever.md

## Test plan
- [ ] vitest passes for all asset-retriever/* + asset-sources/* + integration
- [ ] live verifier driver (Layer 1) still 13/13
- [ ] Manual: hayba_asset_search returns relevant hits against a Megascans project; hayba_polyhaven_download → auto-delta → next search includes new asset
EOF
)"
```

If push is not authorized, stop here and report.

---

## Self-Review

**Spec coverage:**
- §1 Architecture (AssetIndexer, AssetIndex, AssetCatalog, AssetVerifier) → Tasks 2, 3, 4, 5
- Orchestrator (lazy + mutex + delta) → Task 6
- §2 Components (3 meta-tools with schemas) → Task 7
- Wiring into ALWAYS_ON_META → Task 8
- Connector verification contract (#4 fix) → Task 9
- Auto-delta on connector success → Task 10
- §3 Data flow (full end-to-end) → Tasks 6, 11
- §4 Error handling (per-table coverage) → Tasks 2, 5, 6, 9 (each error mode has a test)
- §5 Testing (unit + integration + smoke) → Tasks 2-11
- File layout matches Task file paths
- UE plugin describe_assets prerequisite → Task 13 (documented; C++ work is separate sub-PR per spec)

**Placeholders scan:** all steps include complete code, exact commands, expected outputs. No TBDs.

**Type consistency:**
- `AssetDoc` defined in Task 1, used identically across Tasks 2-7
- `Dispatch` defined in Task 2 (asset-indexer.ts), used by Tasks 5, 6, 9
- `SearchHit`, `Filter`, `Page`, `VerifyResult` defined once each, referenced consistently
- `VerifiedDownload` defined in Task 9, used by Task 10
- Three meta-tool schemas (`assetSearchSchema`, `assetBrowseSchema`, `assetReindexSchema`) match the spec's listed shapes
