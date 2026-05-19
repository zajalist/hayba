# Changelog

All notable changes to Hayba MCP Toolkit are documented here. Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added
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

### Known Issues
- Plan panel step status never advances. `SHaybaMCPPlanPanel::MarkStepCompleted()` is implemented but has **no callers** — there is no TCP command or MCP tool for the agent to report per-step progress. After Approve, step 0 shows `Running` and all steps stay frozen regardless of execution. Proper fix needs: a `plan_mark_step` TCP command + C++ handler routing to `MarkStepCompleted`/Running/Failed, an MCP tool (or auto-emit on tool completion), and the agent calling it per step. Requires a plugin recompile.

### Fixed
- Plan panel clipped each step to a single line. The step **title** `STextBlock` in `SHaybaMCPPlanPanel::BuildStepRow` was missing `.AutoWrapText(true)` (its description/header siblings already had it), so long step titles were truncated with no wrap. Title now wraps like the description.
- `hayba_search_node_catalog` returned `[]` for every multi-word query. `searchCatalog` matched the entire query as one contiguous substring of the node's joined searchable text, so phrases like `"Delaunay 2D cluster"` never matched (the literal phrase never appears verbatim) while single words worked. Query is now tokenized on whitespace with AND semantics (every token must be a substring of the searchable text); single-token queries are unchanged. Matching logic extracted into a pure, unit-tested `searchNodes(nodes, query)` helper.
- HLOD instancing actors no longer flagged as floating in `scene_validate_physics` (filter both sides of the overlap pair).
- `scene_validate_physics` reports `scanned_actors` / `checked_count` / `skipped_system_actors` for visibility into the filter.
- `editor_stream_log` opens the active log with `FILEREAD_AllowWrite` so the live writer doesn't lock us out.
- Tool Stream rows lose hover-border-disappear glitch (custom `FTableRowStyle` with transparent hover brushes).

### Changed
- Code Mode (default-on) — `list_tool_categories` / `get_tool_signature` / `python_run` filter the disabled-tools set so agents only see what the user has enabled.
- TCP client (Node) — discovers the right UE editor by reading `Saved/HaybaMCP/instances/` heartbeats; falls back to `UE_TCP_PORT` env var or `52342`.
- Build.cs adds `EngineSettings`, `SourceControl`, `WebBrowser` / `WebBrowserWidget` private deps.

## Earlier history

Pre-roadmap commits are summarized in the [open feat/mcp-stabilization PR](https://github.com/zajalist/hayba/pull/2). Major themes:

- 34-domain UE plugin (Actor / Level / Scene / Asset / Blueprint / Material / Foliage / Spline / WP / ISM / Physics / Python / Editor / Docs + 16 stubs).
- Code Mode meta-tool architecture.
- PCGEx catalog scraper — 344 nodes / 356 pins / 2270 properties.
- 5-archetype swarm + SQLite memory.
- Onboarding wizard + Plan Mode + 7d/50-call auto-prompt.
- Visual sidecar (CLIP / SpatialCLIP / OWL-ViT) addon package.
