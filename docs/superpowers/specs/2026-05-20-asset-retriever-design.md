# Hayba Asset Retriever (Layer 3a)

**Date:** 2026-05-20
**Status:** Design approved, ready for implementation plan
**Scope:** Local semantic + keyword retrieval over the UE Content Browser (and already-downloaded external assets). Three new always-on meta-tools. Folds verified-side-effect contract for the existing asset-connector downloaders. Layer 3a of the three-layer architecture (Local Lightweight Models). Layers 2 (Deterministic Abstraction) and 3b (intent-to-parameter regressor) are explicitly out of scope.

**Spec depends on:** `2026-05-20-mcp-tool-routing-design.md` (reuses the embedding-backend probe chain, disk-cache pattern, BM25 substrate, and meta-tool registration model).

## Problem

Today, when Claude needs to use an asset that's already in the user's UE project — a specific tree mesh, a particular rock — it has only two options: scroll through `hayba_list_pcg_assets` output (path-only enumeration), or invoke the external-catalog connectors (Polyhaven, ambientCG, Sketchfab, Fab) and re-download something the user already has. There is no semantic search over the user's actual Content Browser. Naming is also inconsistent (`SM_PineTree_Large` vs `Mesh_001`), so even keyword search by filename misses most assets.

Concrete failure modes from the LostCity post-mortem (`.scratch/mcp-architectural-issues.md`):

- **#4 connector silent-success.** `hayba_polyhaven_download` reported `imported:true` for weeks despite the import script silently SyntaxError-ing. Nothing verified the asset actually landed in the registry.
- **#14 plugin/registry changes not reflected in MCP state.** New downloads aren't visible to subsequent tool calls without manual user awareness.
- **Meta-pattern.** Tools return `ok:true` when they did nothing or did the wrong thing. The asset layer is currently a prime offender.

## Goals

1. Provide **semantic + keyword search over the user's Content Browser** via a new always-on `hayba_asset_search` meta-tool, with quality matching Layer 1's hybrid BM25 + Ollama-embedding retriever.
2. Provide an **escape-hatch browse tool** (`hayba_asset_browse`) for filtered enumeration when search isn't the right operation (e.g. "list everything tagged `medieval`").
3. Provide a **manual `hayba_asset_reindex` tool** for after-import refresh.
4. **Auto-fallback** for users without Ollama or GPU-capable embeddings — degrade through transformers.js → BM25-only, same chain as Layer 1.
5. **Enforce verified side-effects** on the existing asset-connector downloaders by routing every "download succeeded" claim through an `AssetVerifier` that checks the UE asset registry before returning ok.
6. Keep the new surface tiny: 3 meta-tools, no Pack required.

## Non-goals

- Live external-catalog search at index time (Polyhaven/ambientCG/etc.'s own APIs continue to serve that role via existing connectors). The retriever only indexes what's *already in the user's project*, including previously-downloaded external assets.
- Visual-similarity search via CLIP/thumbnails. The visual sidecar (`active_models` field on `hayba_check_ue_status`) is a separate path and overlaps with this in v2 at most.
- A UE event hook for "content browser changed." Auto-invalidation happens only on MCP-dispatched downloads (#14 spirit, partial). UE-side imports outside MCP control still need manual `hayba_asset_reindex`.
- Layer 2 abstraction primitives (`wait_for_idle`, `frame_target`, lighting presets, frustum queries) — each gets its own spec.
- `python_run` rework, screenshot consolidation, plugin source dedup, operation journal, out-of-process liveness — each gets its own spec.

## Architecture

Four runtime components inside `mcp-tools/hayba-mcp/src/tools/asset-retriever/`:

- **`AssetIndexer`** — pulls metadata for every `/Game/...` asset via a new UE TCP command (`describe_assets`), normalizes into `AssetDoc[]`, hands them to the index.
- **`AssetIndex`** — hybrid BM25 + (optional) embedding store. Mirrors `tool-index.ts` from Layer 1.
- **`AssetCatalog`** — raw doc-by-path map backing `hayba_asset_browse`; same docs as the index, but exposed for filtered/paginated enumeration without ranking.
- **`AssetVerifier`** — single-path lookup against `describe_assets`, used by connector downloaders to confirm their claimed side-effects (#4 fix).

Three new always-on meta-tools: `hayba_asset_search`, `hayba_asset_browse`, `hayba_asset_reindex`. Registered in `routing/register.ts`'s `ALWAYS_ON_META` set so they're visible at MCP boot in `deferred` mode (7 → 10 tools total).

### UE-side prerequisite

One new TCP command on the UE plugin: `describe_assets`, accepting `{path?: string, paths?: string[]}` and returning `{assets: AssetDoc[]}` where `AssetDoc` carries `{path, name, class, tags, source, lastModified}`. Tags come from the UE asset registry's tag system; `source` is inferred TS-side from the path prefix.

Until the C++ side ships this command, the indexer falls back to `list_pcg_assets` (path-only) with a one-time warning. The text-only embedding still works on filename tokens — degraded, not broken.

### Lifecycle

Lazy. Nothing happens at MCP boot. First call to `hayba_asset_search` or `hayba_asset_browse` triggers `AssetIndexer.build()` (which logs progress over stderr). Subsequent calls reuse the in-memory index. Cache persists across MCP restarts at `Saved/HaybaMCP/asset-index.{meta.json,bm25.json,vectors.bin}`, hash-keyed by a sha256 over sorted `(path, lastModified)` pairs.

`hayba_asset_reindex` forces a fresh fetch + rebuild and overwrites the cache. A Promise-mutex prevents concurrent rebuilds — overlapping reindex calls await the in-flight build.

## Components

### `AssetIndexer` (`asset-indexer.ts`)

```ts
interface BuildResult { docs: AssetDoc[]; snapshotHash: string; fallbackUsed: boolean }
class AssetIndexer {
  async build(opts?: { forceRefresh?: boolean }): Promise<BuildResult>;
  async describeDelta(paths: string[]): Promise<AssetDoc[]>;
}
```

Sends `describe_assets({path: '/Game/'})`. On `unknown_command` → fall back to `list_pcg_assets`, build docs with empty tags + `source: 'unknown'`, log warning once per process.

### `AssetIndex` (`asset-index.ts`)

Direct mirror of Layer 1's `tool-index.ts`. Reuses `selectEmbeddingBackend()` from `routing/embedding-backends.ts`. Per-doc embedding text: `${name}. ${class}. ${tags.join(', ')}. path: ${path}`. RRF merge with k=60. Vectors persisted to `vectors.bin` as packed `Float32Array` in `path` order (re-embedding thousands of assets on every boot is too expensive — this is the one departure from Layer 1's "don't persist vectors" choice).

Delta-merge: `addOrUpdate(docs: AssetDoc[])` updates BM25 in place and embeds + appends to vectors.

### `AssetCatalog` (`asset-catalog.ts`)

```ts
interface Filter { path?: string; class?: string; tag?: string; source?: string }
interface Page { total: number; offset: number; limit: number; docs: AssetDoc[] }
class AssetCatalog {
  list(filter: Filter, offset: number, limit: number): Page;
}
```

Pure in-memory filtered enumeration. `filter.path` is prefix match (`/Game/Hayba/` matches everything under it). Other filters are exact match. Pagination via offset/limit, default `limit=50`, hard cap `limit=200`.

### `AssetVerifier` (`asset-verifier.ts`)

```ts
type VerifyResult =
  | { exists: true; doc: AssetDoc }
  | { exists: false; reason: 'not_in_registry' | 'path_mismatch' | 'registry_unavailable'; attempted: string };
class AssetVerifier {
  async verifyPath(expectedPath: string): Promise<VerifyResult>;
}
```

Wraps `describe_assets({paths: [expectedPath]})` with strict-match semantics. Used by:
- The three existing connector download tools (`hayba_polyhaven_download`, `hayba_ambientcg_download`, `hayba_sketchfab_download`) — post-download verification (#4 fix).
- Any future tool that claims to have created an asset.

### Meta-tools (`asset-retriever/meta-tools/`)

```ts
// hayba_asset_search
const schema = {
  query: z.string().min(1),
  k: z.number().int().min(1).max(50).optional(),
  filterClass: z.string().optional(),
  filterSource: z.enum(['project', 'polyhaven', 'ambientcg', 'sketchfab', 'fab', 'unknown']).optional(),
};
// Returns: { hits: Array<{ path, name, class, tags, source, score }> }

// hayba_asset_browse
const schema = {
  filter: z.object({
    path: z.string().optional(),
    class: z.string().optional(),
    tag: z.string().optional(),
    source: z.enum(['project','polyhaven','ambientcg','sketchfab','fab','unknown']).optional(),
  }).optional(),
  offset: z.number().int().min(0).optional(),
  limit: z.number().int().min(1).max(200).optional(),
};
// Returns: { total, offset, limit, docs: AssetDoc[] }

// hayba_asset_reindex
const schema = {};
// Returns: { ok, durationMs, docCount, backend: 'ollama'|'transformers'|'bm25', fallbackUsed }
```

### Connector verification contract (modifies existing downloaders)

`hayba_polyhaven_download`, `hayba_ambientcg_download`, `hayba_sketchfab_download` are updated so their return shape becomes:

```ts
type DownloadResult =
  | { ok: true; path: string; doc: AssetDoc }  // verified
  | { ok: false; error: {
      kind: 'verification_failed';
      reason: 'not_in_registry' | 'path_mismatch' | 'registry_unavailable';
      attempted: string;
      stderr?: string;  // Python output if available
    } };
```

The existing silent `imported: true` is removed. Old callers reading just `.ok` continue to work; callers that read `.imported` need to migrate to `.ok` (one-shot migration documented in CHANGELOG).

After a successful verified download, the indexer is signaled via `AssetIndex.markDeltaStale([path])`. The next search/browse call delta-refreshes those paths before answering.

## Data flow

**Cold first search.**
1. `hayba_asset_search({query})` called.
2. Cache miss → `AssetIndexer.build()` → `describe_assets({path:'/Game/'})`.
3. If `unknown_command`, fallback to `list_pcg_assets`, tags array empty, warn once.
4. `AssetIndex.build` runs BM25 + (if backend available) embeds via Ollama/transformers.js.
5. Cache written: `meta.json` + `bm25.json` + `vectors.bin`.
6. Search returns ranked hits.

**Warm search.** In-memory index → ranking only.

**Connector download with verification.**
1. `hayba_polyhaven_download({asset})` called.
2. Download tool runs UE Python via existing path, obtains `expectedPath`.
3. Calls `AssetVerifier.verifyPath(expectedPath)`.
4. On `exists:true` → return `{ok:true, path, doc}` + `AssetIndex.markDeltaStale([path])`.
5. On `exists:false` → return `{ok:false, error:{kind:'verification_failed', ...}}`.

**Search after a download.** Index sees `deltaStalePaths` non-empty → `AssetIndexer.describeDelta(paths)` → if all registry-confirmed, `AssetIndex.addOrUpdate(newDocs)` + cache update. If any path missing, full reindex.

**Browse first call (no search yet).** Triggers the same `AssetIndexer.build()` path before answering, so `AssetCatalog` is populated.

**Force reindex.** `hayba_asset_reindex()` → drop cache, `build({forceRefresh:true})`, persist, return summary.

## Error handling

| Failure | Response |
|---|---|
| `describe_assets` returns `unknown_command` | Fall back to `list_pcg_assets`; tags empty; warn once. |
| Empty `/Game/` | Index builds with 0 docs; search/browse return empty cleanly, no error. |
| TCP transport error mid-build | Reject with `UeToolError{code:'transport'}`; index stays empty; subsequent search returns `{hits:[], indexError:'transport'}` so LLM knows to retry. |
| Embedding backend dies mid-build | Degrade to BM25-only with one-time warning. |
| Cache corruption | Delete cache file, rebuild from scratch. Never block on cache. |
| Connector verification fails | Return `{ok:false, error:{kind:'verification_failed', reason, attempted, stderr?}}`. |
| `hayba_asset_browse` filter matches nothing | `{total:0, offset, limit, docs:[]}` — not an error. |
| `hayba_asset_reindex` while build in flight | Await the in-flight build (Promise-mutex). |
| `vectors.bin` size mismatch (e.g. half-written) | Treat as cache corruption → full rebuild. |

## Testing

**Unit (vitest, `src/tools/asset-retriever/`)**
- `asset-indexer.test.ts` — describe_assets happy path; unknown_command fallback; transport error rejection; snapshotHash stability across builds.
- `asset-index.test.ts` — BM25 ranking; hybrid with mocked embeddings; cache write/read; corruption recovery; delta-merge correctness; vectors.bin round-trip.
- `asset-catalog.test.ts` — pagination; multi-filter combinations; offset overflow; prefix-match on path.
- `asset-verifier.test.ts` — registry hit → `{exists:true, doc}`; miss → `{exists:false, reason:'not_in_registry'}`; transport error → `{exists:false, reason:'registry_unavailable'}`.
- `meta-tools/{search,browse,reindex}.test.ts` — happy paths + edge cases per meta-tool.

**Connector verification regression tests**
- Update existing `polyhaven-download.test.ts`, `ambientcg-download.test.ts`, `sketchfab-download.test.ts`.
- Mock `describe_assets` to confirm post-download verification calls fire.
- Assert old silent-success path now returns `{ok:false, kind:'verification_failed'}` when the asset isn't in the registry.

**Integration (`tests/asset-retriever-integration.test.ts`)**
- In-process MCP server with a fixture `describe_assets` handler returning a synthetic 20-asset content browser.
- Drive: `hayba_asset_search` returns ranked hits; simulated download + verify → `markDeltaStale` → next search includes new asset.
- Assert `hayba_asset_reindex` produces fresh index with correct `docCount` + `backend`.

**Smoke (manual)**
- Connect to real UE editor with Megascans-populated project. Call `hayba_asset_search("ancient stone")`, inspect ranked hits. Run a Polyhaven download, observe verification + auto-delta. Run `hayba_asset_reindex` after a large import batch, observe progress logs + summary.

## File layout

New:
```
mcp-tools/hayba-mcp/src/tools/asset-retriever/
  asset-indexer.ts
  asset-index.ts
  asset-catalog.ts
  asset-verifier.ts
  meta-tools/
    search.ts
    browse.ts
    reindex.ts
  README.md
mcp-tools/hayba-mcp/tests/
  asset-retriever-integration.test.ts
```

Modified:
- `src/tools/routing/register.ts` — add the three new tools to `ALWAYS_ON_META` and register them in `registerDeferredRouting`.
- `src/tools/asset-sources/polyhaven-download.ts` — route through `AssetVerifier`, change return shape.
- `src/tools/asset-sources/ambientcg-download.ts` — same.
- `src/tools/asset-sources/sketchfab-download.ts` — same.
- `mcp-tools/hayba-mcp/CONTEXT.md` — document the asset retriever + new verification contract.
- `mcp-tools/hayba-mcp/CHANGELOG.md` — note the connector return-shape migration.

UE plugin (separate sub-PR, tracked in implementation plan):
- Add `describe_assets` TCP command implementation. Until shipped, the indexer's `list_pcg_assets` fallback is the supported path.

## Risks & mitigations

- **`describe_assets` UE command not yet built** → fallback to `list_pcg_assets` keeps the retriever functional with degraded metadata. Clearly logged.
- **Large content browsers (10k+ assets)** → embedding time becomes minutes. Mitigation: progress logging during build; cache persisted so the cost is one-time per content-browser change. If users report pain, the v2 follow-up is incremental indexing by path subtree.
- **Cache becomes stale silently** (user imports outside MCP control) → manual `hayba_asset_reindex` is the documented escape hatch. UE event hook is the eventual fix (out-of-scope here).
- **`vectors.bin` format drift across releases** → `meta.json` includes a `vectorsFormatVersion` field; mismatch triggers full re-embed. Trivial to implement, costs nothing.
- **Connector return-shape migration** → CHANGELOG entry + a one-shot codemod note. Internal callers (Hayba dashboard, any TS code calling these tools directly) are few; external Claude callers read the `ok` field which is preserved.

## Out of scope (separate specs)

- Layer 2 abstraction primitives: `wait_for_idle`, `frame_target`, lighting presets, PCG overrides + completion + query, frustum/LOS queries.
- `python_run` rework (exec mode, stdout capture, error distinguishing, async).
- Screenshot pipeline consolidation + capture-actor hiding.
- Plugin source duplication (symlink / submodule / generated snapshot).
- Operation log / snapshot-restore journal.
- Out-of-process editor liveness probe.
- Intent-to-parameter regressor (Layer 3b).
- CLIP/thumbnail visual-similarity search.
- Live external-catalog indexing (Polyhaven/ambientCG/Sketchfab/Fab full catalogs).
