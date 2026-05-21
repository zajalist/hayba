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
  /**
   * Override the embedding backend probe. Pass `null` to force BM25-only.
   * Leave undefined to auto-probe (Ollama → transformers.js → BM25-only).
   */
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
    const t0 = Date.now();
    if (this.buildLock) {
      await this.buildLock;
      return { ...this.summarize(), durationMs: Date.now() - t0 };
    }
    const p = this.doBuild();
    this.buildLock = p;
    try {
      await p;
    } finally {
      this.buildLock = null;
    }
    return { ...this.summarize(), durationMs: Date.now() - t0 };
  }

  private async ensureBuilt(): Promise<void> {
    if (this.index) return;
    if (this.buildLock) { await this.buildLock; return; }
    const p = this.doBuild();
    this.buildLock = p;
    try {
      await p;
    } finally {
      this.buildLock = null;
    }
  }

  private async doBuild(): Promise<void> {
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
        await this.doBuild();
        return;
      }
      await this.index.addOrUpdate(newDocs);
      this.catalog = new AssetCatalog(this.index.allDocs());
    } catch {
      for (const p of paths) this.deltaStale.add(p);
    }
  }

  private summarize(): Omit<ReindexResult, 'durationMs'> {
    const docCount = this.index?.allDocs().length ?? 0;
    const backend: ReindexResult['backend'] = this.embeddings
      ? (/^ollama:/.test(this.embeddings.id) ? 'ollama' : 'transformers')
      : 'bm25';
    return { ok: true, docCount, backend, fallbackUsed: false };
  }
}

let DEFAULT_RETRIEVER: AssetRetriever | null = null;
export function setDefaultRetriever(r: AssetRetriever): void { DEFAULT_RETRIEVER = r; }
export function getDefaultRetriever(): AssetRetriever | null { return DEFAULT_RETRIEVER; }
