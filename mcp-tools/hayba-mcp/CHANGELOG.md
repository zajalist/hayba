# HaybaMCPToolkit Changelog

## Unreleased

### render_camera (verified single-file screenshot pipeline, since 2026-05-21)

- New `render_camera({camera, output_path?, width, height, format, wait_for_subsystems, wait_timeout_s})` MCP tool. Camera accepts either an actor reference (`{kind:'actor', actor}`) or an inline transform (`{kind:'transform', location, rotation, fov?}`).
- Writes to disk + **verifies** the file landed (magic bytes per format + PNG dimensions check) before returning ok. Closes the 17KB-blank-PNG class of silent failure from `mcp-architectural-issues #2`.
- Output defaults to `Saved/Screenshots/Hayba/hayba_<timestamp>_<uuid>.<ext>`. Returns `{ok, path, width, height, fileBytes, renderDurationMs, waitMs}` or structured `{ok:false, error:{kind, ...}}` for actor_not_found / file_not_written / file_invalid / wait_timeout.
- Internally consumes the same per-subsystem readiness predicates as `wait_for_idle` (shaders/assets/world_tick by default) so half-loaded scenes don't render.
- C++ side ships `FHaybaMCPRenderHandler` (`unreal/.../handlers/HaybaMCPRenderHandler.{h,cpp}`) and rebuilds `AHaybaMCPCaptureActor` with `bHidden=true`, `bIsEditorOnlyActor=true`, `Tags=[HaybaMCPCaptureActor, HaybaMCP_Internal]` — no more "blue spray bottle" in hero shots (closes #13).
- `actor_list` now filters Hayba internal actors by default; pass `include_internal: true` to see them.

### wait_for_idle (UE subsystem readiness, since 2026-05-21)

- New `wait_for_idle(subsystems?, timeout_s, pcg_actors?, world_ticks?)` MCP tool covering `shaders`, `assets`, `gc`, `pcg`, `world_tick`. Default `subsystems` unset = wait for all five. Structured `{ok, durationMs, settled, timedOut?}` response distinguishes settled-in-time vs. partial-timeout per subsystem.
- `wait_for_shaders` now delegates to `wait_for_idle({subsystems:['shaders']})` with a per-process capability-flag fallback to the legacy `wait_for_shaders` command if the plugin doesn't yet know `wait_for_idle` — so live editors running an older plugin build keep working. `poll_seconds` parameter is ignored (UE-side polling is fixed at 250ms); a one-time warning is logged.
- C++ side ships in `unreal/HaybaMCPToolkit/Private/handlers/HaybaMCPIdleHandler.{h,cpp}` — synchronous `IHaybaMCPHandler` that schedules `FTSTicker` polling on the game thread and blocks the TCP-handler thread on an `FEvent` until all requested subsystems settle. Handles both `wait_for_idle` and `wait_for_shaders` commands.
- Closes `.scratch/mcp-architectural-issues.md` #3.

### Asset Retriever (Layer 3a, since 2026-05-20)

- New always-on meta-tools: `hayba_asset_search` (hybrid BM25+embedding semantic search over the UE Content Browser), `hayba_asset_browse` (paginated filtered enumeration — escape hatch for the LLM when search isn't the right operation), `hayba_asset_reindex` (manual refresh).
- Embedding backend auto-selected: Ollama → BM25-only fallback (works without GPU/Ollama). The local Transformers backend was removed because its Sharp/ONNX install graph carried unresolved high-severity production advisories.
- Lazy first-call build; index persisted to `Saved/HaybaMCP/asset-index.{meta.json,bm25.json,vectors.bin}` and invalidated by a sha256 of `(path, lastModified)` per asset.
- **Closes silent-success hole in connectors (mcp-architectural-issues #4):** `hayba_polyhaven_download`, `hayba_ambientcg_download`, `hayba_sketchfab_download` now route their post-import claim through `AssetVerifier`. `DownloadedAsset` gains `verified: boolean` and `verifyReason?: string`; `imported` is now true only when the asset registry confirms the import. On verified success, the retriever's index is marked stale for that path so the next `hayba_asset_search` delta-merges without a full reindex.

### Pending (UE plugin sub-PR)

- `describe_assets` TCP command — returns `{assets: AssetDoc[]}` for paths under a root or for an explicit list. Once shipped, the asset retriever picks up full tag metadata; until then it gracefully falls back to `list_pcg_assets` (path-only).

### Asset-source connectors (pure-Node, no UE C++ bridge)

- **Poly Haven** — `hayba_polyhaven_search` (HDRIs / textures / models, CC0) and `hayba_polyhaven_download` (resolution-selectable, downloads individual map files for textures, prefers HDR for HDRIs, glTF for models). No auth.
- **ambientCG** — `hayba_ambientcg_search` and `hayba_ambientcg_download` (CC0 PBR material zips; default attribute `2K-JPG`, falls back to first available zip). No auth.
- **Sketchfab** — `hayba_sketchfab_search` and `hayba_sketchfab_download` (gltf / usdz / source flavours). **Requires `SKETCHFAB_API_TOKEN` env var** — obtain at https://sketchfab.com/settings/password (API tokens section). Missing-token error message is actionable.
- Shared cache at `<os.tmpdir>/hayba-asset-connectors/<source>/<assetId>/`. Zip extraction via `adm-zip`. UE import is invoked via the existing `python_run` MCP command (build_import_data + import_asset_tasks); no new C++ handler. Failed imports surface as `imported: false` with an `importNote`.

## v0.3.0 — 2026-05-06

Massive expansion from a PCG/landscape-only plugin into a 34-domain agentic level-design system.

### Highlights

- **34 domains, 157 commands** across the C++ TCP plugin (93 implemented + 64 stub-advertised)
- **5-agent swarm runtime** with shared SQLite memory and per-archetype tool filters
- **Visual sidecar** (Python/uv): CLIP / SpatialCLIP / OWL-ViT embeddings via FastAPI on `:7821`
- **Settings UI** in Project Settings → Plugins → Hayba MCP Toolkit (security, performance, sidecar)
- **4 workflow skills** (`hayba-new-scene`, `hayba-refine-scene`, `hayba-debug-level`, `hayba-pcg-build`)

### C++ plugin (`HaybaMCPToolkit`)

- `FHaybaMCPResponseBuilder` — output trimming with `_truncated` diagnostics, depth limit, deterministic field-drop
- `FHaybaMCPSecurityManager` — capability-token auth, deterministic SHA-1 params hash, append-only execution journal at `Saved/hayba-execution.log`
- Domain-partitioned router via `IHaybaMCPHandler` + `FHaybaHandlerResult` (handlers return payload, router builds envelope and applies trimming)
- Implemented handlers: actor (14), level (8), scene (3 — modes flat/relational/hierarchical + physics validation + cognitive map cache), editor (10 — viewport capture via persistent `AHaybaMCPCaptureActor`, PIE control, console, log streaming), python (3-tier safety: read-only / mutation / unsafe), asset (8), blueprint (11), material (8), foliage (4), spline (5), world-partition (3), ISM (4), physics (3), docs (3 — live UE reflection), legacy (11 — PCG/landscape migrated with namespaced aliases)
- Stub handlers advertise commands for: sequencer, animation, niagara, audio, metasound, GAS, behavior tree, input, UI, network, static mesh, texture, data assets, project, build, test
- `UHaybaMCPDeveloperSettings : UDeveloperSettings` exposes Security / Performance / Visual Sidecar fields in Project Settings; bridges to existing `FHaybaMCPSettings` cache

### Node.js MCP layer (`packages/hayba/src/`)

- `HaybaToolMeta` — cost-aware tool schemas (`cost`, `effects`, `when`, `not_when`)
- `RateLimiter` — sliding-window per-key rate limiter (default 60 req/min)
- `ToolCache` — lru-cache wrapper with read-cache + write-invalidation
- Code Mode meta-tools: `list_tool_categories`, `get_tool_signature`
- Tool wrappers: actor (4), scene (2), editor (3 incl. `editor_stream_log`), python (1), visual (3 — moodboard, references, CLIP comparison)
- `HaybaMemory` — better-sqlite3 collaborative memory (write/query/clear, scope + agentRole filters, provenance)
- `AgentRegistry` — loads `hayba.agents.json`, instantiates per-archetype runtimes with glob `tool_filter` matching

### Add-ons

- `addons/visual-embeddings/` — uv-managed Python sidecar (`/health`, `/embed`, `/validate`)
- `addons/workflows/` — 4 SKILL.md guides for Claude Code

### Configuration

- `hayba.agents.json` — 5 archetypes (Director, Asset Manager, Pattern Expert, Node Expert, Blueprint Generator)
- `Plugins/HaybaMCPToolkit/HaybaMCPToolkit.uplugin` bumped to `0.3.0` (Version 3)
- `HaybaMCPToolkit.Build.cs` adds: `LevelEditor`, `WorldPartitionEditor`, `MaterialEditor`, `MovieScene`, `DeveloperSettings`, `HotReload`

### Tests

- 70+ vitest tests across the TS layer (tool meta, rate limiter, cache, code-mode, actor/scene/editor/python tools, visual tools, agent registry, HaybaMemory)
- Manual smoke test: `pwsh packages/hayba/scripts/smoke-test-tcp.ps1` exercises one command per implemented domain

### Migration notes

- Existing legacy commands (`ping`, `list_node_classes`, `get_node_details`, `list_pcg_assets`, `export_graph`, `create_graph`, `validate_graph`, `execute_graph`, `import_landscape`, `read_node_output`, `wizard_chat`) keep working unchanged. Each also has a namespaced alias (`pcg_*`, `landscape_*`).
- Auth: when `CapabilityToken` is set in Project Settings, every TCP request must include matching `auth` field. Empty token disables auth (default).

## Unreleased

### Added

- TCP response envelope: optional `code` field for machine-readable rejection
  reasons. Only set on plan-gate and tool-disabled paths today. Older TS
  clients ignore the field (wire-compatible). The TS ToolExecutor maps
  `code` onto `UeToolError.code` so callers can branch without
  string-matching error text. **Requires a plugin recompile.**
- **ToolExecutor seam** (`src/tools/tool-executor.ts`): a single `executeCommand(cmd, params, opts?)` API behind which lives connection management, 1× auto-retry on transport failure, timeout-from-cost (low=2s / med=10s / high=60s), and a uniform `UeToolError` with `code` discriminator (`transport | timeout | plan_gate | tool_disabled | ue_error`). 15 handlers shed their `ensureConnected + client.send + bespoke error throw` boilerplate (4 files retain direct TCP usage for documented reasons: editor_capture_viewport / scene_validate_physics sidecar relay, python_run tier-3 branching, tool-stream-mirror observability). Two adapters ship: the live (TCP) sender used in production, and an `InMemoryToolExecutor` that lets handler tests run without a live UE on `:52342`. The companion `tool-meta-registry` populates from `src/tools/index.ts` at startup so the executor can look up cost by command name (12 tools metaed today; remaining default to medium=10s).
- **`wait_for_shaders` MCP tool** — polls UE's `GShaderCompilingManager` until pending shader jobs hit zero or `max_seconds` elapses. Returns `{ settled, remaining, waited_seconds, timed_out }`. Useful between heavy actor spawns and screenshots so captures don't race against shader compilation. Default `max_seconds=60`, `poll_seconds=1`. **Requires a plugin recompile** for the C++ command handler to take effect.
- Opt-in `wait_for_shaders` boolean flag on `editor_capture_viewport` that calls the wait internally before the capture (default false to preserve current behaviour).
- **FAB connector** — 4 new MCP tools (`hayba_fab_login_status`, `hayba_fab_library_list`, `hayba_fab_marketplace_search`, `hayba_fab_download`) wrap Epic's Fab plugin. Auth is handled by the Fab plugin itself — the user signs in once via the Fab Window in the editor, and the connector uses the live auth token via UE reflection. Downloads use Epic's native `FFabDownloadRequest`. **Requires a full plugin rebuild** (not just Live Coding) because the connector adds a new Fab module dependency — close UE, rebuild HaybaMCPToolkit from Visual Studio, reopen UE.
