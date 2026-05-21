# Hayba MCP Tool Routing — γ Hybrid (Context Layer)

**Date:** 2026-05-20
**Status:** Design approved, ready for implementation plan
**Scope:** Context Layer (Layer 1 of three-layer architecture). Schema deferral, named packs, semantic tool search, and a polymorphic invoke dispatcher for the Hayba MCP server. Asset retrieval (Layer 3) and deterministic abstraction primitives (Layer 2) are explicitly out of scope.

## Problem

`mcp-tools/hayba-mcp` currently registers all ~150 tools at session start via `server.tool(...)`. Every Claude Code (or other MCP client) session pays the full token cost of all Zod schemas before the user types a prompt. This causes:

- **Token tax** at the start of every session.
- **Tool-call hallucination** and **identity misbinding** because the LLM's attention is diluted across an oversized tool surface (e.g., confusing `architecture_resolve_rules` with `architecture_validate_culture`).
- **Multi-hop drift** in long sessions as tool results compound the context bloat.

Existing scaffolding (`schema-registry`, `tool-meta-registry`, `code-mode/list-tool-categories`, `code-mode/get-tool-signature`, `disabled-tools-watcher`) is the *substrate* for a deferred system but does not itself defer anything — all enabled tools still ship their full schemas.

## Goals

1. Cut the steady-state tool-list footprint Claude sees at session start from ~150 typed tools to **6 meta-tools** plus whatever packs are explicitly pinned.
2. Let the LLM **discover** relevant tools semantically (BM25 + embeddings, hybrid-ranked).
3. Let the LLM **load typed tool packs on demand** via MCP's `notifications/tools/list_changed` — preserving native typed-tool ergonomics for the active workflow.
4. Provide a **polymorphic escape hatch** (`hayba_invoke`) for one-off cross-pack calls without forcing a pack-load thrash.
5. Provide a **`full` mode fallback** for MCP clients that do not honor `listChanged`, picked from the UE plugin settings panel — not env vars.

## Non-goals

- Asset embedding retrieval (Layer 3, future spec).
- Constraint-solver / ASP abstraction primitives (Layer 2, future spec).
- Changing the existing `search_node_catalog` (PCGEx node search is a different domain).
- Any UE plugin UI rework beyond a new `toolRouting` field in the settings JSON.
- Auto-detection of client `listChanged` support (v1: user picks routing mode explicitly).

## Architecture

Three new runtime components live in `mcp-tools/hayba-mcp/src/tools/routing/`:

- **`PackRegistry`** — owns the catalog of packs (auto-derived from `src/tools/*/` directory structure, plus curated workflow packs from `routing/packs.yaml`), tracks which are loaded in the current session, and exposes `loadPack` / `unloadPack` to mutate that state and trigger `listChanged`.
- **`ToolIndex`** — BM25 + (optional) embedding index over every registered tool. Built at server start, cached to disk, hash-keyed to the tool registry so it rebuilds only when tools change.
- **`RoutingMode` / settings watcher** — reads `Saved/HaybaMCP/settings.json` (live-watched), exposing `toolRouting: "deferred" | "full"` and `alwaysLoadPacks: string[]`.

### Routing modes

- **`deferred` (default)** — γ hybrid behavior. `server.tool(...)` is called only for the 6 always-on meta-tools plus the tools of every loaded pack (initially: `alwaysLoadPacks` from settings). Other tools are invocable via `hayba_invoke` and discoverable via `hayba_search_tools`.
- **`full`** — legacy/fallback. Every non-disabled tool is registered at start; the 6 meta-tools and pack-load machinery are not exposed. For MCP clients that don't honor `notifications/tools/list_changed`.

Settings hot-reload semantics:
- **`alwaysLoadPacks`** changes are watched live but apply only on next MCP restart (avoids mid-session tool-list thrash).
- **`toolRouting`** changes require an MCP restart (logged warning on change).
- The 6 meta-tools are stable across the session; pack composition mutates only via `hayba_pack_load` / `hayba_pack_unload` / `autoLoadOn`.

### Pack types

- **Domain packs** — derived primarily from `src/tools/*/` subdirectories (`actor`, `scene`, `editor`, `fab`, `asset-sources`, `worldbuilding`, etc.). Pack name = directory name; membership = tools registered from handlers in that directory.
  - Many existing PCGEx, planet-sim, and validation tools live at the root of `src/tools/` (not in subdirectories). For these, `HaybaToolMeta` is extended with an optional `pack?: string` field; if present, the tool joins that named domain pack (e.g., `pack: "pcgex"`, `pack: "planet"`) instead of being orphaned. Root-level tools without an explicit `pack` join a default `core` domain pack and log a warning at startup recommending classification.
  - This keeps the model drift-proof for the dir-organized half and explicit-but-static for the root-level half, with a CI lint to keep the explicit half complete.
- **Workflow packs** — curated in `src/tools/routing/packs.yaml`. Cherry-pick tools across directories that compose a common user workflow (`biome`, `planet-to-city`, `texture-hunt`, `architecture-design`). Workflow packs are the LLM's primary discoverable entry points; domain packs are the catch-all.

A tool can belong to multiple packs (e.g., `hayba_polyhaven_search` lives in the `asset-sources` domain pack and the `biome` workflow pack).

`packs.yaml` shape:

```yaml
packs:
  - name: biome
    kind: workflow
    description: Generate dense ecological PCG biomes from intent.
    tools:
      - create_pcg_graph
      - hayba_polyhaven_search
      - hayba_polyhaven_download
      - architecture_resolve_rules
      - actor_spawn
  - name: editor
    kind: workflow
    description: Live UE editor introspection and PIE control.
    autoLoadOn: ue_connected
    tools:
      - editor_capture_viewport
      - editor_stream_log
      - editor_start_pie
      - wait_for_shaders
```

`autoLoadOn: ue_connected` is the only auto-load trigger in v1; it fires inside `check_ue_status` on first success.

### Always-on surface (deferred mode)

Six tools, registered at server start regardless of pack state:

| Tool | Purpose |
|---|---|
| `hayba_search_tools(query, k=8, filterPack?)` | Hybrid BM25 + embedding search over the full tool catalog. Returns ranked hits with summary + pack membership. |
| `hayba_pack_list()` | Lists all packs (domain + workflow), with `loaded` flag and `toolCount`. |
| `hayba_pack_load(name)` | Registers a pack's tools, fires `notifications/tools/list_changed`, returns added tool names. |
| `hayba_get_tool_signature(name)` | Existing — full schema for a single tool without loading its pack. |
| `hayba_invoke(name, args)` | Polymorphic escape hatch: validates `args` against the tool's recorded Zod schema, dispatches via `tool-executor.executeCommand`, rejects disabled tools. |
| `check_ue_status()` | Existing — small. Wrapped so first-success triggers `loadPack("editor")` if pack has `autoLoadOn: "ue_connected"`. |

`python_run` is moved from always-on into a `python` pack (footgun reduction; still loadable on request).
`editor_*` tools are bundled into the `editor` workflow pack with `autoLoadOn: ue_connected`.

### Settings file

`Saved/HaybaMCP/settings.json` — written by the UE plugin's settings panel (same mechanism as the existing `disabled-tools.json`).

```json
{
  "toolRouting": "deferred",
  "alwaysLoadPacks": []
}
```

- Live-watched (`fs.watch`) by the same pattern as `disabled-tools-watcher.ts`.
- Default if file is missing: `{ "toolRouting": "deferred", "alwaysLoadPacks": [] }`.
- `alwaysLoadPacks` lets a power-user pin packs at MCP boot (e.g., a project that only ever does biome work pins `["biome"]`).
- `toolRouting` changes require an MCP restart to take effect (warning logged).

### Index pipeline

`ToolIndex` is built at server start:

1. Compute registry hash from sorted `(name, schemaHash)` pairs across all known tools (loaded or not).
2. Check `Saved/HaybaMCP/tool-index.meta.json`. If hash + embedding-backend ID match the cache, load `tool-index.bm25.json` and `tool-index.embeddings.bin` from disk.
3. On mismatch: rebuild affected halves. BM25 rebuild is in-process (`minisearch`), instant for ~150 docs. Embedding rebuild probes Ollama (`http://localhost:11434/api/embeddings`, model `nomic-embed-text`); on failure probes `@xenova/transformers` (model `Xenova/all-MiniLM-L6-v2`); on failure of both, embeddings half is skipped and a one-time warning is logged.
4. Write cache back to disk.

Per-tool document fields: `{ name, summary, description, params, packs, tags, cost }`. `summary` is the first sentence of `description`; `tags` come from `HaybaToolMeta`.

Query: BM25 returns top-N (N=20), embeddings returns top-N (if available), results merged via reciprocal-rank fusion (k=60), top-k returned. If `k≤3`, full signatures are inlined in the search result; else summary-only and the response tells Claude to call `hayba_get_tool_signature` for details.

If embeddings backend disappears mid-session, queries degrade to BM25-only silently and log a one-time warning.

## Data flow

**Session start.**
1. MCP boots, reads `settings.json`.
2. `PackRegistry.scanDomainPacks()` + `loadWorkflowPacks()` populate pack definitions.
3. `ToolIndex` loads or rebuilds.
4. In `deferred`: register 6 always-on tools + every tool from `alwaysLoadPacks`. In `full`: register every non-disabled tool, skip meta-tool registration.
5. Server announces ready.

**LLM exploring an unfamiliar request.**
1. Claude calls `hayba_search_tools("generate dense pine forest with rocks")`.
2. Index returns ranked hits with pack membership. Top result: `create_pcg_graph`, in `pcgex` domain pack and `biome` workflow pack.
3. Claude calls `hayba_pack_load("biome")`.
4. `PackRegistry` registers all biome-pack tools via `server.tool(...)`, fires `notifications/tools/list_changed`, returns the list of newly-registered tool names.
5. Claude re-fetches tool list, sees typed `create_pcg_graph`, `hayba_polyhaven_search`, `architecture_resolve_rules`, etc., calls them natively.

**Cross-pack ad-hoc.**
1. Inside the `biome` workflow, Claude needs `actor_spawn` (not in biome pack).
2. Calls `hayba_search_tools("spawn actor")` → finds `actor_spawn` in `actor` domain pack.
3. Either `hayba_invoke("actor_spawn", { ... })` for the one-off, or `hayba_pack_load("actor")` if repeated use is expected.

**UE editor connects mid-session.**
- `check_ue_status` first-success → `loadPack("editor")` → `listChanged` → Claude sees viewport capture / log streaming / PIE tools.

**Tool added to codebase.**
- Dev restarts MCP. `ToolIndex` hash mismatch → rebuild (BM25 instant; embeddings if backend present). No manual step.

## Error handling

- **`hayba_invoke` bad args** — reuse Zod validation from `schema-registry`, return structured `{ kind: "validation", path, expected }` for LLM self-correction.
- **`hayba_invoke` on disabled tool** — `{ kind: "tool_disabled", name }`, matching existing `disabled-tools-watcher` semantics.
- **`hayba_pack_load` unknown pack** — `{ ok: false, available: [...] }` so Claude doesn't loop on guesses.
- **`hayba_search_tools` no hits** — empty array + the pack list, hinting Claude to browse packs by name.
- **Embedding backend disappears mid-session** — fall back to BM25-only silently, log warning once.
- **Index disk-cache corruption / parse error** — delete cache file, rebuild from scratch. Never block startup on cache.
- **`listChanged` not honored by client** — undetectable server-side. Documented in the UE settings UI: "if your client doesn't refresh tools after `hayba_pack_load`, switch to `full` mode."
- **Pack-load race** (concurrent `hayba_pack_load` calls) — `PackRegistry` uses a per-pack Promise mutex; `loadPack` is idempotent.

## Testing

**Unit** (vitest, `mcp-tools/hayba-mcp/src/tools/routing/`)
- `pack-registry.test.ts` — directory scan, workflow YAML load, load/unload, idempotency, `autoLoadOn` trigger.
- `tool-index.test.ts` — BM25 ranking on a fixture corpus; hybrid merge with mocked embeddings; hash-based cache invalidation; degradation when embeddings unavailable; cache corruption recovery.
- `settings-watcher.test.ts` — default when file missing, hot-reload on edit, malformed JSON falls back to default, `toolRouting` change logs restart warning.
- `meta-tools/search.test.ts`, `meta-tools/pack-list.test.ts`, `meta-tools/pack-load.test.ts`, `meta-tools/invoke.test.ts` — happy paths, error shapes, schema validation.

**Integration** (`mcp-tools/hayba-mcp/tests/routing-integration.test.ts`)
- In-process MCP server with a fixture set of ~20 tools across 3 fake domain packs + 1 workflow pack.
- Assertions:
  - `deferred` mode: initial tool list is 6 always-on + 0 pack tools (with empty `alwaysLoadPacks`).
  - `hayba_pack_load("fixture-biome")` returns added tool names and increases the registered tool count.
  - `notifications/tools/list_changed` is emitted on pack load.
  - `full` mode: meta-tools absent, all fixture tools registered.
  - `hayba_invoke` round-trips a real tool call through `tool-executor`.

**Smoke** (manual, documented in `mcp-tools/hayba-mcp/CONTEXT.md`)
- Connect Claude Code to the MCP, observe initial tool count drops from ~150 to 6.
- Prompt: "search for biome tools", observe `hayba_search_tools` ranked hits.
- Prompt: "load the biome pack", observe new tools appear in Claude's view.
- Existing `npm test` in `mcp-tools/hayba-mcp` stays green.

## File layout

New:

```
mcp-tools/hayba-mcp/src/tools/routing/
  pack-registry.ts
  tool-index.ts
  settings-watcher.ts
  meta-tools/
    search-tools.ts
    pack-list.ts
    pack-load.ts
    invoke.ts
  packs.yaml
  README.md
mcp-tools/hayba-mcp/tests/
  routing-integration.test.ts
```

Modified:

- `src/tools/index.ts` — branch on `RoutingMode`: in `deferred`, register only meta-tools + `alwaysLoadPacks`; in `full`, current behavior.
- `src/tools/check-ue-status.ts` — wrap first-success with `PackRegistry.maybeAutoLoad("ue_connected")`.
- `src/tools/code-mode/list-tool-categories.ts` — deprecated; `hayba_pack_list` replaces it. Keep around behind a feature flag for one release for migration safety.
- `src/tools/code-mode/get-tool-signature.ts` — kept as-is, re-exported as `hayba_get_tool_signature` from meta-tools.
- `mcp-tools/hayba-mcp/CONTEXT.md` — document routing modes and pack model.

Unreal plugin (separate PR, tracked in implementation plan):

- `unreal/.../FHaybaMCPSettings` — add `ToolRouting` enum field (`Deferred` / `Full`) and `AlwaysLoadPacks` string array. Write to `Saved/HaybaMCP/settings.json` alongside the existing `disabled-tools.json`.

## Risks & mitigations

- **MCP client doesn't honor `listChanged`** → user falls back to `full` mode via UE settings. Documented in plugin UI.
- **Pack misclassification** (LLM loads wrong pack and burns a round-trip) → `hayba_search_tools` returns pack memberships with every hit, letting the LLM cross-check before loading.
- **Workflow packs go stale** as tools are renamed → `packs.yaml` references are validated at server start; unknown tool refs log a warning and are skipped. Implementation plan should include a CI check.
- **Cache invalidation bugs** → cache deletion path is hard-coded safe (`Saved/HaybaMCP/tool-index.*`); never blocks startup.
- **Embedding model download size / first-run latency** for `@xenova/transformers` (~25MB for MiniLM-L6) → cached after first run; warning logged on first download.

## Out of scope (deferred to later specs)

- Local embedding retriever over the user's UE Content Browser (Layer 3 asset retrieval).
- Intent-to-parameter regressor (Layer 3 fine-tuned model).
- ASP / WFC constraint solvers (Layer 2 abstraction primitives).
- Dependency-DAG / dirty-flag propagation across multi-system iteration (Layer 2 iteration semantics).
- Auto-detection of client `listChanged` capability.
- UE plugin UI redesign beyond the new settings fields.
