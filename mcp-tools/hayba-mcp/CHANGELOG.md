# HaybaMCPToolkit Changelog

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
