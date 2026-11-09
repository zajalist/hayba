# Changelog

All notable changes to Hayba MCP Toolkit are documented here. Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added
- `blueprint_graph_batch`: up to 2048 Blueprint graph ops in one call
  (add_node, add_event, connect, set_pin, comment, move, remove, disconnect,
  fit_comments), with `ref` names linking ops. Each op runs through the
  matching single command, so the same validation and verified readback apply.
  The batch stops at the first failed op and reports `failed_index`, `refs`
  and `mutation_status`. It is one undo and one skeleton regeneration, with
  `compile`/`save` optional at the end. It replaces editor-Python graph
  builders.
- `blueprint_add_comment` (title-only house style, colour, Show Bubble When
  Zoomed and Color Bubble on by default), `blueprint_move_nodes`
  (position-only; `pack` removes overlaps using real node sizes, and
  `fit_comments` refits boxes afterwards), `blueprint_remove_nodes` (closes
  the Blueprint's editors first), and `blueprint_disconnect`.
- `blueprint_measure_nodes` and `blueprint_fit_comments`. Real rendered node
  rectangles come from a private off-screen `SGraphPanel`. Fit resizes every
  comment around its group, inner boxes first; it can optionally push
  overlapping groups apart, and `title_only` trims comment text to its title.
  Colour and bubble flags are never changed.
- `blueprint_add_node` gains `custom_event`, `macro` (StandardMacros, built
  in C++), `message`, `break_struct`, `make_struct`, `call_dispatcher`,
  `function_entry` and `function_result`. It also gains the palette nodes
  sequence, make_array, self, format_text, get_data_table_row,
  spawn_actor_from_class, create_widget, reroute, get_array_item and the
  switches. `variable_get`/`set` now resolve locals and other classes'
  members, and `function_name` accepts the `Class:Function` form.
- Native C++ `asset_save` replaces the python-backed tool. It saves named,
  loaded, dirty `/Game` packages only and verifies each (clean in memory, fresh
  file on disk). It refuses maps, read-only files, compiling Blueprints and
  PIE, and the save-everything mode is gone.
- `material_add_comment` / `material_set_comment` take `show_bubble` and
  `color_bubble`; add defaults both on.
- `asset_import` accepts `.gltf` / `.glb` as `static_mesh` under a strict
  policy:
  - Sources come only from a `TrustedImportRoots` folder, set in project
    settings and never by a tool call. The default is empty, which refuses
    glTF.
  - Every referenced buffer and texture must be a `data:` URI or a plain
    relative path below the `.gltf`. Each is pinned for the whole import,
    capped at 512 MiB per file and 1 GiB in total.
  - The glTF must be 2.x. Required extensions are limited to
    `KHR_materials_*`, `KHR_texture_transform` and `KHR_mesh_quantization`,
    and files with skins or animations are refused.
  - The destination folder must be new or empty.
  - The import runs through the project's Interchange asset pipeline in one
    synchronous automated task, and is verified by folder readback.
- Multi-agent editor leases (ADR-0010). `lease_acquire` / `lease_renew` /
  `lease_release` / `lease_status` claim `global`, `world:`, `wp-region:`,
  `asset:`, `actor:` or `pie` resources. Acquire never blocks: it answers
  granted or queued with position, holder and ETA. The envelope gains optional
  `owner` and `lease` fields; the Node client sends `HAYBA_AGENT_ID` (or a
  per-process id) and renews granted leases in the background. The new
  `LeaseEnforcement` setting is `Advisory` by default (commands run and carry a
  `lease_warning`); `Enforced` refuses them with `code: "lease_conflict"`.
- `python_run` accepts `deadline_s` (5 to 60 s) from a caller holding an
  exclusive lease on the current world, `transaction: false`, and
  `world_partition: true`.
- `editor_batch` / `batch_status` (ADR-0010). Several commands under one
  lease, one step per editor tick through the normal command path, with a
  fence after each step that waits across ticks for shaders, asset loads, GC
  and async loading (`fence_after: idle | gc | none`; `gc` collects garbage
  only under an exclusive region, world or global lease). Returns a `job_id`
  at once. `wp_region_load {bounds}` / `wp_region_unload` steps load World
  Partition regions with a loader adapter the batch owns, and every region is
  released by the time the batch ends; `on_error: stop | unload_then_stop`.
  At a fence the batch yields to other owners' queued interactive (or aged)
  lease requests; fence grants last at most 30 s and the batch stops yielding
  after 3 yields or 60 s.
- `ping` reports `capabilities.lease_manager`, `editor_batch` and
  `wp_region_steps`, so host scripts can switch from a file lock to leases.
- A proposed lease-based `editor_gate.py` for saskartarad, with tests and a
  patch, in `docs/migration/saskartarad-editor-gate/`.

### Changed
- Material output names are spelling-insensitive in `material_connect_nodes`
  / `material_disconnect`: `base_color`, `BaseColor`, `MP_BaseColor`, `emissive`,
  `emissive_color` and `EmissiveColor` all resolve. `material_set_property`
  accepts short enum forms (`UI`, `Translucent`, `DefaultLit`) as well as
  `MD_UI` and `EMaterialDomain::MD_UI`.
- Blueprint mutations and `blueprint_compile` are refused while a PIE session
  runs, because reinstancing live PIE objects was a recurring crash.
  `actor_transform` is now plan-gated, matching its NON_IDEMPOTENT
  classification.
- Plan-Mode approval is per owner: only the agent that proposed a plan can
  spend its Approve.

### Fixed
- UI slot values that do not parse are now reported, not defaulted. An
  unrecognised alignment used to become Fill and an unparsed padding zero, both
  reported as applied. Alignment now also takes `HAlign_*` / `VAlign_*` and qualified
  forms; padding takes a number, `[h, v]`, `[l, t, r, b]`, `{left|Left, ...}` or
  `(Left=..,Top=..,Right=..,Bottom=..)`; box slots take `size` (auto / fill / weight).
  Anything else lands in `unknown_slot_props`, which `ui_add_element` now reports too.
- `blueprint_add_node` adds `input_key` (key event: Pressed / Released / Key pins;
  one per key per graph), and `blueprint_set_pin_default` sets Text pins (SetText
  InText) through `DefaultTextValue`, so text literals verify instead of failing.
- `seq_inspect`, `seq_list_bindings` and `seq_camera_cut` pass the python_run
  policy again (no `try`/`with`; HCR-TIME-001 refused every sequencer tool) and use
  the UE 5.8 scripting names (`get_tracks`/`find_tracks_by_type`; `get_master_tracks`
  is gone). `seq_camera_cut` reuses an existing camera binding, sets the section range
  in seconds, and takes `can_blend` (track bCanBlend) and `ease_in_seconds` /
  `ease_out_seconds` (section manual easing). Those are bare UPROPERTYs Python cannot
  reach, so a new optional `finish` step on python tools sets them through
  `object_set_property` and then saves. `seq_inspect` lists root tracks with camera
  cuts; `seq_list_bindings` reports possessable vs spawnable and per-binding tracks.
- `material_compile` no longer reports success while the platform shader compile
  fails afterwards. It now waits up to 30 s for the material shader map on the
  editor shader platform and returns `FMaterialResource::GetCompileErrors`; any error
  or a timeout gives `ok:false` and nothing is saved (`shader_compile_timed_out`,
  `shader_platform`). `material_validate {compile:true}` runs the same compile and
  wait without saving. Before this, M_UI_SandText compiled "clean", failed
  on PCD3D_SM6, fell back to the default material and its menu text did not render.
- Material graph preflight (validate and compile) lints Custom node HLSL: an
  apostrophe outside a comment, unclosed strings, comments or brackets, and stray
  closers are refused before any compile.
- Material Collection Parameter nodes made or edited with `material_add_node` /
  `material_set_node` now resolve their `ParameterId` from the collection (the
  editor does it in PostEditChangeProperty, which staged edits skip), so they
  compile instead of failing with "invalid parameter". A name the collection
  lacks is reported, and `material_get_info` adds `collection_parameter_resolved`.
- `python_run` scripts that load or unload World Partition actors no longer
  run inside the global editor transaction, which left `UTransBuffer` with a
  non-zero active count and crashed the next tick in Landscape.
- `python_run` is no longer re-sent after a transport timeout.
- `editor_batch` is never re-sent after a transport failure either.
- `material_get_info` now reports each graph parameter's authored name, exact
  parameter type, and typed default value, with explicit availability flags
  for invalid/non-finite metadata instead of plausible omissions. Master
  materials also expose every terminal material-property connection, including
  its exact source node and output index/name. Mask-derived `R/G/B/A` pin names
  round-trip through `material_connect_nodes`; truly unnamed pins are explicit
  nulls with display-only labels and require an output index. In Use Material Attributes mode,
  retained legacy property wires are explicitly marked compiler-inactive and
  no longer create false reachability.
- UI validation no longer mistakes ScrollBox content outside the viewport for
  off-screen or parent-overflow defects. Native layout snapshots now expose the
  ScrollBox axis so cross-axis failures remain visible, and empty text is
  ignored only when its effective visibility is `Collapsed` (not `Hidden`).
- `asset_registry_query` now uses a native, read-only AssetRegistry handler instead of blocked dynamic Python reflection, with deterministic bounded pagination, strict input checks, and fail-closed response validation.

### Added
- `editor_pie_click_actor` performs exact OS-input-free world interaction
  against a live visible PIE viewport without moving the desktop cursor or
  foregrounding its window. It reuses player-controller projection, rejects
  Slate/UMG and Canvas HUD blockers, verifies the first Visibility hit, and
  dispatches the exact native primitive click stage used by `APlayerController`
  after repeating every guard across re-entrant boundaries. It intentionally
  avoids `InputKey`'s unchecked trace window. Hover is explicitly unsupported:
  UE exposes no public route that both updates its protected native hover state
  and guarantees zero OS cursor movement. Ambiguous clients, absent/hidden/minimized
  viewports, hidden/offscreen/occluded targets, active gestures, ignored input,
  and disabled controller event paths fail closed.
- Read-only headless PIE scene grounding with `editor_pie_actor_list`,
  `editor_pie_actor_inspect`, and `editor_pie_project_world`: deterministic
  multi-client world selection, capped pagination, exact world-owned actor and
  component resolution, live SViewport-to-desktop projection, and a
  Visibility-channel hit result that identifies what is actually under the
  projected point.
- Production audio authoring and verification: typed create/inspect/set/save
  support for SoundClass, SoundMix class overrides, SoundConcurrency,
  SoundAttenuation, SoundSubmix, and SoundWave import/playback settings;
  retained 2D AudioComponent control; active sound/physical voice inspection;
  Audio Mixer spectrum metering; and synchronous, filesystem-verified submix
  WAV capture. Asset edits have an explicit save boundary and every runtime
  lifecycle command fails cleanly when its target/device state is unavailable.
- `editor_save_all_and_quit` — saves every dirty package, refuses to quit while
  anything is still unsaved (a dirty asset otherwise parks the editor on a
  modal save prompt with the MCP port already closed), then issues
  `QUIT_EDITOR`.
- Parameter-name aliasing (`src/tools/param-aliases.ts`, `resolveAliases`) — a
  single normalisation step, routed through by every dispatch path (`ueTool`,
  the python-tool factory, `hayba_invoke`, the two hand-registered
  meta-tools), that folds a historical/expected param spelling (e.g.
  `widget_blueprint_path`) onto its canonical name before the tool's own Zod
  schema sees it. Conflicting values under two spellings fail loudly instead
  of silently picking one.
- `hayba-cli` — a headless runner (`mcp-tools/hayba-mcp/src/cli`) for CI. Reads
  a JSON/YAML spec of wire commands, sends them over the same TCP seam every
  MCP tool uses, and exits with a code a pipeline can branch on (0 ok, 1 bad
  spec, 2 UE unreachable, 3 a step failed, 4 unexpected CLI error — see
  `src/cli/exit-codes.ts`). Does not launch UE; assumes an editor is already
  running and holding the port. An example (untested, not wired into this
  repo's own CI) workflow lives at
  `mcp-tools/hayba-mcp/examples/github-actions-hayba-cli.yml`.

### Changed
- Removed the optional local `@huggingface/transformers` embedding backend and
  its vulnerable Sharp/ONNX/AdmZip production graph. Tool and asset search now
  select Ollama when a bounded local probe succeeds and otherwise use the
  deterministic lexical index; clean-install CI exercises the offline,
  cold-cache fallback and the production audit needs no exceptions for
  `GHSA-f88m-g3jw-g9cj` or `GHSA-xcpc-8h2w-3j85`.
- The architecture workspace now declares its actual Three.js boundary: the
  browser-only Culture Studio keeps one pinned CDN import map, while the unused
  `three` and `@types/three` npm dependencies are removed. A source/manifest/
  lockfile guard prevents the inert duplicate from returning or the two CDN
  addon URLs from drifting to different runtime versions.
- **Satellite plugins settled** ([ADR-0008](docs/adr/0008-satellite-plugins-earn-their-place.md)).
  `HaybaMCPGAS` and `HaybaMCPMetaSound` are installed and surfaced.
  `HaybaMCPNiagara` and `HaybaMCPSequencer` are deleted — every command they
  added duplicated a TS/python tool (`niagara_*`, `seq_*`) already shipping
  under a different name, chosen deliberately not to collide with the dormant
  C++ ones.
- The C++ response limiter caps every string field in every reply at 512
  characters — right for a property dump, fatal for a base64 image (the clip
  produces a non-empty string that fails base64 validation, and the MCP SDK
  drops the whole content block). `image_base64` is now in
  `FHaybaMCPResponseBuilder::NeverTrimFields`, exempting it by field name (not
  by command), so any command that returns an image is covered, including
  ones not written yet. This was the root cause under #334.

### Fixed
- Long native commands no longer lose their TCP response at the five-second
  next-frame read deadline. The server now tracks accepted requests through
  response send completion, suspends only the empty next-frame idle timeout
  while work is outstanding, and still disconnects idle clients and partial-
  frame slowloris senders on a bounded deadline.
- Anthropic SDK 0.115 compatibility keeps context-window exhaustion,
  refusals, token limits, pauses, and unknown future stop reasons distinct
  instead of reporting them as a successful `end_turn`. Unsupported
  mid-turn tool-catalog changes and malformed streamed tool JSON now fail
  closed with bounded diagnostics; the unused second SDK dependency in the
  architecture package was removed.
- Large Widget Blueprints no longer lose controls after the native 50-item
  response limit. `ui_layout_snapshot` now supports exact-name reads and
  truthful pagination; `ui_copy_style` targets source/destination names
  directly, and `ui_validate` reconstructs every page or fails closed instead
  of silently judging an incomplete HUD.
- `test_run` now accepts the same case-insensitive filter/category selectors as
  `test_list`, rejects empty, ambiguous, and zero-match requests instead of
  returning false-green empty results, and reports explicit pass/fail/skip
  counts through `build_status`. Test status is structured rather than clipped
  by the generic 512-character string limit; malformed results and unknown job
  ids fail at the handler boundary.
- Native handler SEH containment no longer resumes the normal transaction,
  hashing, UI, and response-building tail after a structured exception. The
  params hash is captured before dispatch and a fault returns immediately with
  the editor session marked suspect, preventing the observed recovery-path
  double fault.
- UE 5.8 clean builds no longer fail to link the foliage add/paint tools.
  `AInstancedFoliageActor::AddInstances` is declared on a `MinimalAPI` class
  but not exported; Hayba now performs the same append through exported
  `AInstancedFoliageActor` / `FFoliageInfo` APIs and preserves count readback.
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

**This section describes the state of the repo at the time it was written,
not today.** It predates the satellite-plugin decision, the typed-domain-seam
work, and most of what is listed under [Unreleased](#unreleased) above — do
not read "34-domain" or "16 stubs" below as current counts; see
`docs/ARCHITECTURE.md` / `CONTEXT.md` for what is true now. Pre-roadmap
commits are summarized in the [open feat/mcp-stabilization PR](https://github.com/zajalist/hayba/pull/2). Major themes, as they stood then:

- 34-domain UE plugin (Actor / Level / Scene / Asset / Blueprint / Material / Foliage / Spline / WP / ISM / Physics / Python / Editor / Docs + 16 stubs).
- Code Mode meta-tool architecture.
- PCGEx catalog scraper — 344 nodes / 356 pins / 2270 properties.
- 5-archetype swarm + SQLite memory.
- Onboarding wizard + Plan Mode + 7d/50-call auto-prompt.
- Visual sidecar (CLIP / SpatialCLIP / OWL-ViT) addon package.

[Unreleased]: https://github.com/zajalist/hayba/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/zajalist/hayba/releases/tag/v0.1.0
