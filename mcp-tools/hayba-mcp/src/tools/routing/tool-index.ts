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

/** How many semantic neighbours enter the fusion. Small on purpose: RRF rewards
 *  appearing in both lists, so a long embedding tail turns into a bonus for
 *  whatever BM25 already liked instead of a second opinion. */
const EMB_CANDIDATES = 25;

/** Cosine below this is not a match. Short tool text through a small sentence
 *  model puts genuine matches around 0.25-0.4 and unrelated pairs well under
 *  0.15, so this separates "weakly related" from "closest of nothing". */
const EMB_MIN_SIMILARITY = 0.18;

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
      const vecPath = join(opts.cacheDir, 'tool-index.vec.json');
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
          // Vectors are persisted alongside the BM25 index. Re-embedding the
          // catalogue costs ~2s of wall clock on every server start, which is
          // paid on the path between a user asking for something and anything
          // happening — the worst place to spend it.
          let vectors: Map<string, Float32Array> | null = null;
          if (opts.embeddings) {
            vectors = loadVectors(vecPath, docs);
            if (!vectors) {
              vectors = await embedDocs(docs, opts.embeddings);
              saveVectors(vecPath, vectors);
            }
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
      vectors = await embedDocs(docs, opts.embeddings);
    }

    // Write cache after successful build
    if (opts.cacheDir) {
      writeFileSync(join(opts.cacheDir, 'tool-index.bm25.json'), JSON.stringify(bm25));
      if (vectors) saveVectors(join(opts.cacheDir, 'tool-index.vec.json'), vectors);
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

  /** Strict-then-loose BM25. `strictMatched` is false when no document contained
   *  every query term — i.e. lexical matching failed and the results are the
   *  loose pass guessing. */
  private searchBm25(query: string): { hits: Array<{ id: unknown }>; strictMatched: boolean } {
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
    if (loose.length === 0) return { hits: [], strictMatched: false };

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
    return { hits: merged, strictMatched: strict.length > 0 };
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
    const { hits: bm25Raw, strictMatched } = this.searchBm25(query);
    const bm25Rank = new Map<string, number>();
    bm25Raw.forEach((r, i) => bm25Rank.set(r.id as string, i + 1));

    // Embedding ranks (cosine similarity).
    //
    // Truncated to the top candidates, and floored, before fusion. Both matter:
    //
    //  - Every document has a cosine score, so an untruncated ranking puts all
    //    245 tools in the fusion. A tool that BM25 ranked 5th then also picks up
    //    a 100th-place semantic contribution and beats the tool the embeddings
    //    ranked FIRST. Measured: with the full list, adding embeddings changed
    //    the benchmark by exactly nothing, because the semantic signal was
    //    diluted to noise. Truncation is what makes it count.
    //
    //  - Without a floor, nonsense queries always produce a ranked list, since
    //    something is always least-dissimilar. That silently undoes the "return
    //    nothing rather than a confident wrong answer" property.
    const embRank = new Map<string, number>();
    if (this.embeddings && this.vectors && this.vectors.size > 0) {
      const qv = (await this.embeddings.embed([query]))[0];
      const scored: Array<[string, number]> = [];
      for (const [name, v] of this.vectors) {
        const sim = cosine(qv, v);
        if (sim >= EMB_MIN_SIMILARITY) scored.push([name, sim]);
      }
      scored.sort((a, b) => b[1] - a[1]);
      scored.slice(0, EMB_CANDIDATES).forEach(([name], i) => embRank.set(name, i + 1));
    }

    // Weighted Reciprocal Rank Fusion.
    //
    // When no document contained every query term, BM25 is not ranking — it is
    // guessing from the loose pass, and its top hit is often a tool that merely
    // reuses one common word. That is exactly the case embeddings exist for, so
    // the weights flip: semantics lead when the lexical signal has failed, and
    // follow when it has not.
    //
    // "make the surface shiny" is the worked example. No tool contains all
    // three words, so BM25 offers whatever mentions "surface", while the
    // embeddings put material_set_param third. Equal weights let the lexical
    // guess win by a hair; this does not.
    const K_RRF = 60;
    const wBm25 = strictMatched ? 1.0 : 0.15;
    const wEmb = strictMatched ? 0.9 : 2.5;
    const fused = new Map<string, number>();
    const all = new Set<string>([...bm25Rank.keys(), ...embRank.keys()]);
    for (const id of all) {
      const a = bm25Rank.get(id);
      const b = embRank.get(id);
      const score = (a ? wBm25 / (K_RRF + a) : 0) + (b ? wEmb / (K_RRF + b) : 0);
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
/** Text handed to the embedding model.
 *
 *  Deliberately excludes the tool NAME. `material_set_param` is three tokens of
 *  snake_case that a sentence model reads as near-gibberish, and on texts this
 *  short it drags the whole vector toward other snake_case names rather than
 *  toward meaning. BM25 already handles names, with exact matching and a 6x
 *  boost — that is the right tool for that job. Embeddings are here for the
 *  prose, so they get the prose. */
function embeddingText(d: ToolDoc): string {
  const parts = [d.summary, d.description].filter((x) => x && x.length > 0);
  return parts.join('. ') || d.name.replace(/_/g, ' ');
}

async function embedDocs(
  docs: ToolDoc[],
  backend: EmbeddingBackend,
): Promise<Map<string, Float32Array>> {
  const vectors = new Map<string, Float32Array>();
  const embedded = await backend.embed(docs.map(embeddingText));
  docs.forEach((d, i) => vectors.set(d.name, embedded[i]));
  return vectors;
}

/** Vectors are stored as plain arrays: a few hundred KB of JSON, versus ~2s of
 *  model inference. Returns null on any mismatch or corruption so the caller
 *  re-embeds — a stale vector silently ranks against the wrong text. */
function loadVectors(path: string, docs: ToolDoc[]): Map<string, Float32Array> | null {
  try {
    if (!existsSync(path)) return null;
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, number[]>;
    const out = new Map<string, Float32Array>();
    for (const d of docs) {
      const v = raw[d.name];
      if (!Array.isArray(v)) return null;
      out.set(d.name, new Float32Array(v));
    }
    return out.size === docs.length ? out : null;
  } catch {
    return null;
  }
}

function saveVectors(path: string, vectors: Map<string, Float32Array>): void {
  try {
    const obj: Record<string, number[]> = {};
    for (const [k, v] of vectors) obj[k] = Array.from(v);
    writeFileSync(path, JSON.stringify(obj));
  } catch {
    // A cache we cannot write is a slower start, not a failure.
  }
}

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
