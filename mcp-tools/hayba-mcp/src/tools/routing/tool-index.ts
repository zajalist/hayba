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
  ) {}

  static async build(docs: ToolDoc[], _opts: BuildOpts): Promise<ToolIndex> {
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
    return new ToolIndex(bm25, new Map(docs.map(d => [d.name, d])));
  }

  async search(query: string, opts: SearchOpts = {}): Promise<SearchHit[]> {
    const k = opts.k ?? 8;
    const raw = this.bm25.search(query, { prefix: true, fuzzy: 0.2 });
    const hits: SearchHit[] = raw
      .map(r => {
        const d = this.docs.get(r.id as string)!;
        return { name: d.name, summary: d.summary, packs: d.packs, score: r.score };
      })
      .filter(h => !opts.filterPack || h.packs.includes(opts.filterPack))
      .slice(0, k);
    return hits;
  }
}
