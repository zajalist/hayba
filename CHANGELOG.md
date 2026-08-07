# Changelog

All notable changes to Hayba MCP Toolkit are documented here. Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Fixed
- CI on `main` had been red for 26 days, from three causes that were not the code under test: `room-grammar.test.ts` read a developer-machine absolute path (`D:/UnrealEngine/...`); `registerDeferredRouting` **created** its embedding backend instead of accepting one, so the default probe's Hugging Face model download blew a 5s test timeout on any cold cache; and `no-stub-wrappers` correctly flagged three Blueprint commands that had been implemented but left on the stub denylist. `probeOllama` also had no timeout at all.
- **One visual sidecar.** Two FastAPI apps, both titled `hayba-visual-sidecar`, both defaulting to `:7821`, serving disjoint endpoints, with a single Node adapter calling across both — so whichever process ran, half the adapter was broken. Merged ([ADR-0006](docs/adr/0006-one-visual-sidecar.md)). The app also could not be *imported* without multi-GB weights, which took `/health` down with it; model imports are now lazy and `/health` reports real capability rather than a hardcoded `"clip": true`.
- The TCP receive buffer was never cleared on socket close, so a half-arrived frame from a dead editor prefixed the next connection's first frame and desynced the stream. Surfaced by extracting `FrameDecoder`.

### Changed
- `ueTool(command, schema)` absorbs the pass-through wrapper body — 93 byte-identical copies down to 36 that differ for a reason. `toMcpResponse` and `FrameDecoder` recovered from a branch stranded since May rather than rewritten.
- Two grep-based static checks were taught the new call form. Both kept **passing** while silently exempting 55 call sites, because `ueTool` calls `executeCommand` internally ([ADR-0007](docs/adr/0007-static-checks-must-know-every-call-form.md)). `wire-command-names` coverage went 56 → 111 sites.
- Repo shape: `apps/` (1,160 untracked residue files), the root `assets/` duplicate of `website/assets/` (~53 MB), `mcp-tools/gaea` (a `dist/` with no `src/`) and 7 unimported source files deleted. Handoffs filed into `docs/handoffs/`. `workspaces` narrowed from a glob matching four directories of which one had a manifest.
- `vitest.config.ts` carried 23 exclude patterns of which 21 matched no file, and was suppressing 13 passing tests. Now one honest pattern.
- CI gained C++ static analysis (CodeQL `c-cpp`) — the 43k-line plugin previously had none — and the sidecar job, formerly "import + lint", now actually imports and runs pytest, torch-free on purpose.

## [0.1.0] — 2026-08-07

First tagged release. The repo has shipped continuously for four months without ever cutting one, so this collects everything to date under a version rather than pretending it is new work.

### Added

- Scene Map panels (native + web) auto-refresh on level actor add/delete. Subscribes to `GEngine->OnLevelActorAdded` and `OnLevelActorDeleted`; debounced 0.5s so spawn bursts coalesce into a single rebuild. Native panel piggybacks on its existing `Tick`; web panel uses an `FTSTicker` poll (it has no Tick). Currently always-on — a `bSceneMapAutoRefresh` settings toggle is the follow-up. **Requires a plugin recompile** to take effect.
- **Initiative #1** — Native editor transaction wrapping. Every destructive AI op runs inside `GEditor->BeginTransaction` / `EndTransaction`, so Ctrl+Z reverts AI mutations natively.
- **Initiative #3** — Dynamic TCP port allocation (52342-52350) + heartbeat registry at `Saved/HaybaMCP/instances/<pid>.json`. Multiple UE editors can run side-by-side without port collisions; Node MCP client picks the most recently started.
- **Initiative #6** — `asset_move` and `asset_fix_redirectors` via `IAssetTools::RenameAssets`. Updates referencers in place instead of leaving redirectors.
- **Initiative #9** — Regex / severity / structured-output filters on `editor_stream_log`. Output emits `{line, category, severity, msg, raw}` objects when `format:"structured"`.
- **Initiative #10** — `asset_get_dependencies` + `asset_get_referencers` via `IAssetRegistry`. Lets the AI assess blast radius before destructive asset edits.
- Diff panel rewrite — grouped per-actor cards, source-control status badge per level package, Check Out All / Revert All / Submit footer actions via `ISourceControlModule`.
- Plan panel — empty-state explainer, "Load sample plan" button, per-step status glyphs, monospace tool name, Approve / Reject action bar. Plan tab now wires `Module->bPlanApproved` to the destructive gate so approval is required, not just proposal.
- Scene Map panel — Cognitive Map view per spec §3.2 (semantic cell grid + force-directed mindmap renderer with both Native Slate and CEF/D3.js backends, user-selectable via Settings).
- MCP Capabilities panel — toggle individual tools or whole categories off; disabled set persists to `Saved/HaybaMCP/disabled-tools.json` and is filtered at the meta-tool boundary.
- Tool Stream panel — per-turn selection (was per-call), grouped Copy / Archive bulk actions, color-coded domain chips, hover row outline.
- Settings panel — hover tooltips on non-obvious fields, dirty-aware Save button, Redo Setup at bottom in dedicated section, source control / sidecar / Plan Mode explainers.
- `hayba_propose_plan` registered as an MCP tool; agents can now push plans to the panel without TCP knowledge.
- Schema registry — `get_tool_signature` derives params live from Zod shapes; hand-maintained dict removed.
- Market analysis section (§9) appended to design spec with competitor matrix, moat ranking, and 10 prioritized initiatives.

### Changed

- **Repo split** — the tectonic simulation, Hayba Explorer (Tauri viewer), `viz/`, sim audit tooling, `design-tokens`, and the Rust workspace moved to [hayba-explorer](https://github.com/zajalist/hayba-explorer) with full history ([ADR-0005](docs/adr/0005-tectonic-stack-split-to-hayba-explorer.md)). `@hayba/linguistics` and `@hayba/planet-physics` relocated to `packages/` (the MCP server imports them). Root workspaces are now `packages/*` + `mcp-tools/*`.
- Code Mode (default-on) — `list_tool_categories` / `get_tool_signature` / `python_run` filter the disabled-tools set so agents only see what the user has enabled.
- TCP client (Node) — discovers the right UE editor by reading `Saved/HaybaMCP/instances/` heartbeats; falls back to `UE_TCP_PORT` env var or `52342`.
- Build.cs adds `EngineSettings`, `SourceControl`, `WebBrowser` / `WebBrowserWidget` private deps.

### Fixed

- Cognitive Map cluster labels were both too easily hijacked AND too easily suppressed. The old `ClassifyDominant` (in `HaybaMCPCogMapBuilder.cpp`) walked classes in count order and returned on the first rule that matched *any* class — so a cluster of 105 `StaticMeshActor` + 1 `DirectionalLight` returned `"lighting"` (minority hijack). A naive "majority class wins" would in turn label a real 10-light rig amongst 50 prop meshes as `"staticmesh"` (wrong the other way). Rewrote the classifier as a semantic-signal model: rule-matching classes are aggregated *by their semantic label* (so `DirectionalLight + SkyLight + PointLight` all sum into `"lighting"`), and the largest semantic bucket wins iff it has ≥3 actors OR ≥10% of the cluster — so 1-light noise stays buried but a real lighting rig dominates regardless of how many props sit alongside it. Fallback sanitises the dominant class name (stripping `BP_` / `_C` / `SM_` / trailing `Actor`). New helper `ClassCounts` returns `(name,count)` pairs. **Requires a plugin recompile** to take effect.
- Plan panel step status now advances. `SHaybaMCPPlanPanel::MarkStepCompleted()` previously had **no callers** — there was no TCP command or MCP tool for the agent to report per-step progress, so after Approve every step stayed frozen. Added `SHaybaMCPPlanPanel::SetStepStatus(index, status)` (with `MarkStepCompleted` delegating to it; completing a step auto-advances the next to `Running`, mirroring Approve), a `plan_mark_step` TCP command in `HaybaMCPCommandHandler` (`{ index, status: running|completed|failed }`, default `completed`, marshalled onto the game thread like `hayba_propose_plan`), and a `hayba_mark_plan_step` MCP tool the agent calls per step. **Requires a plugin recompile** for the C++ side to take effect.
- Plan panel clipped each step to a single line. The step **title** `STextBlock` in `SHaybaMCPPlanPanel::BuildStepRow` was missing `.AutoWrapText(true)` (its description/header siblings already had it), so long step titles were truncated with no wrap. Title now wraps like the description.
- `hayba_search_node_catalog` returned `[]` for every multi-word query. `searchCatalog` matched the entire query as one contiguous substring of the node's joined searchable text, so phrases like `"Delaunay 2D cluster"` never matched (the literal phrase never appears verbatim) while single words worked. Query is now tokenized on whitespace with AND semantics (every token must be a substring of the searchable text); single-token queries are unchanged. Matching logic extracted into a pure, unit-tested `searchNodes(nodes, query)` helper.
- HLOD instancing actors no longer flagged as floating in `scene_validate_physics` (filter both sides of the overlap pair).
- `scene_validate_physics` reports `scanned_actors` / `checked_count` / `skipped_system_actors` for visibility into the filter.
- `editor_stream_log` opens the active log with `FILEREAD_AllowWrite` so the live writer doesn't lock us out.
- Tool Stream rows lose hover-border-disappear glitch (custom `FTableRowStyle` with transparent hover brushes).

## Earlier history

Pre-roadmap commits are summarized in the [open feat/mcp-stabilization PR](https://github.com/zajalist/hayba/pull/2). Major themes:

- 34-domain UE plugin (Actor / Level / Scene / Asset / Blueprint / Material / Foliage / Spline / WP / ISM / Physics / Python / Editor / Docs + 16 stubs).
- Code Mode meta-tool architecture.
- PCGEx catalog scraper — 344 nodes / 356 pins / 2270 properties.
- 5-archetype swarm + SQLite memory.
- Onboarding wizard + Plan Mode + 7d/50-call auto-prompt.
- Visual sidecar (CLIP / SpatialCLIP / OWL-ViT) addon package.

[Unreleased]: https://github.com/zajalist/hayba/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/zajalist/hayba/releases/tag/v0.1.0
