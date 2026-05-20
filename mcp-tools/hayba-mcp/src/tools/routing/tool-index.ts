import MiniSearch from 'minisearch';

export interface ToolDoc {
  name: string;
  summary: string;
  description: string;
  tags: string[];
  packs: string[];
  cost: 'low' | 'medium' | 'high';
}

export interface SearchHit {
  name: string;
  summary: string;
  packs: string[];
  score: number;
}

export interface SearchOpts {
  k?: number;
  filterPack?: string;
}

export interface EmbeddingBackend {
  embed(texts: string[]): Promise<Float32Array[]>;
  id: string;
}

export interface BuildOpts {
  embeddings: EmbeddingBackend | null;
}

export class ToolIndex {
  private constructor(
    private bm25: MiniSearch<ToolDoc>,
    private docs: Map<string, ToolDoc>,
    private vectors: Map<string, Float32Array> | null,
    private embeddings: EmbeddingBackend | null,
  ) {}

  static async build(docs: ToolDoc[], opts: BuildOpts): Promise<ToolIndex> {
    const bm25 = new MiniSearch<ToolDoc>({
      fields: ['name', 'summary', 'description', 'tags'],
      storeFields: ['name', 'summary', 'packs'],
      idField: 'name',
      extractField: (d, f) => {
        const v = (d as unknown as Record<string, unknown>)[f];
        return Array.isArray(v) ? v.join(' ') : String(v ?? '');
      },
    });
    bm25.addAll(docs);

    let vectors: Map<string, Float32Array> | null = null;
    if (opts.embeddings) {
      vectors = new Map();
      const texts = docs.map(d =>
        `${d.name}. ${d.summary}. ${d.description}. tags: ${d.tags.join(', ')}`,
      );
      const embedded = await opts.embeddings.embed(texts);
      docs.forEach((d, i) => vectors!.set(d.name, embedded[i]));
    }

    return new ToolIndex(
      bm25,
      new Map(docs.map(d => [d.name, d])),
      vectors,
      opts.embeddings,
    );
  }

  async search(query: string, opts: SearchOpts = {}): Promise<SearchHit[]> {
    const k = opts.k ?? 8;

    // BM25 ranks
    const bm25Raw = this.bm25.search(query, { prefix: true, fuzzy: 0.2 });
    const bm25Rank = new Map<string, number>();
    bm25Raw.forEach((r, i) => bm25Rank.set(r.id as string, i + 1));

    // Embedding ranks (cosine similarity)
    const embRank = new Map<string, number>();
    if (this.embeddings && this.vectors && this.vectors.size > 0) {
      const qv = (await this.embeddings.embed([query]))[0];
      const scored: Array<[string, number]> = [];
      for (const [name, v] of this.vectors) scored.push([name, cosine(qv, v)]);
      scored.sort((a, b) => b[1] - a[1]);
      scored.forEach(([name], i) => embRank.set(name, i + 1));
    }

    // Reciprocal Rank Fusion (k_rrf = 60)
    const K_RRF = 60;
    const fused = new Map<string, number>();
    const all = new Set<string>([...bm25Rank.keys(), ...embRank.keys()]);
    for (const id of all) {
      const a = bm25Rank.get(id);
      const b = embRank.get(id);
      const score = (a ? 1 / (K_RRF + a) : 0) + (b ? 1 / (K_RRF + b) : 0);
      fused.set(id, score);
    }

    return Array.from(fused.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([name, score]) => {
        const d = this.docs.get(name)!;
        return { name: d.name, summary: d.summary, packs: d.packs, score };
      })
      .filter(h => !opts.filterPack || h.packs.includes(opts.filterPack))
      .slice(0, k);
  }
}

function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) + 1e-9);
}
