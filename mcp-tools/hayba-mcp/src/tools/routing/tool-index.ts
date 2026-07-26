import MiniSearch from 'minisearch';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

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
  cacheDir?: string;
}


// ── Index configuration ──────────────────────────────────────────────────────
//
// Tuned against src/tools/routing/search-quality.test.ts, which measures ranking
// over the real tool catalogue with queries phrased the way an agent phrases
// them. Change these numbers and run that benchmark; it will tell you whether
// you helped.

/** Words that carry no signal about which tool you want. Without stripping
 *  these, "run python in the editor" is four near-useless terms plus one real
 *  one, and requiring all terms to match becomes impossible. */
const STOPWORDS = new Set([
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'i', 'my', 'me', 'we', 'our', 'you', 'your', 'it', 'its', 'this', 'that',
  'to', 'of', 'in', 'on', 'at', 'by', 'for', 'with', 'from', 'into', 'onto',
  'and', 'or', 'but', 'if', 'then', 'than', 'so', 'as',
  'do', 'does', 'did', 'can', 'will', 'would', 'should', 'want', 'need',
  'how', 'what', 'why', 'when', 'where', 'which', 'who',
  'get', 'got', 'have', 'has', 'there', 'here', 'some', 'any', 'all',
  'please', 'just', 'now',
]);

/** Field weights. The tool NAME is the strongest signal there is — someone
 *  typing "python" almost certainly wants python_run — and the domain is the
 *  next strongest, because people name the subsystem before the operation
 *  ("shader", "terrain", "menu"). Descriptions are prose and rank last: they
 *  are long, and long fields match everything a little. */
const FIELD_BOOST = { name: 6, pack: 3, summary: 2, description: 1, tags: 1 } as const;

const INDEX_FIELDS = ['name', 'pack', 'summary', 'description', 'tags'];

/** Terms shorter than this are not fuzzy-matched. Fuzzy on a 3-letter term
 *  matches most of the catalogue and is where the worst noise came from. */
const MIN_FUZZY_LEN = 5;

function processTerm(term: string): string | null {
  const t = term.toLowerCase();
  if (STOPWORDS.has(t)) return null;
  if (t.length < 2) return null;
  return t;
}

/** Split on non-alphanumerics AND on camelCase boundaries, emitting both the
 *  whole token and its parts.
 *
 *  Unreal vocabulary is overwhelmingly camelCase — StaticMesh, WidgetBlueprint,
 *  LandscapeProxy — while people search in lowercase words. Without this,
 *  "mesh" does not match a description that says "StaticMesh", which is exactly
 *  why "place a mesh in the level" could not find the tool whose description
 *  opens with "Spawn an actor from a content asset path (StaticMesh ...)".
 *
 *  The whole token is kept alongside the parts so an exact "staticmesh" query
 *  still scores highest. */
function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/[^a-zA-Z0-9]+/)) {
    if (!raw) continue;
    out.push(raw);
    const parts = raw.split(/(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/);
    if (parts.length > 1) out.push(...parts);
  }
  return out;
}

const MINISEARCH_OPTIONS = {
  fields: INDEX_FIELDS,
  storeFields: ['name', 'summary', 'packs'],
  idField: 'name',
  processTerm,
  tokenize,
};

export class ToolIndex {
  private constructor(
    private bm25: MiniSearch<ToolDoc>,
    private docs: Map<string, ToolDoc>,
    private vectors: Map<string, Float32Array> | null,
    private embeddings: EmbeddingBackend | null,
  ) {}

  static async build(docs: ToolDoc[], opts: BuildOpts): Promise<ToolIndex> {
    // Try to load from cache
    if (opts.cacheDir) {
      mkdirSync(opts.cacheDir, { recursive: true });
      const metaPath = join(opts.cacheDir, 'tool-index.meta.json');
      const bm25Path = join(opts.cacheDir, 'tool-index.bm25.json');
      const hash = hashDocs(docs);
      const backendId = opts.embeddings?.id ?? 'none';
      let cached: { hash?: string; backendId?: string } | null = null;
      try {
        if (existsSync(metaPath)) cached = JSON.parse(readFileSync(metaPath, 'utf-8'));
      } catch {
        cached = null;
      }
      if (cached?.hash === hash && cached?.backendId === backendId && existsSync(bm25Path)) {
        try {
          const bm25Cached = MiniSearch.loadJSON<ToolDoc>(readFileSync(bm25Path, 'utf-8'), {
            ...MINISEARCH_OPTIONS,
            extractField: extractIndexField,
          });
          const docMap = new Map(docs.map(d => [d.name, d]));
          // Note: embedding vectors are NOT persisted in v1 — they're cheap to
          // recompute and avoid binary format complexity. Re-embed if needed.
          let vectors: Map<string, Float32Array> | null = null;
          if (opts.embeddings) {
            vectors = new Map();
            const texts = docs.map(d =>
              `${d.name}. ${d.summary}. ${d.description}. tags: ${d.tags.join(', ')}`,
            );
            const embedded = await opts.embeddings.embed(texts);
            docs.forEach((d, i) => vectors!.set(d.name, embedded[i]));
          }
          return new ToolIndex(bm25Cached, docMap, vectors, opts.embeddings);
        } catch {
          // Fall through to rebuild — never block startup on cache.
        }
      }
    }

    const bm25 = new MiniSearch<ToolDoc>({
      ...MINISEARCH_OPTIONS,
      extractField: extractIndexField,
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

    // Write cache after successful build
    if (opts.cacheDir) {
      writeFileSync(join(opts.cacheDir, 'tool-index.bm25.json'), JSON.stringify(bm25));
      writeFileSync(
        join(opts.cacheDir, 'tool-index.meta.json'),
        JSON.stringify({ hash: hashDocs(docs), backendId: opts.embeddings?.id ?? 'none' }),
      );
    }

    return new ToolIndex(
      bm25,
      new Map(docs.map(d => [d.name, d])),
      vectors,
      opts.embeddings,
    );
  }

  /** Strict-then-loose BM25. Returns [] when even the loose pass finds nothing. */
  private searchBm25(query: string): Array<{ id: unknown }> {
    const common = {
      prefix: true,
      boost: FIELD_BOOST as unknown as Record<string, number>,
      // Fuzzy only helps on words long enough for a typo to be unambiguous.
      fuzzy: (term: string) => (term.length >= MIN_FUZZY_LEN ? 0.2 : false),
    };

    const strict = this.bm25.search(query, { ...common, combineWith: 'AND' });
    const loose = this.bm25.search(query, { ...common, combineWith: 'OR' });

    // Nothing matched even loosely — the query is about something this server
    // does not do, and saying so is the useful answer.
    if (loose.length === 0) return [];

    // Docs matching every term rank first, then the best partial matches.
    // Pure AND was too strict in practice: "place a mesh in the level" has three
    // content words and the right tool (actor_spawn) contains two of them, so
    // demanding all three handed the query to whichever tool happened to use all
    // three words in prose. Pure OR was too loose, which is where the original
    // noise came from. Precision first, recall behind it.
    const seen = new Set(strict.map((r) => r.id as string));
    const merged = [...strict];
    for (const r of loose) {
      if (!seen.has(r.id as string)) merged.push(r);
    }
    return merged;
  }

  async search(query: string, opts: SearchOpts = {}): Promise<SearchHit[]> {
    const k = opts.k ?? 8;

    // BM25 ranks.
    //
    // Two passes. The first demands every meaningful query term appear in the
    // document: that is what makes "take a screenshot of the viewport" find the
    // capture tool instead of everything containing "of". It also returns
    // nothing at all for a nonsense query, which is the correct answer — a
    // confident wrong tool is worse than none, because it sends the agent down
    // a path that cannot work.
    //
    // Only if AND finds nothing do we fall back to OR, so a partially-phrased
    // query still gets help rather than silence.
    const bm25Raw = this.searchBm25(query);
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

    // A query whose terms match nothing should return nothing, not the least-bad
    // guess the fusion happens to surface.
    if (bm25Rank.size === 0 && embRank.size === 0) return [];

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

/** Field extraction for the index. `pack` is synthesised from `packs` so the
 *  domain name ("ui", "material", "landscape") is searchable text — it is the
 *  first word people reach for, and it was not indexed at all before. */
function extractIndexField(d: ToolDoc, field: string): string {
  if (field === 'pack') return (d.packs ?? []).join(' ');
  const v = (d as unknown as Record<string, unknown>)[field];
  return Array.isArray(v) ? v.join(' ') : String(v ?? '');
}

function hashDocs(docs: ToolDoc[]): string {
  const h = createHash('sha256');
  for (const d of [...docs].sort((a, b) => a.name.localeCompare(b.name))) {
    h.update(`${d.name} ${d.summary} ${d.description} ${d.tags.join(',')} ${d.packs.join(',')}\n`);
  }
  return h.digest('hex');
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
