# Phase 2 Wave 2 — Editor-Introspection, Asset & Mesh P0s + Backlog

Continues the tool blitz on `feat/mcp-phase0-1-foundation`. Same Global
Constraints as Wave 1 (`docs/plans/2026-07-04-phase2-wave1-legacy-surfacing.md`):
net-new only (check overlap vs existing tools + the 55 surfaced legacy commands
in `src/legacy-commands/sidecar.json`), pyTemplate factory + `toToolDescriptor`
into the descriptor list, defensive python (`_emit`/`_err`, `pyStr`),
inspection-first returns, NON_IDEMPOTENT classification for mutating tools,
gates = tsc clean + vitest green + lint:legacy-wrappers green, no
Co-Authored-By trailer, no branch switching.

The authoritative tool designs live in
`docs/plans/2026-06-28-mcp-supertooling-tools.json` — extract the relevant
domain's P0/P1 entries with node before designing (don't guess names).

## Task 1 — Editor-introspection & observability P0s  [TS]

**Files:** new `src/tools/editor/editor-py-tools.ts` (+ test); `index.ts` splice.

From the catalog's `editor-introspection-and-observability` domain (P0s first),
ship the python-feasible net-new subset, ~10-14 tools. Strong candidates
(verify against catalog + overlap): viewport camera get/set
(`editor_get_camera`/`editor_set_camera` — check sidecar first),
`editor_cvar_get`/`editor_cvar_set` (console variables; set is mutating),
`editor_undo`/`editor_redo` (execute one editor transaction step; mutating),
`outliner_tree` (world outliner folders + actor tree, paginated),
`editor_get_state` (current map, PIE state, selection count, dirty packages),
`content_browser_sync` (focus content browser on an asset),
`editor_bookmark_set`/`editor_bookmark_jump` (viewport bookmarks),
`object_exists` / class-count queries. Python via
`unreal.get_editor_subsystem(...)` (LevelEditorSubsystem,
UnrealEditorSubsystem, EditorActorSubsystem), `unreal.SystemLibrary`, console
via `unreal.SystemLibrary.execute_console_command` ONLY for cvars (note
`editor_run_console_command` is already surfaced — cvar tools must be typed
get/set, not a duplicate freeform runner).

## Task 2 — Asset & mesh P0s  [TS]

**Files:** new `src/tools/asset/asset-py-tools.ts` + `src/tools/mesh/mesh-py-tools.ts`
(+ tests); `index.ts` splices.

From the catalog's `asset-import-and-sources` + `mesh-and-geometryscript`
domains (P0s), python-feasible net-new subset, ~10-14 tools total. Strong
candidates (verify): `asset_find` (asset-registry query: class/path-prefix/name
substring, paginated {assets[], total, has_more}), `asset_duplicate`,
`asset_create_folder`, `asset_save_all` (mutating: save dirty packages),
`asset_open_editor` (open the asset's editor tab), `asset_get_source_path`
(reimport source); `mesh_get_sockets`, `mesh_get_lods` (LOD count + tri/vert
per LOD), `mesh_get_materials` (slot names + assigned materials),
`mesh_get_bounds`, `mesh_set_material_slot` (mutating). Use
`unreal.AssetRegistryHelpers.get_asset_registry()` (TopLevelAssetPath API —
the validated 5.7 idiom), `unreal.EditorAssetLibrary`. NOTE overlap:
`asset_get_info`, `asset_move`, `asset_fix_redirectors`,
`asset_get_dependencies/referencers`, `mesh_get_info`, `mesh_topology_stats`,
`mesh_extract`, `mesh_list_dynamic` already exist — skip or differentiate.

## Task 3 — Backlog burn-down  [C++ needs-rebuild + docs]

1. `editor_get_output_log` (legacy C++ handler): opens the live log without
   shared-read → fails while the editor holds it. Fix by reading the way the
   newer `editor_stream_log` handler does (its 16MB-tail + shared-read
   approach in `HaybaMCPEditorHandler.cpp` StreamLog) or by resolving the
   actual log path via `FPlatformOutputDevices::GetAbsoluteLogFilename()` and
   opening with shared-read. Locate the legacy handler via
   `handler_cpp` in sidecar.json. Commit tagged [needs-rebuild].
2. Add the rotator-convention doc note in `actor-py-tools.ts` (this file uses
   [roll,pitch,yaw] per UE python's real signature; render-camera/sidecar use
   [pitch,yaw,roll] — one-line comment near PY_ACTOR_HELPERS warning against
   cross-copying).
3. Update `docs/plans/2026-06-28-mcp-supertooling-roadmap.md`: insert a short
   "Shipped so far" note at the top (Phase 0/1 complete + smoke-proven; Wave 1
   55+8 tools; Wave 2 count) so the roadmap reflects reality.
