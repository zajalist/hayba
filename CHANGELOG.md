# Changelog

All notable changes to Hayba MCP Toolkit are documented here. Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### UE 5.9 editor workspace update

- Local HTML chat with searchable conversation history, bounded visible message
  pages, context references, model/effort menus and browsable agent-delegated work.
  Manual subagent creation and the obsolete semantic World tab are removed.
- Incremental transcript updates retain older messages while avoiding repeated
  full-history transfers during streaming. Older native/document pairs continue
  to use full snapshots; interrupted revision sequences request a fresh snapshot.
- Editor status shows the local listener, native fault guard, project/build and
  credential setup state. Diagnostics preserve the draft and distinguish local
  listener state from remote chat/provider availability.
- Media connections for Meshy, Tripo, Aholo, fal.ai and World Labs, with native
  credential storage and explicit generation/download/import boundaries.
- Portable Windows project installer with bundled Node/MCP runtime, exact engine
  build checks, optional Claude configuration, backups and rollback.
- `chooser_inspect` reads bounded pages of UE 5.9 Chooser tables through the
  optional Chooser editor API, including columns, bindings and cell/result values.
  A named native read route works under Plan Mode without allowing caller Python.
  Text-heavy pages exceeding 48 KiB return an explicit smaller-page error.
- Fab catalog/library search uses UE 5.9's real optional Fab API and bounded,
  caller-owned query jobs. Chat can open the native Fab browser and attach imported
  selections; purchasing and Add to Project remain explicit actions in Fab.
- `asset_validate` refuses oversized folders before validation and distinguishes
  passed, failed, partial, unsupported/skipped and cancelled validation.
- PCG read tools request read leases; Python guards distinguish builtin
  `compile`/`eval` calls from similarly named editor methods.
- Chat health uses the real native ping command. Ping reports the answering PID,
  project and engine build; connection diagnostics no longer recommend terminating
  a process based solely on its presence.
- Production dependency lockfile updates remove the audited production findings.
  Tests exclude stale compiled backups, handle Windows catalog line endings, and
  load SDK fixtures separately from request deadlines.

Ports the production tool-gap fixes that were running on a separate
integration branch onto the 0.4.1 code.

### Added
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
- Blueprint: `blueprint_add_function` takes `thread_safe` and by-reference /
  const inputs (anim node function signatures); `blueprint_add_event`
  implements parent functions that return a value as override graphs
  (`UUserWidget::OnKeyDown` and friends); `blueprint_add_node` adds
  `input_key`; `blueprint_set_pin_default` sets Text pins.
- Animation: `anim_blueprint_add_node_function`, `anim_graph_node_bind_function`
  and `blendspace_set_samples`; `blueprint_inspect_graph` and
  `blueprint_measure_nodes` page their nodes and edges under the 50-item cap.
- The `ui_*` convenience tools are native commands as well, so callers on the
  TCP path reach them; `ui_set_text_style` outline and shadow now apply.
- `editor_set_background_audio`, `editor_set_render_while_hidden` (full-rate
  PIE on a minimized editor) and `editor_get_keyboard_focus`.
- `audio_recording_start` / `_stop` and `audio_active_sounds` take
  `world: auto|pie|editor` and read the PIE world's own audio device.
- `asset_save` takes `force: true` and reports `skipped_not_dirty`.
- `HAYBA_MCP_PORT` pins the editor's TCP port.

### Changed
- Mutating commands refuse parameters they do not take ([HCR-PARAM-001])
  instead of ignoring them (first set: `editor_start_pie`, `editor_stop_pie`,
  `blueprint_create`, `blueprint_add_component` / `_variable` / `_function`,
  `asset_save`; the router-level `transaction` option is always accepted).
- `editor_start_pie` is refused while another owner holds an exclusive global
  lease, even under Advisory enforcement.
- `python_exec_file` is scoped by its declared `resources` for leases
  (WriteScoped when declared, Global when not).
- Every viewport command resolves its viewport in one place: the PIE
  player's view while PIE runs, else the level viewport last used; level
  camera changes are refused during PIE.
- Injected PIE input uses only the caller's `modifiers` and targets the PIE
  game viewport by default.

### Fixed
- `blueprint_add_function`, `blueprint_add_variable` and
  `blueprint_add_component` refuse a member name the Blueprint or a parent
  already uses ([HCR-BP-NAME-001]) instead of leaving the class uncompilable.
  `python_run` / `python_exec_file` scripts that start PIE are refused while a
  loaded Blueprint would open UE's compile prompt ([HCR-PIE-001]), using the
  same rule as `editor_start_pie`'s preflight.
- `blueprint_add_component` attaches scene components under a parent instead
  of adding root nodes.
- `blueprint_add_node` gives nodes their pins before `PostPlacedNewNode`
  (`spawn_actor_from_class` asserted) and takes `class_path` for it.
- Materials: spelling-insensitive output names and short enum names; Material
  Collection Parameter ids resolve on staged edits; staged edits rebuild
  Custom node outputs; `material_compile` submits and waits for the platform
  shader compile and reports its errors; Custom HLSL is linted before compile.
- `editor_capture_viewport` captures the PIE or level view and refuses an
  all-black frame.
- Asset tools never open a dialog (`asset_fix_redirectors` no longer parks the
  game thread on the Redirector Update Report).
- UI slot values that do not parse are reported instead of silently
  defaulted.
- Every python_run-backed tool template (asset, editor, foliage, landscape,
  lighting, mesh, niagara, sequencer, water, actor, pcg, introspect) runs
  without `try`/`with` and `getattr`, which the native policy refuses; the
  sequencer tools use the UE 5.8+ scripting names.
- [HCR-CONSOLE-001] catches `execute_console_command` called as a method or
  through an alias.

## [0.4.1] — 2026-11-12

First full release of the 0.4 line (0.4.0 shipped only as release
candidates). Highlights: Unreal Engine 5.9 support, the new in-editor
workspace (Chat, World and the six-tab layout), multi-agent editor leases,
and the P0 editor safety train.

### Added
- Unreal Engine 5.9 support, and 5.9 is the tested engine for this release
  (5.7 and 5.8 were not retested). The plugin descriptors carry no engine
  pin, so Unreal does not ask about a version mismatch. The capture component
  stays visible because 5.9's `CaptureScene` refuses a hidden one.
- `python_exec_file {path, env?, resources?}` runs a trusted `.py` file from
  inside the project, outside `python_run`'s sandbox, as one SEH-guarded
  request with a private namespace. Off by default (Project Settings >
  Plugins > Hayba MCP Toolkit > Allow Project Python Files); plan-gated, never wrapped in an
  editor transaction, and refused for scripts that wait on every compile in
  the world (screenshots, `finish_all_compilation`).
- `lease_acquire` takes `confirm_within_s`: a grant lapses that quickly unless
  its owner renews it once, so a grant to a client that already went away no
  longer blocks every other waiter for minutes.
- The PythonScriptPlugin closure-type hotfix (a CPython GC crash) is applied
  once per editor session, as soon as Python starts.
- P0 editor safety: sticky unsafe state after a contained native fault, guarded
  saves, Play and dirty-Blueprint preflights, asset-busy protection, and
  owner-bound multi-agent leases with canonical `lease_id` handles.
- `lease_adopt {owner, lease_id}` lets a persistent connection use the owner
  of a live matching lease until that connection closes. It revives that
  owner's orphaned connection-bound leases without moving live bindings or
  extending unbound leases. A granted `lease_acquire` with an explicit owner
  also adopts its connection.
- The Play button is vetoed while an agent holds an asset build lease (P0).
  `hayba.PIEBuildVeto` (console): `1` (default) stops Play and a second
  press within 10 s plays anyway, `2` stops it with no override, `0` only
  shows a notification. The veto after a contained native fault is separate
  and always on.
- Sticky `editor_unsafe` (ADR-0011). After Hayba contains a native fault, the
  editor refuses writes, Python, saves, compiles, PIE and batches with
  `code: "editor_unsafe_restart_required"` until it restarts; status commands
  (and, unless the fault stranded a save, a fixed set of reads) still answer.
  The command that faulted answers `native_fault_contained`. The person at the
  editor sees one persistent notification. `ping` and `editor_get_state` report
  `editor_unsafe`, `python_unhealthy` and `health`; `ping` advertises
  `capabilities.editor_health`.
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
- Multi-agent editor leases (ADR-0010). `lease_acquire` / `lease_renew` /
  `lease_release` / `lease_status` claim `global`, `world:`, `wp-region:`,
  `asset:`, `actor:` or `pie` resources. Acquire never blocks: it answers
  granted or queued with position, holder and ETA. The envelope gains optional
  `owner` and `lease` fields; the Node client sends `HAYBA_AGENT_ID` (or a
  per-process id) and renews granted leases in the background. The
  `LeaseEnforcement` setting supports `Advisory` (commands run and carry a
  `lease_warning`) and `Enforced` (conflicts can be refused with
  `code: "lease_conflict"`); the shipped default is described under Changed.
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
- `asset_busy` (P0). While any owner holds an `asset:<path>` exclusive lease
  (a build), `editor_start_pie` and `editor_save_all_and_quit` are refused with
  `code: "asset_busy"` and a `busy` detail naming the asset, owner, label and
  age; the caller's own build counts. Compiling or saving that asset
  (`blueprint_compile`, `ui_compile_widget`, `ui_save_widget`,
  `material_compile`, `bt_compile`, `anim_blueprint_compile`,
  `audio_asset_save`) is refused for other owners under `Enforced` and runs
  with a `state_warning` under `Advisory`. `editor_get_state.building` lists
  every asset build. Blueprint and widget authoring commands lock the asset
  they name.
- `ping` reports `capabilities.lease_id`.
- A scene-derived World preview sampled from loaded static-mesh surfaces,
  linked to authored level/folder/actor/component/instance records and derived
  spatial clusters. `world_semantic_snapshot` exposes bounded pages of the
  same evidence to agents.
- Read-only World budget snapshots, PIE timing and memory proxies, collision
  sightline probes, and evidence-scoped snapshot comparison.
- A focused six-tab editor workspace with hand-authored navigation icons and
  stronger Chat drafting, activity, and review flows.

### Changed
- Callers resolve owner first (ADR-0010): envelope `owner`, then an
  adopted connection owner, then `conn:<id>` or in-process `local`. The
  envelope `lease` never acts as its owner. A foreign synthetic-owner claim
  is refused with `owner_reserved`; naming another owner's lease adds
  `lease_binding` to a conflict or warning. Batch steps retain the accepted
  batch owner, and `lease_status` includes `connection_owner`.
- Lease enforcement defaults to `EnforcedForWrites` (ADR-0010), shipped
  together with `lease_id`: a conflicting write is refused with
  `lease_conflict`, and a write that names no owner while other agents are
  connected with `owner_required`. Write detection fails closed (only the read
  sets are Read), undeclared `python_run` conflicts as X on `global` (declare
  `resources` or `read_only: true`), PIE observation commands are Read, and
  lease warnings are rate-limited. `ping` reports
  `capabilities.lease_enforcement` and `owner_required`; `lease_status`
  reports `active_owners`. Rollback: Project Settings > Hayba MCP Toolkit >
  Lease Enforcement = Advisory, live.
- Plan-Mode approval is per owner and per exact call: a destructive command
  needs a single-use native approval of that command, target and lease, which
  only the proposing owner can spend. A prose plan cannot spend it.
- Lease handles are `lease_id` (`ls_<seq>_<mac12>`) on every lease reply and
  in `lease_status`, and `editor_batch` takes `lease_id` (`lease` still works).
  `token` is never emitted; it is accepted as a deprecated input on
  `lease_renew` / `lease_release`, and the reply says so in `deprecation`. The
  Node server seeds its envelope lease only from `HAYBA_LEASE_ID`, ignores
  `HAYBA_LEASE` and `HAYBA_LEASE_TOKEN`, and drops an env lease the editor no
  longer knows.
- The World view uses a full-width 3D canvas with an on-demand hierarchy
  explorer in place of the old force graph and fixed inspector.
- Blueprint mutations and `blueprint_compile` are refused while a PIE session
  runs, because reinstancing live PIE objects was a recurring crash.
  `actor_transform` is now plan-gated, matching its NON_IDEMPOTENT
  classification.

### Fixed
- `asset_delete` is a heavy operation (300 s timeout, no automatic retry), so
  deleting a large Blueprint no longer times out while the editor is still
  working, and paths broken across lines by a client are joined before use.
- After a contained native fault, abandoned progress dialogs, slow-task
  entries and a stranded "saving package" flag are cleaned up, so the editor
  survives long enough to save and restart.
- A command is never run inside another one: nested dispatch is refused, and
  queued TCP commands wait while a command, slow task or modal dialog is
  active.
- `material_set_property` recompiles when it changes settings that decide
  shaders, and material graph edits and compiles are refused while Play In
  Editor runs.
- Blueprint node measurement and `blueprint_move_nodes` round to 32-bit
  integers explicitly.
- Read-only or racing package saves return an error instead of opening a
  blocking dialog or continuing unsafely. Plugin Python runs unattended.
- Large and paged editor responses preserve exact source paths and report
  partial coverage instead of silently clipping agent evidence.
- `python_run` scripts that load or unload World Partition actors no longer
  run inside the global editor transaction, which left `UTransBuffer` with a
  non-zero active count and crashed the next tick in Landscape.
- `python_run` is no longer re-sent after a transport timeout.
- `editor_batch` is never re-sent after a transport failure either.
- Lease handles no longer reach clients as `[REDACTED:token]`: the handle's
  key is no longer secret-shaped, so renew, release and `editor_batch` work.

### Removed
- The four Fab tools (`hayba_fab_login_status`, `hayba_fab_library_list`,
  `hayba_fab_marketplace_search`, `hayba_fab_download`). They sent
  `fab_*` commands that no editor handler ever implemented, so every call
  failed with "Unknown command". They never worked; the "FAB connector"
  entry in `mcp-tools/hayba-mcp/CHANGELOG.md` describing them was wrong. Fab
  content can still be added through the
  Epic Games Launcher or the in-editor Fab plugin and then found with
  `hayba_asset_search` / `hayba_asset_browse`.

## [0.3.0] — 2026-09-30

### Added
- **Hayba Pro client.** The chat panel signs in to Hayba Pro (device-code
  sign-in; the refresh token is stored with DPAPI) and relays a chat through the
  hosted service, which asks the local sidecar to run editor tools. Every inbound
  tool call passes a local guard first (manifest check, approvals bound to their
  loop, redacted and size-capped results, screenshots and other binary payloads
  stripped before they leave the machine). Sessions resume after dropped
  connections, and when Pro is unavailable a chat falls back to Community
  (local/BYOK). Bring-your-own-key Pro turns accept hosted providers only.
- `@hayba/brain-protocol`: versioned, strict Zod schemas for the Pro wire frames
  and the shared activity-event vocabulary, with valid/invalid fixtures.
- **Branded editor workspace.** The agent dock embeds agent activity, work modes
  and specialist profiles, persists redacted sessions, shows the Agent World
  Library, and inspects the loaded world.
- **World workflows.** `world_inspect`, `world_ingest` and `asset_prepare` report
  ordered stages, dry-run plans, retained resources and explicit unsupported
  capabilities. The native success path imports a heightmap into an existing
  writable non-partitioned world; asset preparation edits existing LOD reductions.
- Blueprint event authoring: bound UMG click events, custom and override events,
  function signatures, typed variables and function libraries.
- PIE grounding and interaction: `editor_pie_actor_list`,
  `editor_pie_actor_inspect`, `editor_pie_project_world`, and
  `editor_pie_click_actor` (exact world clicks without moving the OS cursor).
- Production audio authoring and verification (SoundClass/Mix/Concurrency/
  Attenuation/Submix/Wave, spectrum metering, verified submix WAV capture) and
  MetaSound graph authoring.
- `editor_save_all_and_quit`, `memory_*` tools, parameter-name aliasing, a
  bounded Unreal header index, and many previously unreachable commands
  (physics, world partition, behavior trees, animation, Enhanced Input,
  networking, project, audio).
- `hayba-cli`, a headless runner that sends a JSON/YAML spec of wire commands to
  a running editor and exits with a pipeline-friendly code.

### Changed
- **UE 5.7+ support.** The plugins no longer pin `EngineVersion`, so they load on
  UE 5.7 and 5.8; install docs cover 5.7+ and symlink installs.
- `hayba_import_landscape` and `import_landscape` are deprecated and remain for
  one release as adapters to `world_ingest`, returning `deprecation` metadata.
- `/chat` and `/brain` sidecar routes refuse non-loopback `Host`/`Origin`
  (DNS-rebinding protection).
- The visual-embeddings sidecar defaults to port 7822 (the chat sidecar keeps
  7821); set `HAYBA_SIDECAR_PORT` to override. The two visual sidecar apps were
  merged into one ([ADR-0006](docs/adr/0006-one-visual-sidecar.md)).
- Satellite plugins settled ([ADR-0008](docs/adr/0008-satellite-plugins-earn-their-place.md)):
  `HaybaMCPGAS` and `HaybaMCPMetaSound` ship.
- Tool registration uses one descriptor catalogue; `ueTool` replaces dozens of
  pass-through wrappers, and static checks know every call form
  ([ADR-0007](docs/adr/0007-static-checks-must-know-every-call-form.md)).
- Security hardening: secret redaction at Node response boundaries, an
  idempotency ledger, safer archive ingestion, bounded embedded Python policy,
  rate-limited dashboard storage, and production dependency gating.
- The website now focuses on the Unreal toolkit.

### Fixed
- Website: docs layout, copyable command blocks, 320px reflow, contrast and
  accessibility, mobile header menu, self-hosted fonts, and corrected product
  facts.
- Long native commands keep their TCP response past the next-frame read
  deadline; the receive buffer is cleared on socket close; TCP teardown and
  backpressure are exact.
- Crash containment: a caught structured exception no longer resumes the normal
  handler tail or skips the engine's world restore.
- Base64 images are never trimmed by the response limiter (root cause of #334).
- Truthful results: material parameter metadata, test counts and selectors,
  mutation outcomes, large Widget Blueprint audits (paginated), ScrollBox-aware
  UI validation, `render_camera`, `data_create` save status.
- UE 5.8: foliage add/paint links, MetaSound builder registry, enum boundaries.
- Anthropic SDK 0.115 stop reasons are kept distinct instead of reported as
  `end_turn`.
- Tests no longer depend on a developer-machine path or a cold model download.
- Plan Mode messages point at the Settings toggle.

### Removed
- Private working docs (personal dashboard, task backlog, local handoffs and
  internal research) are no longer tracked in the public repo, and a consumer
  project's name was removed from public docs.
- `HaybaMCPNiagara` and `HaybaMCPSequencer` satellite plugins (their commands
  duplicated shipping `niagara_*` / `seq_*` tools).
- The unused single-request chat client and the optional local
  `@huggingface/transformers` embedding backend (with its vulnerable
  dependency graph).
- Stale website pages and orphaned showcase assets, untracked residue
  directories, and the unused Three.js npm install.

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

[Unreleased]: https://github.com/zajalist/hayba/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/zajalist/hayba/compare/v0.1.0...v0.3.0
[0.1.0]: https://github.com/zajalist/hayba/releases/tag/v0.1.0
