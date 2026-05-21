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
    if (opts.cacheDir) {
      const cached = tryLoadCache(opts.cacheDir, docs, opts.embeddings?.id ?? 'none');
      if (cached) {
        return new AssetIndex(
          cached.bm25, cached.docMap, cached.vectors, opts.embeddings, opts.cacheDir,
        );
      }
    }
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
      const v = (d as unknown as Record<string, unknown>)[f];
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
