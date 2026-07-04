# Hayba UE MCP — Competitive Analysis & Internal Audit (raw research)

> Generated 2026-06-28. Supporting research behind `2026-06-28-mcp-supertooling-roadmap.md`.

---

# Master Design Brief

# HAYBA UE MCP — MASTER DESIGN BRIEF
*Single source of truth for the tool blitz. 20 design agents build from this. Read your section, respect the moats, hit the counts.*

---

## 0. STRATEGIC POSTURE (read first)

The landscape changed twice in June 2026: **Epic shipped a first-party MCP in UE 5.8** (the free front door), and **Flopperam→Aura consolidated the commercial OSS lineage** ($40M, 30k devs, in-editor agent). We are now a *third-party server competing against a first-party baseline plus a funded incumbent*. We do not win on raw breadth alone (Aura-hosted ~64, GenOrca 253, UAIP ~730). We win on **production-grade safety + agent ergonomics + worldbuilding depth that the baseline explicitly will not build**, then close the breadth gap to "hundreds, honest."

**Three hard truths from the internal audit that gate everything:**
1. **The "126 tools" headline is partly false advertising.** ~70 first-class tools; `blueprint_add_node` returns `not_implemented_in_v1`; ~100 working C++ commands have *no first-class wrapper* (reachable only via `hayba_invoke ue_legacy` or `python_run`). The practical surface is "python_run + guessing."
2. **Two P0 editor-freeze bugs** (`build_*` 300s, `test_run` 120s/test block the game thread) and **narrow SEH coverage** (only python/material guarded) mean we are NOT production-ready for unattended use today.
3. **Adding one tool touches 4–7 files in 2 languages + a plugin rebuild**, with the same schema re-declared in 4 places that drift. **The blitz cannot start until the add-a-tool path is refactored** (Section 5 gate).

---

## 1. COMPETITIVE MATRIX

| Competitor | Tool count | Core strength | Their weakness | **Hayba's advantage to press** |
|---|---|---|---|---|
| **Epic UE 5.8 MCP** (first-party) | toolset-driven, minimal | Free, sanctioned, in-editor; Tool-Search meta-tools; auto client-config | Loopback no-auth; per-call undo; game-thread-serial; restart to add C++; no PIE/PCG depth; Tools-only | Transactional one-undo; auth/scope; PCG/PLUMB depth; **extend their Toolset Registry, don't fight it** |
| **Aura (Ramen)** | ~50–64 (Flop heritage) | Native in-editor agent, visual BP graph edit, self-correcting C++ live-compile, Verification/playtest agent, Sandbox Mode, Claude-Skills-compat | Closed-source, Windows-only, vendor lock-in, "barely alpha" bugs, cost-stacking, cloud for hosted tier | Fully-local TCP (NDA/air-gap), open extensibility, token economy, BYOK multi-provider |
| **Flopperam hosted "Flop"** | ~64 (46 free/18 PRO) | Broadest subsystem coverage; BP lifecycle w/ ~50 auto-repair rules; `pie_test_bp` 30+ assertions + pixel-diff; skills docs; `bp_dry_run` | Best tools paywalled; cloud dependency; OSS repo frozen | Local-first, free, PLUMB quantified validation > their auto-repair, no paywall |
| **GenOrca** | **253 / 21 domains** | Deepest community surface; BT/UMG/material-graph/ControlRig/retarget; vision label overlay; `execute_python` | Low stars/battle-testing; binaries version-locked; no auth | Crash-resilience, transactions, token economy, worldbuilding (PCG/PLUMB) they lack |
| **chongdashu** (reference) | ~20 | Genuine BP graph manip; 2k stars; starter project | No materials/UMG/seq/PCG/anim/GAS; single-conn; no auth | Everything beyond BP graph |
| **ChiR24** | 23 consolidated verbs | Widest UE range (5.0–5.8); token-efficient verbs; cap-token auth; graceful degradation; cache | Coarse tools push complexity to params (validation-light) | Fine-grained + validated + PLUMB constraints |
| **remiphilippe** (Go) | 49 | Full DevOps loop (headless build/cook/test, visual tests, CI); indexed doc search; PIE+player control | Very young (4 commits); 5.7-only; no auth | Authoring depth + safety; match their PIE/doc-search |
| **runreal** | 19 | Zero-plugin (Python Remote Exec); lowest friction | Thin; network-exposure risk; no native introspection | Native depth + security |
| **DCC peers (Blender/Houdini/Maya/Unity)** | 21–288 | Blender: asset libs + AI-3D-gen (generate→poll→import); Houdini: docs-as-a-tool + graph-intelligence validate; Unity: undo/redo + paginated hierarchy + batch wiring + tool-group disclosure; Maya: parametric prefab generators | n/a (cross-DCC) | **Steal**: AI-3D-gen async pattern, docs-as-a-tool, vision feedback, batch ops; we already have asset connectors + PLUMB validate + python hatch |

**Headline differentiator we own and no one else has all of:** local + crash-resilient + transactional + token-economized + quantified-constraint-validated + worldbuilding-native, with BYOK.

---

## 2. DEFENSIBLE MOATS — lean in, do not dilute

Every design agent must reinforce at least one moat. These are the reasons to choose Hayba over Epic's free baseline.

1. **Crash-resilience & lifecycle hardening.** `HaybaGameThread::RunSync*` seam, ticker-based TCP dispatch (avoids task-graph re-entrancy), SEH guard, dangling-delegate gating (#283/#284), 1MB frame cap. *Gap to close: SEH currently wraps only python/material — extend to `ProcessCommand` so all 33 handlers are recoverable.* This is the single biggest reliability lever; competitors document none of it.

2. **PLUMB quantified validation + constraint language.** 23 tools: profile bake/annotate, constraint define/propose/validate, masks, lessons, study, grammar-expand, productions, sockets, SAM segment. This is **closed-loop "validate before/after mutate" with a real constraint grammar** — beyond Flop's auto-repair rules and Houdini's graph-intelligence. It is our worldbuilding correctness engine. Lean into: green/red plan-mode overlay, unsat-core surfacing, lessons-as-memory.

3. **Token economy / Code-Mode / deferred routing.** Code Mode exposes 5 meta-tools, discovers the rest on demand (~3K tokens vs hundreds of schemas, ~95% cut). Deferred routing: BM25+embedding tool index, packs, `hayba_invoke` polymorphic dispatch. Epic baked a *lighter* version (Tool-Search). **This is what lets us ship "hundreds of tools" without drowning the context window** — the prerequisite for the breadth strategy. Speak Epic's meta-verbs (`list_toolsets`/`describe_toolset`/`call_tool`) for interop.

4. **`python_run` universal escape hatch (hardened).** SEH + 3-tier security gate + dangling-delegate gate. De-facto API surface. Keep it; *but the postmortem shows ~90% of real sessions hand-rolled python because typed primitives don't cover the author loop* — so the strategic move is to **convert python patterns into typed `pyTemplate` tools** (Section 5 #4), not to celebrate the hatch.

5. **Vision-capture feedback loop.** `editor_capture_viewport`, `render_camera`, PIE screenshot, SceneCapture world-pos pass, visual sidecar (CLIP score, moodboard, SAM segment). Strongest-in-class among UE MCPs. Return PNG as image content blocks. *Gap: multi-angle/orbit, thumbnails, buffer-viz passes, auto-frame, before/after diff.*

---

## 3. PRIORITIZED THEMES FOR THE BLITZ

Sequenced. **Themes 0 and 1 are gates — no net-new tool ships before they land.**

### THEME 0 — STOP LYING / STOP FREEZING (P0, blocks everything)
- Fix the two editor-freeze blockers: `build_*` (300s) and `test_run` (120s/test) via the job-envelope conversion already planned in `docs/audit/2026-06-22-mcp-async-command-conversions.md`.
- SEH-wrap `ProcessCommand` (one seam → whole 33-handler surface recoverable).
- Transport: re-discover port on reconnect, backoff reconnect, **align executor timeouts to UE ceilings** (2/10/60s vs UE 300/120/600s), gate the blind retry to idempotent commands only (else duplicate `actor_spawn`/`delete`), wire the dead `auth` field + `timeout` code.
- Fix `blueprint_add_node` stub OR remove it from the advertised catalog. No false advertising.
- Unify error envelope (render/build escape the one-failure-shape invariant); prune `packs.yaml` of unregistered tool refs; gitignore `hayba-memory.db`.

### THEME 1 — ADD-A-TOOL REFACTOR (P0 gate, Section 5)
Collapse 4 schema representations → 1 descriptor; auto-collect descriptors; generate the sidecar; add the `pyTemplate` factory. **This is the multiplier that makes "hundreds of tools" feasible without per-tool 7-file churn.**

### THEME 2 — SURFACE THE TIER-2 DEBT (cheap, highest ROI breadth)
~100 working C++ commands have no first-class tool. Thin TS wrappers + schema + sidecar entry (no rebuild) for: `level_* seq_* anim_* foliage_* spline_* physics_* input_* ui_* gas_* bt_* data_* project_* build_* test_* wp_*`. This alone roughly doubles the honest catalog.

### THEME 3 — QUICK PY WINS (no rebuild, high value)
Nanite (easiest win in the list), Lighting/Lumen (easy, high-value), Multi-select/batch + selection management, Foliage asset authoring, Asset-import/Interchange/USD, Sequencer + MoviePipeline render, Audio/SoundCue/Submix.

### THEME 4 — SAFETY & ERGONOMICS MUST-HAVES (the moats, productized)
Transactions/undo (cross-cutting), BYOK in-editor chat panel revival, vision-loop expansion, batch ops. (Section 4.)

### THEME 5 — HARD C++ HIGH-VALUE
Blueprint K2 graph authoring (the largest false-advertised capability), PhysicsAsset/Chaos, ControlRig, Landscape sculpt/weightmap-paint. Accept ceilings: Niagara and ControlRig authoring are genuine UE Python limits — scope to template-instantiation + param packs, flag as engine limitation.

### THEME 6 — DISTRIBUTION
Prebuilt binaries, widen `EngineVersion` beyond pinned 5.7.0, remove engine-private-header includes (or honestly document non-marketplace status), Fab metadata.

---

## 4. EXPLICIT MUST-HAVES (named in mandate — build these)

### 4A. Revive BYOK in-editor AI chat panel
**Architecture decision (locked):** put the agentic loop in the **Node MCP server**, keep C++ as a **thin streaming chat client**. Do NOT rebuild tool-calling in C++ (duplicates catalog/gating/validator/journal and risks game-thread deadlock).
- Restore `llm-client.ts` from commit `ac46d40` (only correct tool-calling shape in repo history: `LLMTool/LLMToolCall/LLMResponse`, `stopReason 'tool_use'|'end_turn'`); add `@anthropic-ai/sdk`/`openai` deps + streaming.
- Restore the **8-provider catalog** (`mock, anthropic, groq, openrouter, openai, ollama, lmstudio, custom`) from `2849a75` presets + `4d47e58` env/baseURL/model maps → single `providers.ts`.
- Sidecar `POST /chat/stream` (SSE) runs the loop over the live registry, honoring `DisabledTools` + archetype `tool_filter` + **Plan-Mode gate** (`bPlanApproved`) before destructive tools.
- C++: provider dropdown + **DPAPI-encrypted key storage** (stop plaintext `GEditorPerProjectIni`); switch `FHaybaMCPClaudeClient` to consume SSE + implement the promised `Cancel()`.
- Reuse what's already production-grade: Slate UI (`SHaybaMCPChatPanel`), `OnToolCallRecorded` observability seam, tool-stream/validator/diff panels. Wire Preview→Plan panel; add session persistence.

### 4B. Vision feedback loop (extend the strongest area)
Add: multi-angle **orbit/turntable** capture, per-asset **thumbnail** gen, **auto-frame/auto-focus** on actor bounds, **buffer-visualization passes** (depth/wireframe/normals/basecolor/overdraw), **before/after diff** capture, annotation/highlight overlays, viewport-bookmark capture. Return MIME-typed image content blocks. (MIX: orbit/thumbnail/auto-frame PY; buffer passes C++ — spike exists.)

### 4C. Transaction / undo safety (highest-leverage cross-cutting gap)
Wrap every mutating C++ handler in `FScopedTransaction`; expose begin/end-transaction, undo, redo, checkpoint/restore. **`run_tool_script`-style multi-step bundling into ONE Ctrl+Z** is a named differentiator vs Epic's per-call undo. Generalize the `dry_run→commit` pattern that today only `world_generate` has. (C++ for robustness — Python `ScopedEditorTransaction` won't capture C++ handler mutations.)

### 4D. Batch ops (cheap, high-value)
Selection management (get/set/select-by-query/class/tag/material), batch transform/property-set across selection, batch rename, batch material-assign, align/distribute/snap-many, group/attach, find-replace-actor-class. Match Roblox peer's `mass_set_property/mass_duplicate/search_by_property/bulk_set_attributes`. (PY: `EditorActorSubsystem` + loops.) Prefer few high-level "outcome" verbs over many low-level calls (DCC best practice).

---

## 5. ADD-A-TOOL REFACTOR (Theme 1 spec — the gate)

**Principle: a tool is *data*, declared once, with codegen + generic dispatch on both sides.** Today 104 `server.tool` calls vs 32 descriptors (~30% migrated); schema re-declared in wrapper Zod + descriptor Zod + sidecar params + C++ `TryGet*Field`.

1. **One descriptor as sole authoring surface.** Extend `ToolDescriptor`: `{name, domain, cost, meta, schema, returns, alwaysOn, destructive}` + exactly one of `ueCommand` (synthesize passthrough handler — kills wrapper files), `pyTemplate`, or `handler`. Derive pack from `domain` (delete `inferDir` table); derive always-on from `alwaysOn` flag (delete both `register.ts` lists).
2. **Auto-collect descriptors.** Each domain folder exports `descriptors[]`; generated barrel concatenates. Kills the 470-line literal + 140-line import block.
3. **Generate the sidecar** from descriptors at build (`deriveSignature` already does Zod→param docs); replace existence-only lint with "generated == committed."
4. **`pyTemplate` factory = the vehicle for hundreds.** Parameterized python snippet, validated params bound in, dispatched through the hardened `python_run` handler → schema-validated, discoverable, journaled tools with **zero plugin rebuilds**. Reserve C++ for hot-path/crash-prone ops.
5. **C++ declarative command table** (only if hot-path C++ proliferates): `TMap<FString,FCommandSpec>` with param types + `destructive` flag + lambda; add `mcp_describe_commands` so the sidecar is generatable from the running plugin (closes field-level drift) and kills the `IsDestructiveCommand` hardcoded-list bug class.

Sequence: (1)+(2)+(3) pure-TS, no rebuild → then (4) → (5) last.

---

## 6. TARGET TOOL COUNTS PER SUBSYSTEM

Goal: **"hundreds, honest, production-ready, ahead of competitors."** Current honest first-class ≈ 70. Target ≈ **240–290 first-class** (surpassing GenOrca's 253, with safety/validation depth none match). Net-new ≈ 140–190, roughly half thin wrappers over existing C++.

| Subsystem | Now (first-class) | Target | Net-new | Effort | Theme |
|---|---|---|---|---|---|
| Material (graph+instance) | 20 | 22 | +2 | done | — |
| PLUMB constraint | 23 | 26 | +3 | TS | moat |
| PCGEx / PCG | 17+5 | 26 | +4 | TS/PY | moat |
| Actor + **batch/selection** | 4 | 14 | +10 | PY | 3/4D |
| Texture | 4 | 6 | +2 | C++ | 2 |
| Asset import (Interchange/USD/Datasmith) | ~10 | 18 | +8 | PY | 3 |
| **Blueprint K2 graph** | 0 (stub) | 16 | +16 | **C++** | 5 |
| Sequencer + **MoviePipeline render** | 0 fc | 12 | +12 | PY | 3 |
| **Lighting/Lumen** | 0 | 9 | +9 | PY | 3 |
| **Nanite** | 0 | 3 | +3 | PY | 3 |
| Foliage | 0 fc | 6 | +6 | PY | 2/3 |
| Landscape (import+sculpt+paint) | 1 | 10 | +9 | C++/MIX | 5 |
| Physics/Chaos/PhysicsAsset | 0 fc | 11 | +11 | MIX/C++ | 5 |
| Animation (Montage/BlendSpace/Notify/retarget) | 0 fc | 12 | +12 | MIX | 5 |
| ControlRig | 0 | 4 (template-scoped) | +4 | C++ low ceiling | 5 |
| Audio/SoundCue/Submix/MetaSound | 0 fc | 8 | +8 | PY | 3 |
| UMG/Widgets | 0 fc | 9 | +9 | MIX | 5 |
| World Partition/Data Layers/Level Instances | 0 fc | 9 | +9 | MIX | 2/5 |
| PIE/gameplay test | 1 | 10 | +9 | MIX | 2 |
| Packaging/Cook (job-envelope) | 0 fc | 6 | +6 | MIX | 0/2 |
| **Transactions/undo** | 0 | 5 | +5 | **C++** | 4C |
| **Vision feedback** | ~6 | 13 | +7 | MIX | 4B |
| Niagara | 3 fc | 6 (template-scoped) | +3 | C++ low ceiling | 5 |
| Level/AI(BT/EQS/Blackboard)/Spline/GAS/Input/Data/Project/Docs wrappers | ~0 fc | ~30 | +30 | PY/MIX | 2 |
| Asset connectors (Fab/PolyHaven/AmbientCG/Sketchfab) + **AI-3D-gen** | 10 | 16 | +6 | HTTP/PY | steal-Blender |
| Conventions/Validator/Zone/DAG/Sliver/Routing meta | ~30 | ~30 | 0 | TS | — |

**Steal-list (cross-DCC, fold into above):** AI-3D-gen async `generate→poll→import` (Blender Hyper3D/Hunyuan) → asset connectors; **docs-as-a-tool** (Houdini/remiphilippe indexed UE-API + PLUMB docs) — also fixes the postmortem's "no UE reflection-introspection tool" gap; `get_*_status` gating probes; paginated outputs everywhere; outcome-verbs over primitives.

---

## 7. GLOBAL DESIGN RULES (every agent obeys)
- **Outcomes over operations**; flatten args (top-level primitives + `Literal` enums); paginate (`limit`/`has_more`/`next_offset`, default 20–50); actionable error strings + machine codes; structured `outputSchema` + JSON `TextContent` fallback.
- **Inspection-first**: every write domain ships a paired `*_inspect`/`*_brief` read tool (Flop pattern).
- **Validate before/after mutate** through PLUMB/validator; **transaction-wrap** every mutation; respect **Plan-Mode** before destructive ops.
- **Interop, not lock-in**: emit Epic-compatible `.mcp.json`; speak `list_toolsets`/`describe_toolset`/`call_tool`; register specialized toolsets into Epic's Toolset Registry where it extends reach.
- **No rebuild by default**: prefer `pyTemplate` descriptors; reserve C++ for hot-path/crash-prone.
- **Honesty invariant**: a tool advertised in the catalog must actually work, or be flagged not-callable. No second `not_implemented_in_v1`.
- **Token budget**: new tools land behind Code-Mode/deferred routing + packs; never bloat the eager surface.

Anchor files: `mcp-tools/hayba-mcp/src/tools/index.ts`, `register-tool.ts`, `routing/register.ts`, `schema-registry.ts`, `legacy-commands/sidecar.json`; `unreal/.../HaybaMCPCommandHandler.cpp` (ProcessCommand seam), `HaybaMCPBuildHandler.cpp:248`, `HaybaMCPTestHandler.cpp:227`, `HaybaMCPSeh.cpp`, `HaybaMCPBlueprintHandler.cpp:345` (stub), `HaybaMCPChatPanel.cpp` + `llm-client.ts` (revive from `ac46d40`), `tcp-client.ts`, `tool-executor.ts`.

---

# Completeness Critic

**Missing domains identified (then designed in the patch round):**

- UMG / Widget Blueprint / UI authoring — no Widget Blueprint create, no widget-tree compose, no slot/anchor/binding, no HUD/UserWidget add-to-viewport. Entirely uncovered despite being a top-3 gameplay authoring surface (Roblox peer ships create_ui_tree).
- Enhanced Input asset authoring — Input Action assets, Input Mapping Contexts, triggers/modifiers, key bindings. Only RUNTIME injection exists (pie_input_action/axis/key); no design-time IA/IMC authoring. Hard UE5 gap.
- AI / Navigation — Behavior Trees, Blackboards, NavMesh build/bounds, EQS, NavLink, AIController/Pawn perception. Zero coverage.
- Gameplay Ability System (GAS) — GameplayAbility/GameplayEffect/AttributeSet/AbilitySystemComponent and gameplay-tag-driven ability grants. Zero coverage.
- Gameplay Framework defaults — GameMode/GameState/PlayerController/Pawn/Character/HUD/GameInstance/PlayerStart and World Settings default-class wiring. No way to set the GameMode or configure World Settings; level_info only reads.
- Source Control integration — Perforce/Git provider connect, status, checkout, mark-for-add, revert, submit/changelist, sync, resolve, diff. Completely absent (remiphilippe/headless DevOps competitors have this).
- Localization — String Tables, culture/locale set, text gather/compile, .po import/export, localization dashboard targets. Absent.
- Networking / replication / multiplayer testing — multiplayer PIE (num players, dedicated server, net mode), replication graph, RPC/property-replication assertion harness. gameplay-pie domain is single-player only.
- Unreal Insights / trace profiling — Trace.Start/Stop, trace channels, .utrace capture/open, CSV profiler, FrameTrace/MemTrace, stat-to-trace. introspection has stat_command/gpu_profile but no trace-session capture.
- Virtual Textures — Runtime Virtual Texture volume + RVT material output, Streaming Virtual Texture conversion/build. Only texture_streaming_report (a read) exists.
- DataTables / Curves / Gameplay Tags / Data Assets — DataTable create + row CRUD + CSV/JSON import, CurveFloat/CurveTable authoring, GameplayTag table management, generic UDataAsset/PrimaryDataAsset CRUD. asset-import does generic FBX/USD/Datasmith but none of these structured-data verbs.
- Water system (Water plugin) — WaterBody Ocean/Lake/River, water zone, gerstner/wave settings, water material. Directly worldbuilding-relevant and uncovered.
- Level / map management (non-WorldPartition) — new_level/save_current/open/duplicate, persistent + streaming sublevels, level visibility, World Settings asset. world-partition covers streaming cells but not classic level lifecycle.
- Skeletal Mesh setup — skeletal LODs, material slot/section remap, morph targets, skin-weight/cloth (Chaos Cloth) authoring, LOD reduction. animation covers skeleton sockets/retarget but not the skeletal-mesh asset surface.
- Chaos Vehicles — wheeled/vehicle setup, wheel/suspension/engine config. Absent (physics-and-chaos stops at rigid bodies + geometry collections).
- Decals — deferred Decal actor/material authoring, decal projection/sort. Absent.
- Volumes (gameplay/level) — trigger volume, blocking volume, nav-modifier, kill-Z/pain-causing, audio/reverb volume, lightmass importance volume, cull-distance volume. Only PostProcessVolume + ProceduralFoliageVolume exist.
- Splines & Spline Mesh — general USplineComponent/spline actor authoring + SplineMeshComponent deform-along-spline. Only landscape_spline exists; no generic spline/road/fence builder.
- Take Recorder — record actor/sequence takes, take source config. Cinematics-adjacent, absent.
- Groom (hair/fur) and Media Framework (media textures/players) — niche but genuine subsystems with zero coverage.

**Per-domain gaps:**

- **actor-level-editing**: actor_component_inspect (read a single component's properties), actor_component_set_property / actor_component_remove / actor_component_reorder (only add exists), actor_set_root_component, actor_copy / actor_paste (clipboard round-trip), actor_move_to_level (cross-level / persistent vs sublevel), actor_get_attached_children / actor_hierarchy_tree, actor_set_actor_property_on_class_default (CDO edit) — currently only instance edits
- **mesh-and-geometryscript**: mesh_export (to FBX/OBJ/glTF disk), geo_vertex_color_paint / geo_bake_vertex_colors, geo_convex_decomposition (auto-convex collision gen), geo_lattice / geo_deform_along_spline / geo_bend, geo_attribute_set / geo_polygroup ops, geo_bake_textures (mesh->texture, normal/AO/ID bake), geo_lod_generate via GeometryScript (distinct from staticmesh_generate_lods)
- **materials-and-textures**: material_function_create / material_function_call (MaterialFunctions), material_create_decal / material_create_postprocess (domain-specific master materials), material_layer_create / material_layer_blend (Material Layers + landscape layer blend), substrate_material_configure (UE5.7 Substrate), texture_import_array / texture_cube_create (texture arrays, cubemaps), rvt_material_output_set (Runtime Virtual Texture wiring)
- **blueprint-authoring**: blueprint_add_timeline (Timeline nodes — common K2 construct, absent), blueprint_add_custom_event / blueprint_add_event_dispatcher (delegates), blueprint_set_parent_class / blueprint_reparent, blueprint_implement_interface_event (add_interface exists but not implementing its events), blueprint_get_cdo_defaults / blueprint_set_class_default, blueprint_create_function_library / blueprint_create_macro_library (asset types), blueprint_add_construction_script_logic
- **sequencer-and-cinematics**: seq_add_skeletal_animation_track (bind AnimSequence/montage to a skeletal actor — core cinematic verb, absent), seq_add_material_parameter_track / seq_add_visibility_track / seq_add_event_track, seq_set_marked_frames / seq_add_marked_frame, seq_add_attach_track (parent constraint over time), seq_take_record_start (Take Recorder bridge)
- **physics-and-chaos**: chaos_cloth_setup / cloth_paint_weights (Chaos Cloth — uncovered), physics_substepping_config / physics_solver_settings, physics_constraint_profile_create, geometry_collection_set_cluster / geometry_collection_connection_graph (clustering controls beyond fracture), physics_asset_add_body / physics_asset_add_constraint (granular phys-asset editing, not just create+brief)
- **animation-and-controlrig**: aim_offset_create (distinct from blendspace), morph_target_list / morph_target_set (skeletal morphs), pose_asset_create / anim_composite_create, anim_layer_add (layered AnimBP), skeletal_mesh_lod_setup / skeletal_mesh_material_slot_remap, anim_montage_slot_add / anim_slot_group_manage
- **lighting-postprocess-and-rendering**: volumetric_cloud_configure (VolumetricCloud actor — sky_atmosphere only covers atmosphere), light_function_assign / ies_profile_assign / light_channel_set, lightmass_importance_volume_add / precomputed_visibility_set, decal_spawn / decal_set (deferred decals, if not its own domain), exposure metering mode + auto-exposure curve readback (exposure_set is thin)
- **gameplay-pie-and-testing**: pie_set_net_mode / pie_set_num_players / pie_start_dedicated_server (multiplayer PIE), pie_replication_assert (verify replicated property convergence across clients), pie_simulate_mode (Simulate vs Play distinction), pie_get_subsystem_state (GameInstance/World subsystem introspection at runtime)
- **asset-import-and-sources**: datatable_import_csv / datatable_row_crud (structured-data import — distinct from blob import), asset_import_alembic / asset_import_geometry_cache, asset_import_animation (AnimSequence/skeleton-targeted import options), asset_migrate (cross-project migrate w/ dependencies), asset_bulk_edit_metadata / asset_set_collection (Collections), asset_source_control_status (if SC not its own domain)
- **world-partition-streaming-datalayers**: wp_convert_map (convert non-WP level to World Partition), ofpa_inspect / external_actor_status (one-file-per-actor handling), wp_minimap_build / wp_build_minimap, hlod_layer_create / hlod_settings_set (wp_build_hlod exists but no HLOD layer authoring), wp_grid_inspect (runtime grid config readback beyond set)
- **editor-introspection-and-observability**: trace_session_start / trace_session_stop / trace_open (Unreal Insights — the profiling tools here are point stats, no trace capture), subsystem_list / subsystem_inspect (Engine/Editor/GameInstance/World subsystem enumeration — a real reflection gap), input_mapping_inspect (read Enhanced Input config), source_control_status (if SC folded here)
- **landscape-and-terrain**: landscape_delete / landscape_layer_remove, landscape_blueprint_brush_add (Landmass / custom brushes), landscape_physical_material_assign (per-layer phys material), landscape_to_water_handoff (Water plugin coastline), landscape_proxy_split / landscape_streaming_proxy_manage (WP landscape proxies)

**Overlaps flagged:** actor_inspect is defined in BOTH actor-level-editing AND editor-introspection-and-observability — same verb, two domains.; Selection read split: actor_get_selection (actor) vs selection_get (introspection) — duplicate.; Test runner triplicated/overlapping: test_run/test_list/test_get_log appear in project-build-cook-packaging AND gameplay-pie-and-testing (test_run_async/test_list/test_get_log) — plus functional_test_run/functional_test_map in both. Consolidate one async test registry.; Nanite enable duplicated: staticmesh_set_nanite (mesh) vs nanite_set/nanite_inspect/nanite_batch_enable (lighting).; Console exec duplicated: console_exec (introspection) vs pie_console_command (pie) vs render_cvar_set + cvar_set (introspection) — cvar/console surface is fragmented across 3 domains.; Perf/stat overlap: pie_capture_stats (pie) vs perf_stats/stat_command/gpu_profile/memory_report (introspection).; Vision/capture verb sprawl: editor_capture_viewport, render_camera, high_res_screenshot, thumbnail_generate, before_after_capture, orbit_capture, buffer_visualization_capture (lighting), pie_capture_screenshot, material_thumbnail/material_preview_on_mesh, asset_thumbnail, landscape_capture_topdown, foliage_capture_compare, niagara_capture_preview, seq_render_still, pcg_preview_capture, anim_preview_render — ~16 near-duplicate capture verbs; should share one parameterized capture core.; Material assignment duplicated 4x: actor_assign_material (actor), staticmesh_assign_material (mesh), material_apply_to_selection/material_apply_batch (materials), landscape_set_material (landscape).; Collision authoring overlap: staticmesh_collision_set (mesh) vs mesh_generate_collision/mesh_remove_collision (physics).; Transaction/undo duplicated per-domain: actor_undo/redo, audio_undo, physics_undo, plus *_transaction(_begin/commit) in actor/audio/blueprint/landscape/sequencer/niagara/pcg/wp and undo_history (introspection) — a cross-cutting seam re-implemented ~10 times.; Reflection/type-search overlap: reflect_class/reflect_functions/reflect_search_types (introspection) vs blueprint_search_classes/blueprint_search_functions/blueprint_pin_type_catalog (blueprint).; Generic vs specific inspect overlap: object_inspect/object_get_property (introspection) supersede actor_get_property, mesh_inspect, material_instance_inspect, etc. — risk of divergent behavior.; Landscape grass duplicated: landscape_grass_assign (landscape) vs landscape_grass_type_create (foliage).; Validation sprawl: every domain ships *_validate plus plumb_validate plus validator_run/validator_history — overlapping verdict surfaces.; Movie render duplicated: seq_render_movie (sequencer) vs movie_render (lighting) — both MRQ paths.

**Notes:** Coverage of the prompt's named hint list: Chaos destruction COVERED (physics geometry_collection_*), Control Rig COVERED (animation), Nanite COVERED (mesh+lighting, but duplicated), Lumen COVERED (lighting), Data Layers COVERED (world-partition), MRQ/render-to-movie COVERED (sequencer+lighting), Automation/CI COVERED (project-build ci_build_cook_package + functional tests). GENUINELY MISSING from the hint list: Virtual Textures (only a read tool), Subsystems/GameFramework (no GameMode/World Settings/subsystem enum), Enhanced Input (only runtime injection, no IA/IMC authoring), Networking/replication test (single-player PIE only), Localization (absent), Source Control (absent), Insights/profiling trace-capture (only point stats). Modeling Mode is ~80% subsumed by mesh-and-geometryscript (acceptable). Biggest strategic blind spots beyond the hint list, ranked by competitive value: (1) UMG/UI authoring — Roblox peer already ships create_ui_tree and it is a primary gameplay surface; (2) AI/BehaviorTree/NavMesh and (3) Gameplay Ability System — both required to call this a gameplay engine MCP, not just a worldbuilding one; (4) Water plugin — directly extends the existing worldbuilding moat (landscape/foliage/PCG) into coastlines/rivers and no competitor has it; (5) DataTables/Curves/GameplayTags — the structural-data backbone every gameplay loop needs. Cross-cutting recommendation: the per-domain transaction/undo, validate, dry_run, capture, and console/cvar verbs should be unified cross-cutting seams rather than re-declared in every domain — current catalog inflates tool count with ~40+ near-duplicate wrappers that will drift in behavior and confuse tool selection. Niche subsystems worth a backlog line but not P0: Take Recorder, Media Framework, Groom (hair/fur), Variant Manager, Chaos Cloth/Vehicles, Alembic/GeometryCache import.

---

# Competitor Reports


## Aura / Ramen

# AURA — Unreal Engine AI Agent — Research Report

## Disambiguation
Multiple unrelated things are named "Aura" (Aura skincare AI, Aura digital-safety app, Unreal "Aura GAS" tutorial project by Druid Mechanics/Stephen Ulibarri, the game *Aura* by RPG Maker, etc.). The subject here is the **UE/Unity game-dev AI agent at tryaura.dev, built by Ramen (formerly Ramen VR)**. All findings below refer to that product. Note also a naming collision: Stephen Ulibarri's popular "GAS Aura" Udemy course/repo is a *coding tutorial*, NOT this tool — do not conflate.

## What it is & who makes it
- **Aura** = a purpose-built, multi-agent AI assistant/agent for **Unreal Engine and Unity** game development. Tagline "Ship Your Game Faster." Installed as an **engine-level plugin**; can run **standalone desktop app, docked in-editor, headless, or via IDE/MCP**. Windows-only (Mac "future"). [tryaura.dev]
- **Maker: Ramen** (formerly Ramen VR), founded 2019, CEO **Andy Tsen**. Originally a VR studio that shipped the 2022 VR MMO *Zenith: The Last City*, then pivoted to AI dev-tools. ~20-person core team drawn from Activision/Blizzard/Riot/Ubisoft/Apple/Google. **$40M+ raised** (Y Combinator, Maker's Fund, Anthos Capital, Dune Ventures). [gamesbeat.com]
- **Lineage / consolidation:** Ramen **acquired Flopperam** (the `flopperam/unreal-engine-mcp` open-source UE-MCP project, "Flop MCP") and reportedly **Coplay** (Unity AI). The flopperam GitHub repo now redirects users to tryaura.dev. Combined install base claimed at **30,000+ developers** across Aura/Coplay/Flopperam. [github.com/flopperam/unreal-engine-mcp, gamesbeat.com]
- **Launched** Jan 2, 2026; rapid version cadence — 12.0 Beta (Mar 2026 "multi-agent"), 15.0 (Jun 26, 2026, "unlimited usage"). Current relevant release = **Aura 15.0**.

## Architecture
- **Native UE plugin + LLM backbone.** LLM is Claude-family (Auto Mode default; premium "Fast Opus"; "Fable" model future). It is NOT primarily BYOK — it bills against an Aura subscription/credits, though it can act as an **MCP server** so external agents (Claude Code etc.) drive the editor.
- **MCP surface (for the IDE/external-agent path) splits into separate server processes:**
  - `unreal_inspector` — **read-only**: asset inspection, blueprint analysis, code/asset search, logs, planning.
  - `unreal_editor` — **write**: blueprint authoring, C++ coding, material editing, VFX, behavior trees.
  - `aura-unity` — single server exposing full Unity surface (scene/GameObject CRUD, components, `execute_script` arbitrary C#).
- **Three interaction modes:** **Ask** (analysis, no mutation), **Plan** (step-by-step plan before execution), **Agent** (creates/edits files & assets). Plus parallel chat threads (~4 simultaneous), @-mention asset/file references, image/doc attachments.
- **Specialized multi-agent ("you can't have one-size-fits-all for game dev") — named subagents:**
  - **Telos** — Blueprint Agent
  - **Dragon** — Python (UE editor scripting) Agent
  - **Material Agent** — procedural HLSL material authoring
  - **Verification Agent** — autonomously playtests gameplay and catches bugs
  - (Subagents bill to the Aura subscription, not the host IDE's AI plan.)

## Capabilities (categorized)
- **Blueprint & data:** generate/edit Blueprints, enums, structs, data tables; visual native graph manipulation; batch property edits across many objects.
- **Code:** C++ create/edit + **Live Coding compile with self-correction on errors**; UE Python editor scripting; Unity C#; **shell/CLI command execution** (version control, CLI tools).
- **Scene/level/design:** level design, batch spawning/placement, behavior-tree config, VFX & audio implementation, **Slate UI overlay** creation.
- **Art/3D:** concept image generation, **3D model gen from image/text**, audio generation, FAB store asset-library search.
- **Analysis:** project architecture understanding, scene/prefab analysis, performance profiling, asset-reference validation.
- **Workflow infra:** **Sandbox Mode** (reversible, isolated project changes; UE 5.8) — its undo/safety story; **Aura Skills** (custom workflows, **compatible with Claude Code skills**); MCP to external agents; chat export/history.

## Tool/command count
- Aura does **not publish a discrete native tool count** — it's pitched as conversational, not a CLI catalog.
- Its **MCP heritage (Flopperam "Flop MCP")**: **Hosted Flop MCP ≈ 50+ tools across 9 domains** (Blueprint Authoring 10, Blueprint Inspection 3, Scene/Level 6, Materials 2, VFX 3, Animation 5, UMG 2, AI/Abilities 3, Landscape/Foliage 4, + Cinematics/Procedural/DataAssets/Editor/Runtime/Execution); **Open-source Local MCP ≈ 40 tools across 8 categories**. [github.com/flopperam/unreal-engine-mcp]
- (Caveat for your comparison: StraySpark's "305 tools / 42+ categories" figure refers to a *different/competing* full UE-MCP server in their Aura-vs-MCP piece, **not** Aura's own surface. Don't attribute it to Aura.)

## Pricing & positioning
- Credit model; **one plan covers both UE and Unity.** **Auto Mode is always free + unlimited** (rate-limited per tier); premium credits buy frontier models (e.g. Claude Opus). 2-week free trial (unlimited Auto Mode + $10 premium credit).
  - **Indie** $20/mo (launch $10) — $15/mo premium credit; unlimited Auto Mode, both engines, unlimited MCP w/ external agents, 3D+audio gen.
  - **Pro** $40/mo (RECOMMENDED) — ~$60 premium credit; higher rate limits, PAYG overage, "Super Mode" (max reasoning).
  - **Ultimate** $200/mo — ~$335 premium credit, highest rate limits, "Fast Opus," future "Fable" access.
  - **Enterprise** custom — **source access**, onboarding, roadmap prioritization.
- Positioning: native, polished, "deeply integrated, purpose-built for game dev" for indies→studios; productivity proof points (Sinn/Synth Studios "2x–3x" velocity, *Zombonk* top-10 grossing Quest title).

## Standout features
- Native in-editor agent with **visual Blueprint graph editing** (vs command-only MCP rivals); deep UE module/subsystem knowledge; **self-correcting C++ live-compile loop**; **autonomous Verification/playtest agent**; **Sandbox Mode** reversible changes; role-specialized agents; doubles as an MCP server for external agents; Claude-Skills-compatible "Aura Skills"; unlimited Auto Mode pricing.

## Weaknesses / risks
- **Closed-source, proprietary, vendor lock-in** (UE/Unity only; no inner-workings visibility, limited studio-convention customization) — StraySpark's core critique vs open MCP.
- **Windows-only** (no Mac yet).
- **Maturity/bugs:** UE forum users report "barely alpha," settings-persistence issues, AI **refusing to edit existing Blueprints** even when enabled, and **install friction** when project & engine live on different drives; installer historically shipped **DLLs only for UE 5.3.0**, no .cpp/.h for source builds.
- **Cost stacking:** when used as MCP backend, Aura subagent calls bill to Aura *and* can raise host-IDE API costs.
- Depends on Anthropic models (Claude) — limited model flexibility vs open-MCP "any LLM/local" approach.

## Sources
- https://www.tryaura.dev/ and https://www.tryaura.dev/about/ (pricing)
- https://www.tryaura.dev/documentation/ and https://www.tryaura.dev/documentation/aura-ide-mcp/
- https://www.tryaura.dev/updates/aura-launch-ai-assistant-unreal-engine
- https://github.com/flopperam/unreal-engine-mcp (tool counts, acquisition)
- https://www.strayspark.studio/blog/aura-vs-mcp-ai-assistants-unreal-engine-2026 (strengths/weaknesses vs MCP)
- https://gamesbeat.com/ramen-releases-aura-15-0-to-assist-game-devs-with-unreal-engine-and-unity-exclusive-interview/ (15.0, named agents, company, funding, metrics)
- https://forums.unrealengine.com/t/aura-ai-agent-for-unreal-editor/2689209 and https://forums.unrealengine.com/t/aura-now-unlimited-unreal-5-8-sandbox-integration-mcp-claude-skills/2731687 (user-reported weaknesses, v0.15/15.0 features)
- https://www.businesswire.com/news/home/20260302390163/... (Aura 12.0 Beta multi-agent) — referenced via search; page timed out on direct fetch.


## Epic UE 5.8 official MCP

# Unreal Engine 5.8 — Epic's Official MCP / AI-Assistant Integration

## Bottom line

Yes. Epic shipped a first-party **Unreal MCP** plugin in UE 5.8 (released **June 17, 2026**), marked **Experimental**. It embeds an MCP (Model Context Protocol) server *inside the editor process* so any MCP-compatible agent (Claude Code, Cursor, VS Code, Gemini, Codex, MCP Inspector) can drive the editor over a local HTTP connection. It is NOT a chat-bot/copilot baked into the editor UI — it is a protocol surface that external agents connect to. There is no embedded LLM; you bring your own client. Crucially, it does **not** build on the Remote Control API — it builds on a new **Toolset Registry** plugin plus UFUNCTION reflection and Python.

---

## What it is and what it exposes

- An MCP server running in the editor that exposes engine functionality as **Tools** an agent can invoke: spawn/manipulate Actors, edit levels, configure lighting, create material instances, edit Blueprint node graphs, work with meshes/assets, inspect Slate widgets, run automation tests, sequencing, and optimization tasks.
- Shipped **toolsets** (each engine plugin can contribute its own): `SceneTools`, `ActorTools`, `MaterialInstanceTools`, `ObjectTools`. Toolsets are pluggable, so the surface grows as plugins register more.
- Agents receive **structured state read-back** (not screenshots), enabling self-verification loops where the agent queries project state after acting.

## Architecture

- **Transport:** HTTP + Server-Sent Events only. `stdio` and WebSocket are explicitly **not** supported.
- **Endpoint:** binds to `http://127.0.0.1:8000/mcp` by default. Loopback only; rejects non-loopback `Origin` headers. **No authentication layer.**
- **Modules:** runtime `ModelContextProtocol` and `ModelContextProtocolEngine`; editor-only `ModelContextProtocolEditor`. Depends on the **Toolset Registry** plugin.
- **Execution model:** Tool invocations run **on the game thread, serially**. (This is the same threading constraint our own server lives under.)
- **Tool authoring:**
  - Python — derive from `unreal.ToolsetDefinition`, decorate `@staticmethod` functions with `@toolset_registry.tool_call`, Google-style docstrings become the schema.
  - C++ — derive from `UToolsetDefinition`, `UCLASS(BlueprintType, Hidden)`, mark methods `UFUNCTION(meta = (AICallable))`.
  - So the "ceiling" of what it can expose is the **Blueprint/Python-reflected (UFUNCTION) API surface** — the same reflection ceiling as Remote Control, but reached via a different registry, not via RC presets.

## Tool-search / meta-tool layer (token economy)

Epic added a **Tool Search mode** (Editor Pref "Enable Tool Search", default on) with three meta-tools so agents don't have to load every schema up front:
- `list_toolsets` — available toolset names
- `describe_toolset` — schemas for a named toolset
- `call_tool` — dispatch a named toolset's tool

This is the same catalog/discovery pattern our server uses (our "catalog mode"); Epic baked a lighter version of it in.

## Setup / console commands

1. Enable **Unreal MCP** in Edit > Plugins (and the Toolset Registry dependency).
2. Edit > Editor Preferences > General > **Model Context Protocol** → toggle **Auto Start Server**.
3. Console: `ModelContextProtocol.GenerateClientConfig ClaudeCode` (or `Cursor`, `VSCode`, `Gemini`, `Codex`, `All`) → writes `.mcp.json` to project root.
4. Launch the agent from the project/workspace root.

Other console commands: `ModelContextProtocol.StartServer [port]`, `…StopServer`, `…RefreshTools`. CLI flags `-ModelContextProtocolStartServer`, `-ModelContextProtocolPort=N`. CVars include `WrapPODToolResultsInObject` (default true), `PaginationPageSize` (default 0), `ProgressIntervalSeconds`, `EnableAnalytics`.

## Stated limitations (Epic's own)

- Experimental; APIs will change; dev workflows only, not production/shipping pipelines.
- Loopback-only, no auth.
- MCP **Resources** and **Prompts** are not advertised by shipping toolsets (Tools only).
- Toolset auto-discovery is **editor-only**; cooked builds need explicit registration.
- **Live Coding does not propagate new `UFUNCTION` declarations** — adding C++ tools requires an editor restart.

---

## The automation "ceiling": Remote Control API vs Editor Scripting/Python

These define the maximum of what is automatable in UE, and the MCP plugin sits on top of the same reflection layer.

**Editor Scripting / Python (`unreal` module)** — the broadest surface:
- Any function exposed to Blueprint or Python is callable. Key subsystems: `EditorAssetLibrary`, `EditorLevelLibrary`/`LevelEditorSubsystem`, `EditorActorSubsystem`, `AssetTools`, `EditorUtilitySubsystem` (Editor Utility Widgets/Blueprints), `unreal.PythonScriptLibrary`, plus full reflection over UCLASS/UFUNCTION/UPROPERTY marked `BlueprintCallable`/`CallInEditor`/`ScriptCallable`. This is effectively the ceiling — anything reflected can be scripted. (Docs: Scripting and Automating the Unreal Editor; Python API.)

**Remote Control API** (`RemoteControl` + `RemoteControlWebInterface` plugins) — the *networked* surface, a sibling path the MCP plugin notably does NOT use:
- Web server hosting HTTP + WebSocket. Started via `WebControl.StartServer` (default ports ~30010 HTTP / ~30020 WS). Experimental routes gated by `WebControl.EnableExperimentalRoutes`.
- Core HTTP endpoints: `PUT /remote/object/call` (invoke any Blueprint/Python-exposed UFUNCTION), `PUT /remote/object/property` (get/set), `/remote/preset/...`, `/remote/search/assets`, batched calls. Epic states it gives "a similar level of control… to what you have in Blueprint and Python — your web application can call any function exposed to Blueprint and Python."
- **Remote Control Presets** curate properties/functions into a panel + companion web app for live/show-control use.
- Same reflection ceiling as Python, just reached over the wire with no agent/LLM semantics, no transactioning, no catalog/token management.

Takeaway: Epic's MCP, Remote Control, and Python all bottom out at the **same UFUNCTION/Blueprint reflection ceiling**. MCP is a third front-door to it (agent-oriented, game-thread-serial, Toolset-Registry-based), distinct from RC's preset/web front-door.

---

## How a third-party MCP (ours) should position

Epic's plugin is "the free front door to AI-driven editing" — deliberately minimal, foundational, experimental. It establishes the baseline; it does not chase feature completeness or production hardening. Where mature third-party servers (ours, StraySpark, UAIP/UAIP-bridges, mcp-unreal) still win:

| Dimension | Epic 5.8 plugin | Third-party advantage |
|---|---|---|
| **Tool breadth** | Minimal foundational set (a handful of toolsets) | 370+ tools / ~54 categories (Blueprints, **PCG**, Chaos, modeling, source control, **PIE**) — StraySpark ~200 tools/34 cats; UAIP ~730 cmds (540 native + 190 bridges) |
| **Token economy** | Light Tool-Search meta-tools | Full **catalog mode**: discovery meta-tools + high-frequency core ≈ **3K tokens (~95% cut)** despite hundreds of tools |
| **Undo** | Per-call → 24 ops = 24 undo entries | `run_tool_script` bundles multi-step sequences into **one transaction / one Ctrl+Z** |
| **Closed-loop verification** | Limited read-back | `describe_graph`-style full Blueprint-topology read-back for in-loop validation |
| **Security** | Loopback, **no auth**, will mature | Bearer auth, scope gates, BindAddress control, DNS-rebinding defense **today** |
| **Resilience / lifecycle** | Game-thread-serial; restart to add C++ tools; Live Coding gap | Crash-resilience, game-thread dispatch seams, late-response/dangling-delegate guards |
| **Cross-engine / cadence** | Unreal-only, Epic release cadence | Any MCP client, independent vendor cadence |

**Strategic positioning for Hayba specifically:**
- **Don't fight the front door — extend it.** Epic's Toolset Registry (`unreal.ToolsetDefinition` / `UFUNCTION(meta=(AICallable))`) is a clean, sanctioned extension point. We can register our specialized toolsets (PLUMB validation, PCG/worldbuilding, sliver/asset workflows) into Epic's registry so our capabilities show up to any agent that connects to the official server — while keeping our standalone HaybaMCP server for everything Epic's threading/transport model can't do.
- **Lead with the gaps Epic explicitly won't close soon:** transactional multi-step edits (one-undo), token-economized catalogs, quantified PLUMB-style validation/closed-loop verification, crash-resilience, PIE, PCG, and security hardening. Those map directly onto our existing moats (crash-resilience, PLUMB validation, token economy) and our known roadmap gaps (PIE, undo/dry-run).
- **Interop, not lock-in:** support the same `.mcp.json`/client-config UX Epic generates, and consider speaking Epic's meta-tool verbs (`list_toolsets`/`describe_toolset`/`call_tool`) so agents trained on the official surface "just work" against ours.
- **Watch the transport divergence:** Epic is HTTP+SSE, loopback, no-auth; if our server offers authenticated/remote/bundled-transaction modes, that is a concrete, defensible differentiator rather than a compatibility liability.

---

## Sources

- Official docs — Unreal MCP in Unreal Editor: https://dev.epicgames.com/documentation/unreal-engine/unreal-mcp-in-unreal-editor?lang=en-US
- UE 5.8 Release Notes: https://dev.epicgames.com/documentation/unreal-engine/unreal-engine-5-8-release-notes
- UE 5.8 launch announcement: https://www.unrealengine.com/news/unreal-engine-5-8-is-now-available
- Remote Control for Unreal Engine (5.8): https://dev.epicgames.com/documentation/en-us/unreal-engine/remote-control-for-unreal-engine
- Remote Control API HTTP Reference (5.8): https://dev.epicgames.com/documentation/en-us/unreal-engine/remote-control-api-http-reference-for-unreal-engine
- Remote Control Presets and Web Application (5.8): https://dev.epicgames.com/documentation/en-us/unreal-engine/remote-control-presets-and-web-application-for-unreal-engine
- StraySpark — Epic's Official MCP Plugin (UE 5.8) vs third-party: https://www.strayspark.studio/blog/epic-official-mcp-plugin-ue5-8-vs-third-party
- explainx.ai — UE 5.8 Claude/Codex/MCP guide: https://www.explainx.ai/blog/unreal-engine-5-8-claude-codex-mcp-ai-integration-2026
- byteiota — UE 5.8 ships MCP server: https://byteiota.com/unreal-engine-5-8-ships-mcp-server-ai-agents-can-now-drive-the-editor/
- CryptoBriefing — UE 5.8 experimental MCP support: https://cryptobriefing.com/unreal-engine-5-8-mcp-server-support/
- TechMyMoney — UE 5.8 connects Claude and Gemini into editor: https://techmymoney.com/2026/06/18/unreal-engine-5-8-connects-claude-and-gemini-directly-into-game-editors/

Note: the official release-notes *section* for MCP is terse and does not itself name Remote Control/Python/Toolset Registry; those architecture details come from the dedicated "Unreal MCP in Unreal Editor" documentation page, which is authoritative for tool names, transport, and console commands. Where third-party blogs disagreed with Epic docs (e.g., default port/path), I used the official docs (`http://127.0.0.1:8000/mcp`, HTTP+SSE only).


## Flopperam

# Flopperam Unreal Engine MCP — Exhaustive Inventory

## Strategic context (read first)
The project (`github.com/flopperam/unreal-engine-mcp`, MIT, ~1,000 stars / 194 forks) **has been acquired by Aura** (tryaura.dev). The repo is now in maintenance/redirect mode; active development moved to Aura. Two distinct products live under one repo, plus an in-editor agent:

1. **Open-source Local MCP** — community-maintained, runs locally, ~42 tools. (the actual codebase)
2. **Hosted "Flop" MCP** — cloud server (`agent.flopperam.com/mcp`), ~64 tools (46 free + 18 PRO/paid). (the commercial product)
3. **The Flop Agent** — autonomous AI agent running *inside* the Unreal Editor (chat + full Blueprint editing), built on top of the hosted MCP.

Supported engines: **UE 5.5, 5.6, 5.7**.

---

## Architecture

**Local MCP:**
- Python server `Python/unreal_mcp_server_advanced.py` (built on **FastMCP**, stdio transport to the IDE/MCP client).
- C++ plugin `UnrealMCP/` bundled in repo.
- **C++ plugin = TCP server on port 55557**; Python = TCP client. Plugin auto-starts the TCP listener when the editor loads. Python serializes commands → plugin executes against the engine API. Python side adds connection pooling, retries, and helper modules for the procedural generators (towns/castles/etc.).
- Requires Python 3.12+. Setup = clone repo, compile C++ plugin, run Python server. `LOCAL_SETUP.md` covers macOS.

**Hosted Flop MCP:**
- Cloud endpoint `https://agent.flopperam.com/mcp`, **Streamable HTTP + WebSocket**, Bearer-token auth (API key from flopperam.com/account).
- `FlopAI` plugin (C++/Python bridge) installed in the editor; calls native UE APIs.
- Zero local Python deps; one URL + key. Clients: Cursor, Claude Code, Windsurf, Cline, VS Code Copilot, Continue (any MCP client).

---

## TOOL INVENTORY A — Open-Source Local MCP (42 tools, 8 categories)
Source: `iflow-mcp` mirror + repo README.

**Blueprint Visual Scripting (11):** `add_node` (23+ node types), `connect_nodes`, `delete_node`, `set_node_property`, `create_variable`, `set_blueprint_variable_properties`, `create_function`, `add_function_input`, `add_function_output`, `delete_function`, `rename_function`

**Blueprint Analysis (4):** `read_blueprint_content`, `analyze_blueprint_graph`, `get_blueprint_variable_details`, `get_blueprint_function_details`

**Blueprint System (4):** `create_blueprint`, `compile_blueprint`, `add_component_to_blueprint`, `set_static_mesh_properties`

**Actor Management (5):** `get_actors_in_level`, `find_actors_by_name`, `delete_actor`, `set_actor_transform`, `get_actor_material_info`

**Physics & Materials (6):** `spawn_physics_blueprint_actor`, `set_physics_properties`, `get_available_materials`, `apply_material_to_actor`, `apply_material_to_blueprint`, `set_mesh_material_color`

**World Building (6):** `create_town`, `construct_house`, `construct_mansion`, `create_tower`, `create_arch`, `create_staircase`

**Epic Structures (3):** `create_castle_fortress`, `create_suspension_bridge`, `create_aqueduct`

**Level Design (3):** `create_maze`, `create_pyramid`, `create_wall`

> Note: World Building / Epic Structures / Level Design are *parametric procedural generators* (canned algorithms), not general-purpose primitives. This is the local server's signature feature and also its main limitation.

---

## TOOL INVENTORY B — Hosted Flop MCP (~64 tools, 13 categories; 46 free / 18 PRO)
Source: flopperam.com/mcp (authoritative current list).

**Scene & Level (8, free):** `scene_query` (spawn/move/rotate/scale + batch modify + find by class/label/tag/location), `scene_brief`, `scene_compose` (batched declarative authoring), `level_inspect` (World Partition/streaming), `actor_inspect` (components/materials/collision/physics/LODs), `search_assets`, `asset_references` (hard-ref dependency walk), `project_context`

**Blueprint Authoring (11, PRO):** `bp_create` (BP/Interface/Enum/Struct), `bp_class` (CDO props), `bp_variable`, `bp_component`, `bp_graph_write`, `bp_nodes` (~40 node types), `bp_wire`, `bp_input` (Enhanced Input bundles), `bp_commit` (compile + auto-layout + health check), `bp_author` (full GraphSpec JSON, ~50 auto-repair rules), `bp_dry_run`

**Blueprint Inspection & Rescue (7; mostly free, some PRO):** `bp_brief`, `bp_inspect` (18 ops), `bp_graph_read`, `bp_export` (GraphSpec JSON), `load_bp_skills` (86+ docs topics, PRO), `load_scene_skills` (54+ topics, PRO), `repair_blueprint` (corruption rescue, PRO)

**Materials & Shading (2, free):** `material_inspect`, `material_edit` (43 ops — materials/instances/functions/expression wiring/param collections)

**VFX — Niagara + Chaos (5, free):** `niagara_inspect`, `niagara_edit`, `niagara_script_edit`, `chaos_edit` (Geometry Collection destruction), `ramp_authoring` (UCurveFloat/Vector/LinearColor)

**Animation (5, free):** `animation_inspect`, `animation_edit` (FBX import/retarget/keyframes), `animation_graph_edit` (AnimBP state machines), `ik_rig_edit`, `ik_retarget`

**Widgets / UMG (2, free):** `widget_inspect` (+live PIE verify), `widget_edit` (80+ ops, 40+ native widget types, MVVM binding)

**AI — BT/GAS/Tags/StateTree (4, free):** `behavior_tree` (50+ ops — BT/Blackboard/AIController/NavMesh/EQS/Smart Objects), `state_tree_edit`, `gas_edit` (abilities/effects/attribute sets), `tag_registry_edit`

**Landscape & Foliage (4, free):** `landscape_inspect`, `landscape_edit` (sculpt + semantic features: mountains/valleys/craters/plateaus, heightmap I/O), `foliage_inspect`, `foliage_edit`

**Cinematics / Audio / Procedural (5, free):** `sequencer_edit` (Level Sequences, camera cuts), `metasound_edit`, `sound_asset_edit` (SoundCue/Class/Attenuation), `pcg_graph_edit`, `collision_profile_edit`

**Data Assets (1, free):** `asset_factory` (56 batched ops — Enums/Structs/DataTables/DataAssets/Enhanced Input/BP deletion)

**Runtime Verification / PIE (2; 1 free, 1 PRO):** `pie_test_scene` (assertions + baseline pixel-diff, free), `pie_test_bp` (30+ assertion types, PRO)

**C++ & Editor (5, free):** `cpp_source` (read/write .h/.cpp + Live Coding + reflection macro parsing), `editor_actions` (save/undo/redo/build/PIE control), `editor_log`, `performance_audit` (tris/actors/textures/lighting), `window_capture` (viewport PNG for LLM context)

**Execution Escape Hatches (2, PRO):** `python_execution` (arbitrary in-editor Python), `unreal_api` (15,000+ API signature lookups)

---

## What it does well
- **Breadth (hosted):** Covers nearly every UE subsystem — Blueprints, materials, Niagara/Chaos VFX, animation/IK/retarget, UMG (incl. MVVM), GAS, Behavior Trees/EQS/StateTree, landscape, foliage, Sequencer, MetaSound, PCG, data assets. Few competitors match this domain coverage.
- **Blueprint authoring depth:** Full lifecycle (create → nodes → wire → compile → verify) with auto-layout, ~50 auto-repair rules, GraphSpec JSON round-trip, and a `repair_blueprint` rescue path. ~40 node types.
- **Runtime verification:** `pie_test_bp` / `pie_test_scene` actually run Play-In-Editor with 30+ assertion types and pixel-diff baselines — closes the "did it actually work" loop most MCPs skip.
- **Agent ergonomics:** On-demand "skills" docs (86+ BP topics, 54+ scene topics), `bp_dry_run` capability probing, `window_capture` for visual context, and `unreal_api` lookup of 15k+ signatures — designed to keep the LLM grounded.
- **Inspection-first design:** Almost every domain has a paired `*_inspect`/`*_brief` read tool, reducing blind writes.
- **Low-friction hosted setup:** one URL + key, no local Python/plugin compile.
- **Local server's procedural generators** make impressive one-shot demos (towns, castles, mazes) cheaply.

## Demos
- "Claude generates a full metropolis with **4,000+ objects**."
- Playable **maze + mansion complex** generation.
- Autonomous **combat system** authored into `BP_Combat99` (health, armor, stamina, combo) and a **health system** into `BP_MyPlayer2` — from natural language.
- Side-by-side AI-model comparisons.
- YouTube channel `youtube.com/@flopperam`; notable videos: **"The Future of Unreal Engine MCP (Update Video)"** (watch?v=enOmTKL6HpI) and **"FlopAI Unreal Agent v0.6 Is Here (Blueprint Analysis + In-Editor AI)"** (watch?v=1s_Mx7n29Fg). (YouTube pages don't render transcripts via fetch; titles/claims from search + site.)

## Gaps / limitations
- **Acquired by Aura → open-source repo is effectively frozen;** future work is closed-source/commercial. Strategic risk for anyone depending on it.
- **Best tools are paywalled:** all 11 Blueprint *authoring* tools, `repair_blueprint`, the skills loaders, `pie_test_bp`, `python_execution`, and `unreal_api` are PRO. The free tier is largely *read/inspect* + scene compose + the individual domain editors.
- **Hosted = cloud dependency:** requires sending project context to `agent.flopperam.com` over HTTP/WebSocket with an API key — a non-starter for air-gapped/NDA studios. (Contrast with Hayba's fully-local TCP plugin.)
- **Local server is shallow:** 42 tools, no contract verification, no PIE testing, no VFX/animation/cinematics/landscape/GAS/PCG domains; its "world building" is hardcoded parametric generators (towns/castles/mazes), not flexible primitives. Basic tool descriptions vs. the hosted version's rich LLM guidance.
- **Editor-time only:** both implementations target editor workflows; in-game/runtime development needs custom extensions.
- **No published roadmap;** no undo/dry-run on the local server; minor tool-count drift across their own docs (50+ vs 64) suggests churn.

## Sources
- https://github.com/flopperam/unreal-engine-mcp
- https://github.com/flopperam/unreal-engine-mcp/blob/main/README.md
- https://github.com/iflow-mcp/flopperam-unreal-engine-mcp (mirror; full local tool list)
- https://www.flopperam.com/mcp (authoritative 64-tool list)
- https://www.flopperam.com/ , https://www.flopperam.com/docs
- https://lobehub.com/mcp/flopperam-unreal-engine-mcp
- https://www.youtube.com/watch?v=enOmTKL6HpI , https://www.youtube.com/watch?v=1s_Mx7n29Fg , https://www.youtube.com/@flopperam


## Other UE MCPs (chongdashu, kvick, runreal, …)

# Open-Source Unreal Engine MCP Servers — Comparative Research

Researched June 2026. Eight notable community projects plus Epic's new first-party MCP. Grouped by architectural family.

---

## 1. chongdashu/unreal-mcp — the de-facto reference implementation
**Repo:** https://github.com/chongdashu/unreal-mcp · Docs: https://github.com/chongdashu/unreal-mcp/blob/main/Docs/README.md

- **Architecture:** C++ plugin acts as TCP *server* (port **55557**); Python **FastMCP** server connects as TCP client and serializes JSON commands. UE 5.5+, Python 3.12+.
- **Tool inventory by category:**
  - *Actors:* create/delete (cube, sphere, light, camera), set transform, query properties, find-by-name, list level actors.
  - *Blueprints:* create BP class, add/configure components (mesh/camera/light), set properties + physics, compile, spawn, create input mappings.
  - *Blueprint node graph:* add event nodes (BeginPlay/Tick), function-call nodes with pin connections, add typed variables, component/self references.
  - *Editor/viewport:* focus viewport on actor/location, control camera orientation + distance.
- **Maturity:** Most-starred community project — **~2k stars, 331 forks**, 23 open issues. MIT. Explicitly **EXPERIMENTAL** ("breaking changes without notice; not for production").
- **Standout:** Genuine Blueprint *graph* manipulation; bundled UE 5.5 starter project. Spawned many forks (e.g. jl-codes/unreal-5-mcp).
- **Gaps:** No materials, UMG, sequencer, PCG, animation, GAS. Actor creation limited to primitive types. No auth. Single connection model.

## 2. ChiR24/Unreal_mcp — most actively developed community fork-family
**Repo:** https://github.com/ChiR24/Unreal_mcp

- **Architecture:** TypeScript MCP server + C++ "Automation Bridge" plugin. **Dual transport:** native HTTP/SSE embedded in plugin (port **3000**) *or* WebSocket via TS bridge (port **8091**). Widest engine range: **UE 5.0–5.8** (5.8 preview validated).
- **Tool inventory (23 consolidated "verb" meta-tools across 5 categories):**
  - *Core (8):* manage_asset, manage_blueprint, control_actor, control_editor, manage_level, system_control, inspect, manage_tools.
  - *World building (4):* build_environment, manage_level_structure, manage_geometry, manage_pcg.
  - *Gameplay (7+):* animation_physics, manage_effect, manage_gas, manage_character, manage_combat, manage_ai, manage_inventory, manage_interaction.
  - *Utility:* manage_audio, manage_sequence, manage_networking.
- **Maturity:** **759 stars, 143 forks, 890 commits, 23 releases** (v0.5.30, June 2026) — the most commit-active. MIT.
- **Standout:** Consolidated tool design (few tools, many params — token-efficient); capability-token auth (WS + HTTP); graceful degradation (server starts with no UE connection); 10s asset cache; pattern-based blocking of dangerous console commands; concurrent SSE sessions; runtime type discovery.
- **Gaps:** Coarse-grained tools push complexity into params (harder validation); pre-built binaries are UE-version-specific; Blueprint-only projects need a code target to compile the plugin.

## 3. GenOrca/unreal-mcp — the broadest feature surface
**Repo:** https://github.com/GenOrca/unreal-mcp

- **Architecture:** Python (76.5%) + thin C++ helper layer (22.7%) for APIs Python can't reach. New Python tools added without rebuilding the editor. UE **5.6+**. Apache-2.0.
- **Tool inventory: 253 actions across 21 domains** — actor (36), asset (21), material (20), blueprint (19), util (19), animation (17), umg (15), level_sequence (13), behavior_tree (12), editor (12), static_mesh (12), gas (11), data_table (8), level (7), control_rig (6), layer (6), retarget (6), anim_blueprint (4), game (3), texture (3), vision (3).
- **Maturity:** 120 stars, 16 forks, 9 releases (v2.2.0), 145 commits. **On Fab Marketplace.**
- **Standout:** Deepest coverage of any community project — Behavior Trees + Blackboard, UMG with event binding, material expression graphs, Level Sequence cinematics, Control Rig, IK retargeting, and a **vision system that renders on-image actor labels**. `execute_python` escape hatch for anything uncovered.
- **Gaps:** Lower star count vs breadth (less battle-tested per-tool); precompiled binaries engine-version-locked; no auth/security layer documented.

## 4. flopperam/unreal-engine-mcp (now → Aura) — the commercialization story
**Repo:** https://github.com/flopperam/unreal-engine-mcp · Commercial: https://www.tryaura.dev

- **Architecture (two models):** (a) **Hosted "Flop MCP"** — 50+ tools / 9 domains, HTTP at `agent.flopperam.com/mcp`, Bearer-token auth, separate C++ FlopAI plugin; (b) **Open-source local** — Python server, **stdio** transport, bundled C++ UnrealMCP plugin (C++ 59% / Python 40%). UE 5.5–5.7. MIT.
- **Tools:** scene building, actor management, physics & materials, foundational Blueprints (local); hosted adds full BP lifecycle (~40 node types), VFX, animation, landscape, cinematics, PCG, AI/Behavior Trees.
- **Maturity:** **1k stars, 194 forks, 97 commits.** Repo now redirects users to the commercial **Aura** agent.
- **Standout:** Only project with a hosted/SaaS tier and a clear OSS→commercial pivot. Broad client support (Cursor, Claude Code, Windsurf, VS Code Copilot, Cline).
- **Gaps:** OSS repo now effectively a funnel to paid Aura; deepest features gated behind hosted tier.

## 5. remiphilippe/mcp-unreal — the build/CI automation specialist (Go)
**Repo:** https://github.com/remiphilippe/mcp-unreal

- **Architecture:** Single **Go binary, zero external deps**, cross-platform (mac/Linux/Windows, amd64/arm64). Multiplexes **three backends:** headless `UnrealEditor-Cmd` subprocess (build/cook/test), Remote Control API HTTP (port **30010**), and an optional MCPUnreal editor plugin (port **8090**). Stdio JSON-RPC to client. UE **5.7 only**. Apache-2.0.
- **Tool inventory (49 tools):** build_project, cook_project, generate_project_files; run_tests/run_visual_tests/list_tests/get_test_log; spawn/delete/move actor, get/set property, call_function; blueprint + anim_blueprint query/modify; search_assets, material_ops; character_config, input_ops; pcg_ops, gas_ops, niagara_ops, procedural_mesh, realtime_mesh; level_ops, console, capture_viewport, pie_control, player_control; ism_ops, texture_ops, data_asset_ops, fab_ops, subsystem_query, ui_query, network_debug; lookup_docs / lookup_class (Bleve-indexed UE 5.7 docs).
- **Maturity:** Newest — **54 stars, 12 forks, only 4 commits.** Has CI + IMPLEMENTATION.md + CLAUDE.md system prompt.
- **Standout:** Only project covering the **full DevOps loop** (headless build/cook/test incl. visual tests, suitable for CI); **live indexed API-doc search**; PIE control + player teleport; no runtime deps.
- **Gaps:** Very young/unproven; UE 5.7-only; advanced tools need the optional plugin; no auto-save (manual level saves); long ops exceed 60s timeouts.

## 6. runreal/unreal-mcp — the no-plugin / pure-Python-RemoteExec approach
**Repo:** https://github.com/runreal/unreal-mcp · npm: `@runreal/unreal-mcp`

- **Architecture:** Node.js/TypeScript server driving Unreal's **built-in Python Remote Execution** — **no custom UE plugin required** (just enable Python Editor Script Plugin + Remote Execution). UE 5.4+. MIT. Distributed via `npx`.
- **Tool inventory (19 tools):** engine/project path get/set; asset list/export/info/references/search/validate; world outliner, map info, create/update/delete object; editor_run_python, console_command; take_screenshot, move_camera.
- **Maturity:** 111 stars, 26 forks. v0.1.1 (June 2025) — early.
- **Standout:** **Zero-plugin install** (lowest setup friction); exposes the *full* Python API surface; fast tool dev (no C++).
- **Gaps:** Thin curated toolset; relies entirely on Remote Exec port (network-exposure risk if bound to 0.0.0.0); no native engine introspection beyond Python.

## 7. kvick-games/UnrealMCP — early proof-of-concept (blender-mcp inspired)
**Repo:** https://github.com/kvick-games/UnrealMCP

- **Architecture:** C++ plugin, TCP port **13377**, Python + Claude Desktop client. Modeled on blender-mcp. UE 5.5 only. MIT.
- **Tools:** get_scene_info, create_object, delete_object, modify_object, **execute_python**. "Only basic operations."
- **Maturity:** "**VERY WIP**", Windows-only tested, author notes Claude "makes a lot of errors with Unreal Python." Largely superseded.
- **Standout/Gaps:** Historically important (one of the first), but minimal and stagnant; safety risk from raw AI file access.

## 8. Epic Games — official "Unreal MCP in Unreal Editor" (UE 5.8, experimental)
**Docs:** https://dev.epicgames.com/documentation/unreal-engine/unreal-mcp-in-unreal-editor

- **Architecture:** First-party plugin `ModelContextProtocol` embedded **in the editor process**. **HTTP + SSE only** (no stdio/WebSocket), binds `http://127.0.0.1:8000/mcp`, local-only, **no auth layer**. Tools execute **serially on the game thread**.
- **Tools (via separate AllToolsets plugin):** actor manipulation (spawn/transform/components), lighting, material-instance creation, Slate widget inspection, automation testing, GAS attributes (experimental GASToolsets). Tools authored in Python or C++ via a **Toolset Registry**; supports a **"Tool Search" discovery-meta-tool mode**.
- **Clients:** Claude Code, Cursor, VS Code, Gemini, Codex, MCP Inspector (auto config generation).
- **Significance:** Epic shipping official MCP fundamentally reshapes the landscape — community servers now compete with / must differentiate from a first-party baseline. Runtime availability extends to cooked/shipping builds via explicit API.

---

## Comparison Matrix

| Project | Transport / Stack | Plugin? | UE ver | Tools | Stars | License | Maturity | Niche |
|---|---|---|---|---|---|---|---|---|
| **chongdashu** | TCP 55557, C++ + Python FastMCP | Yes (C++) | 5.5+ | ~20 (actors/BP/graph/viewport) | ~2k | MIT | Experimental, very active forks | Reference impl, BP graph |
| **ChiR24** | HTTP/SSE 3000 or WS 8091, TS + C++ | Yes (C++) | 5.0–5.8 | 23 consolidated | 759 | MIT | 890 commits, most active | Auth, caching, widest UE range |
| **GenOrca** | MCP, Python + C++ helper | Yes (thin) | 5.6+ | **253 / 21 domains** | 120 | Apache-2.0 | On Fab, v2.2.0 | Broadest feature surface |
| **flopperam/Aura** | stdio (OSS) / HTTP+Bearer (hosted) | Yes (C++) | 5.5–5.7 | 50+ (hosted) | 1k | MIT | Commercialized → Aura | SaaS pivot |
| **remiphilippe** | stdio + 3 backends (cmd/RC API/plugin), Go | Optional | 5.7 only | 49 | 54 | Apache-2.0 | 4 commits, newest | Build/cook/test CI loop |
| **runreal** | Python Remote Exec, Node/TS | **No** | 5.4+ | 19 | 111 | MIT | v0.1.1 early | Zero-plugin setup |
| **kvick-games** | TCP 13377, C++ + Python | Yes (C++) | 5.5 | 5 | — | MIT | VERY WIP, stagnant | Historical PoC |
| **Epic official** | HTTP/SSE 8000, in-editor | First-party | 5.8 | toolset-driven | — | Epic EULA | Experimental | Official baseline |

---

## Cross-cutting analysis

**Three architecture families:**
1. *Custom C++ plugin + external server over TCP/HTTP/WS* (chongdashu, ChiR24, kvick, flopperam, GenOrca) — deepest engine access, but plugin must be rebuilt per UE version and needs a code target.
2. *No-plugin via Python Remote Execution* (runreal) — lowest friction, but limited to what the Python API exposes and no native introspection.
3. *Multi-backend orchestrator* (remiphilippe) — combines headless CLI + Remote Control API + optional plugin; uniquely covers build/test/cook.

**Tool-design philosophies diverge sharply:** ChiR24 collapses everything into ~23 high-level verbs (token-efficient, validation-light); GenOrca explodes into 253 fine-grained actions (discoverable, verbose). This is the central design tension in the space.

**Common gaps across nearly all community projects:**
- **Security/auth** — most bind localhost with no authentication (only ChiR24 and hosted Flop offer tokens; Epic explicitly ships *without* auth). Raw `execute_python` escape hatches (kvick, GenOrca, runreal, remiphilippe) give AI unrestricted editor access.
- **Validation / dry-run / undo** — virtually none expose plan-preview, constraint checking, or transactional rollback; failures mutate the live project.
- **PIE / runtime gameplay testing** — only remiphilippe (pie_control, player_control) and partially Epic (automation testing) address running the game; most are editor-time only.
- **Crash resilience** — none document game-thread deadlock/UAF protection; tools run on the game thread serially (Epic, chongdashu) creating timeout/hang exposure on long ops.
- **Version fragmentation** — precompiled C++ plugins are UE-version-locked (chongdashu, GenOrca, ChiR24, remiphilippe 5.7-only), a recurring maintenance burden the no-plugin (runreal) and Epic first-party approaches sidestep.

**Trajectory:** Epic's official UE 5.8 MCP and flopperam→Aura's commercialization signal the space is maturing past hobby plugins. Differentiation now hinges on what the official baseline lacks — auth/safety, validation/undo, PIE testing, crash resilience, and token-efficient tool ergonomics.

## Sources
- https://github.com/chongdashu/unreal-mcp · https://github.com/chongdashu/unreal-mcp/blob/main/Docs/README.md
- https://github.com/ChiR24/Unreal_mcp
- https://github.com/GenOrca/unreal-mcp
- https://github.com/flopperam/unreal-engine-mcp · https://www.tryaura.dev
- https://github.com/remiphilippe/mcp-unreal · https://mcpservers.org/servers/remiphilippe/mcp-unreal
- https://github.com/runreal/unreal-mcp · https://www.npmjs.com/package/@runreal/unreal-mcp
- https://github.com/kvick-games/UnrealMCP · https://github.com/kvick-games/UnrealMCP/blob/master/README.md
- https://dev.epicgames.com/documentation/unreal-engine/unreal-mcp-in-unreal-editor
- https://github.com/jl-codes/unreal-5-mcp · https://github.com/runeape-sats/unreal-mcp (additional notable forks) · https://ue-mcp.com/


## Cross-DCC MCPs (Blender/Houdini/Maya/Unity)

# Cross-DCC MCP Servers — Feature-Steal Research for an Unreal MCP

## 1. Per-DCC tool taxonomies (what's actually exposed)

### Blender — `ahujasid/blender-mcp` (~21 tools, the canonical reference)
Exact tool names (from `server.py`):
- **Scene query**: `get_scene_info`, `get_object_info`
- **Vision feedback**: `get_viewport_screenshot` (returns a PNG as an image content block)
- **Escape hatch**: `execute_blender_code` (arbitrary Python; README warns "ALWAYS save your work before using it")
- **Asset libraries (steal these)**: PolyHaven — `get_polyhaven_status`, `get_polyhaven_categories`, `search_polyhaven_assets`, `download_polyhaven_asset`, `set_texture`; Sketchfab — `search_sketchfab_models`, `get_sketchfab_model_preview` (thumbnail before download), `download_sketchfab_model`
- **AI 3D generation (steal these)**: Hyper3D/Rodin — `generate_hyper3d_model_via_text`, `generate_hyper3d_model_via_images`, `poll_rodin_job_status`, `import_generated_asset`; Hunyuan3D — `generate_hunyuan3d_model`, `poll_hunyuan_job_status`, `import_generated_asset_hunyuan`
- **Gating pattern**: every optional integration has a `get_*_status` probe so the agent checks availability before use
- **Workflow steering**: an MCP *prompt* `asset_creation_strategy` that tells the agent the preferred sourcing/creation order
- URLs: https://github.com/ahujasid/blender-mcp , https://github.com/ahujasid/blender-mcp/blob/main/src/blender_mcp/server.py

### Houdini — `healkeiser/fxhoudinimcp` (179 tools / 22 categories — most comprehensive) + `eliiik/houdini-mcp` (35 tools)
fxhoudinimcp categories worth stealing:
- **Graph Intelligence** (network building, verification, profiling) — validates a node graph before/after edits
- **Documentation** (full-text search + manual retrieval) — the *docs themselves are an MCP tool*, so the agent self-serves API knowledge
- **Rendering / Viewport-UI** (viewport capture, screenshots, **error detection**), **Scene Context** (network overview, selection, **error analysis**)
- **Workflows** (one-call Pyro/RBD/FLIP/Vellum setup, SOP chains, render config) — high-level "outcome" tools, not low-level node spam
- **VEX** (create/edit wrangles + `validate code`), **Takes** (overrides), **Cache** (list/inspect/clear/write)
- **Code Execution** (Python, HScript, expressions, env vars)
- Also ships **8 resources + 6 workflow prompts** alongside tools
- **Thread safety**: executes via `hdefereval.executeInMainThreadWithResult()` (no custom sockets) — analogous to Hayba's game-thread dispatch concern
- Simpler `eliiik` build groups into Connection / Scene Management / Node Ops / Parameters / Geometry Inspection / Transforms / Code Execution / Frame Control; notably has **no** screenshot, undo, or batch tools
- URLs: https://healkeiser.github.io/fxhoudinimcp/latest/ , https://github.com/eliiik/houdini-mcp , https://github.com/oculairmedia/houdini-mcp

### Maya — `PatrickPalmer/MayaMCP` (+ GG_MayaMCP variant)
- **Scene query**: `list_objects_by_type` (filter_by cameras/lights/materials/shapes)
- **Scene mgmt**: `scene_new`, `scene_open`, `scene_save`; **Selection**: `select_object`
- **Attributes**: `get_object_attributes`, `set_object_attributes`
- **Batched modeling verbs**: `mesh_operations` (extrude/bevel/subdivide/boolean/combine/bridge/split), `curve_modeling` (extrude/loft/revolve/sweep)
- **Parametric prefab generators (steal this idea)**: `create_advanced_model` ("cars, trees, buildings, cups, chairs"), `generate_scene` (whole multi-object scenes), `organize_objects` (group/parent/align/distribute)
- No viewport capture / undo / arbitrary-code in PatrickPalmer's build; the GG_MayaMCP variant adds **viewport capture** plus skinning/animation/scripts
- URLs: https://github.com/PatrickPalmer/MayaMCP , https://gimbalgoats.com/blog/what-is-maya-mcp

### Unity — `AnkleBreaker-Studio/unity-mcp-server` (268–288 tools / 30+ cats), `ozankasikci/unity-editor-mcp` (62/11), `CoplayDev/unity-mcp`
Richest surface of all four DCCs:
- **Scene/hierarchy**: open/save/create scenes, **full hierarchy tree with pagination**; create/delete/duplicate/reparent/activate GameObjects
- **Components & wiring**: add/remove components, get/set serialized properties, **wire object references + batch wiring**
- **Assets**: list/import/delete/search, **prefab creation**
- **Build system**: multi-platform (Windows/macOS/Linux/Android/iOS/WebGL)
- **Profiling/Debugging**: profiler control, frame debugger, memory profiler
- **Graphics**: Shader Graph create/inspect/open, Amplify node manipulation
- **Terrain / NavMesh / Physics**: heightmaps/layers/trees, NavMesh bake + agents/obstacles, raycast/spherecast/overlap
- **Animation**: controllers, clips, parameters
- **Visual inspection**: scene + game view capture as **inline images**
- **Editor**: undo/redo category; play-mode control; console/log reading; menu-item execution; **Roslyn script validation**
- **Progressive disclosure**: CoplayDev exposes **tool groups (vfx / animation / ui / testing)** you toggle in advanced settings
- URLs: https://github.com/AnkleBreaker-Studio/unity-mcp-server , https://github.com/ozankasikci/unity-editor-mcp , https://github.com/CoplayDev/unity-mcp , https://coplaydev.github.io/unity-mcp/ , https://github.com/IvanMurzak/Unity-MCP

## 2. Categories an Unreal MCP should match (with who does it + the gap)

| Category | Best-in-class exemplar | Steal / gap note for Hayba |
|---|---|---|
| **Scene query/inspection** | Unity hierarchy-tree-with-pagination; Houdini scene-context overview | Table stakes — match, and paginate large outputs |
| **Asset libraries** | Blender (PolyHaven + Sketchfab search→preview→download) | Strong steal: wire Quixel/Fab/Sketchfab; add `get_*_status` gating + thumbnail-preview-before-import |
| **AI asset/scene generation** | Blender (Hyper3D/Hunyuan text+image→3D, async poll+import); Maya (`create_advanced_model`, `generate_scene`) | Hayba's known gap (3D-gen, text→world). Async job pattern (generate→poll→import) is the template |
| **Screenshot/vision feedback loop** | Blender `get_viewport_screenshot`; Unity scene+game inline images; Houdini viewport capture + error detection | Match: return PNG as image content block; Hayba's SceneCapture spikes already prove the pipeline |
| **Viewport/camera control** | Blender (point-camera/isometric); Unity; Houdini panes | Add explicit "frame the subject" tools so vision loop gets useful shots |
| **Undo / transaction safety** | Only Unity (undo/redo); everyone else weak/absent | **Biggest differentiation lever** — most DCC MCPs have *no* transaction model. Hayba's crash-resilience + dry-run/undo is a genuine moat to lean into |
| **Batch ops** | Unity batch-wiring; Houdini one-call Workflows; Maya `mesh_operations` | Prefer few high-level "outcome" verbs over many low-level calls |
| **Code-execution escape hatch** | Blender `execute_blender_code`; Houdini Python/HScript | Hayba already has gated `python_run`; keep the safety gating (dangling-delegate/TCP lessons) |
| **In-MCP documentation/self-help** | Houdini Documentation (full-text manual search) | Novel + underused — expose Unreal API/PLUMB docs *as a tool* so the agent self-serves |
| **Graph/script validation** | Houdini Graph Intelligence + VEX validate; Unity Roslyn validation | Aligns with Hayba's PLUMB validator — validate before/after mutate is a recognized pattern |
| **Build / profiling** | Unity (multi-platform builds, profiler/frame/memory) | Mostly Unity-only; lower priority but a differentiator vs other UE MCPs |

## 3. MCP server design best practices (general)

- **Outcomes over operations**: design tools around the agent's goal, not API endpoints; one `track_order(email)` that internally calls three things beats three primitives (philschmid; The New Stack).
- **Ruthless curation / namespacing**: 5–15 focused tools per server, "one server, one job"; service-prefixed `{service}_{action}_{resource}` names (e.g. `slack_send_message`) to avoid cross-server ambiguity (philschmid).
- **Progressive tool disclosure**: publish tool list + optional capabilities (elicitation, structured content) at handshake so clients adapt; gate large surfaces behind tool groups (Unity's vfx/animation/ui/testing toggles) and status-probe tools (Blender's `get_*_status`) (MCP spec 2025-06-18).
- **Structured output**: use the June-2025 `outputSchema` + `structuredContent` fields for typed results, and for backward-compat also emit the serialized JSON in a `TextContent` block; clients validate but keep unstructured fallback (modelcontextprotocol.io tools spec; Cisco "what's new in MCP").
- **Image / content blocks**: return MIME-typed content blocks so clients render images/audio/files — the viewport-screenshot → image-content pattern (Blender, Unity, Houdini) is the proven vision-feedback loop.
- **Error ergonomics**: return actionable strings the agent can self-correct on ("User not found, try searching by email") plus machine-readable codes — not raw exceptions (philschmid; The New Stack).
- **Flatten arguments**: top-level primitives + constrained enums (`Literal[...]`) over deep nested objects the model misreads (philschmid).
- **Pagination + metadata**: respect a `limit` (default 20–50), return `has_more` / `next_offset` / `total_count`; never dump full result sets into context (philschmid) — note Unity's paginated hierarchy tree as the DCC-specific application.
- **Token efficiency + human-in-the-loop**: every tool description competes for context budget; keep a human able to deny tool invocations (MCP spec; philschmid).

Sources:
- https://github.com/ahujasid/blender-mcp , https://github.com/ahujasid/blender-mcp/blob/main/src/blender_mcp/server.py
- https://healkeiser.github.io/fxhoudinimcp/latest/ , https://github.com/eliiik/houdini-mcp , https://github.com/oculairmedia/houdini-mcp
- https://github.com/PatrickPalmer/MayaMCP , https://gimbalgoats.com/blog/what-is-maya-mcp
- https://github.com/AnkleBreaker-Studio/unity-mcp-server , https://github.com/ozankasikci/unity-editor-mcp , https://github.com/CoplayDev/unity-mcp , https://coplaydev.github.io/unity-mcp/ , https://github.com/IvanMurzak/Unity-MCP
- https://modelcontextprotocol.io/specification/2025-06-18/server/tools , https://www.philschmid.de/mcp-best-practices , https://thenewstack.io/15-best-practices-for-building-mcp-servers-in-production/ , https://blogs.cisco.com/developer/whats-new-in-mcp-elicitation-structured-content-and-oauth-enhancements

---

# Internal Audit Reports


## Current tool inventory

Complete inventory compiled from `mcp-tools/hayba-mcp/src/tools/index.ts` (registerToolsCore + STANDARD_DESCRIPTORS + recordEagerSchemas) and `src/tools/routing/register.ts` (deferred-mode meta-tools). Backing verified by sampling handlers (`executeCommand('<cmd>')` = C++ TCP handler marshalled to game thread; `runUePythonJson` via `ue-python.ts` = python_run-backed; `fetch` = pure-Node).

# Hayba MCP Tool Inventory — authoritative baseline

GRAND TOTAL: **126 distinct MCP tools** registered via `server.tool(...)`.
- 111 in `registerToolsCore` (index.ts)
- 15 added only in `toolRouting:'deferred'` mode (routing/register.ts)

Backing legend: **[C++]** = UE C++ plugin handler over TCP/game-thread; **[PY]** = generated UE Python via python_run; **[TS]** = pure Node/TypeScript (no UE); **[HTTP]** = pure-Node external HTTP (+ UE import on download).

---

## A. Code-mode / meta entry points — 5 (always-on, registered before the codeMode gate)
- `list_tool_categories` [TS]
- `get_tool_signature` [TS]
- `python_run` [C++] — the UE Python escape hatch itself (executeCommand 'python_run'); de-facto API surface
- `hayba_propose_plan` [C++] (executeCommand 'hayba_propose_plan') — Plan-mode control
- `hayba_mark_plan_step` [C++] (executeCommand 'plan_mark_step') — Plan-mode control

## B. World generation — 1
- `world_generate` [C++ orchestrator] — eager via STANDARD_DESCRIPTORS; also always-on in deferred mode; multiple executeCommand + PLUMB validate

## C. Actor — 4 (all [C++])
- `actor_spawn`, `actor_list`, `actor_delete`, `actor_transform`

## D. Material — 20 (all [C++]); 6 instance-layer + 14 graph-layer
Instance: `material_create`, `material_create_instance`, `material_set_param`, `material_apply`, `material_list`, `material_get_info`
Graph: `material_add_node`, `material_set_node`, `material_delete_node`, `material_set_property`, `material_compile`, `material_validate`, `material_add_comment`, `material_delete_comment`, `material_set_comment`, `material_add_reroute_declaration`, `material_add_reroute_usage`, `material_connect_nodes`, `material_function_create`, `material_disconnect`

## E. Texture — 4 (all [C++]) (interleaved into STANDARD_DESCRIPTORS)
- `texture_get_info`, `texture_set_compression`, `texture_set_settings`, `texture_list`

## F. Asset — 1 (exposed)
- `asset_delete` [C++]
- (Schema-only, NOT exposed as tools — only `reg()`'d for get_tool_signature/hayba_invoke discovery, reachable via hayba_invoke→C++ legacy: `asset_move`, `asset_fix_redirectors`, `asset_get_dependencies`, `asset_get_referencers`)

## G. Scene — 2 (all [C++], via ensureConnected raw TCP)
- `scene_export`, `scene_validate_physics`

## H. Editor — 6 (all [C++])
- `editor_capture_viewport` (raw TCP), `editor_start_pie`, `editor_stream_log`, `wait_for_shaders`, `wait_for_idle`, `render_camera`

## I. Introspect (HANDOFF agent-ergonomics) — 1
- `hayba_introspect` [PY] (runUePythonJson)

## J. PCG primitives (HANDOFF agent-ergonomics) — 5
- `pcg_add_node` [PY], `pcg_set_prop` [PY], `pcg_wire` [PY], `pcg_inspect_instances` [PY], `pcg_cook_and_wait` [PY + C++] (python primitives + executeCommand)

## K. Fab connectors — 4 (all [C++], executeCommand 'fab_*')
- `hayba_fab_login_status`, `hayba_fab_library_list`, `hayba_fab_marketplace_search`, `hayba_fab_download`

## L. Asset-source connectors — 6 ([HTTP], downloads UE-import via executeCommand)
- `hayba_polyhaven_search`, `hayba_polyhaven_download`, `hayba_ambientcg_search`, `hayba_ambientcg_download`, `hayba_sketchfab_search`, `hayba_sketchfab_download`

## M. PCGEx — 17 (mostly [TS]; create/export/execute reach C++ legacy PCG handlers)
- `hayba_search_node_catalog` [TS], `hayba_get_node_details` [TS], `hayba_create_pcg_graph` [TS→C++], `hayba_validate_pcg_graph` [TS], `hayba_list_pcg_assets` [TS→C++], `hayba_export_pcg_graph` [C++], `hayba_execute_pcg_graph` [C++], `hayba_check_ue_status` [TS probe; also ALWAYS_ON, re-registered with onConnected autoload in deferred], `hayba_scrape_node_registry` [TS/SQLite], `hayba_match_pin_names` [TS], `hayba_validate_attribute_flow` [TS], `hayba_diff_against_working_asset` [TS], `hayba_format_graph_topology` [TS], `hayba_abstract_to_subgraph` [TS], `hayba_parameterize_graph_inputs` [TS], `hayba_query_pcgex_docs` [TS], `hayba_initiate_infrastructure_brainstorm` [TS]

## N. Conventions — 2 ([TS], filesystem only)
- `hayba_setup_conventions`, `hayba_analyze_conventions`

## O. Zone painter — 3 ([TS], talk to local web service via fetch)
- `hayba_open_zone_painter`, `hayba_read_zones`, `hayba_set_painter_heightmap`

## P. Validator — 6 ([TS] rule engine; validator_run optionally reaches UE via ensureConnected)
- `validator_run`, `validator_history`, `validator_resolve`, `validator_clear`, `validator_rules`, `validator_set_rule_enabled`

## Q. PLUMB constraint subsystem — 23 ([TS]; profile_bake also calls C++ mesh_get_info; segment uses visual SAM sidecar)
- `plumb_primitives`, `plumb_profile_bake`, `plumb_profile_annotate`, `plumb_profile_list`, `plumb_profile_get`, `plumb_constraint_define`, `plumb_constraint_list`, `plumb_constraint_remove`, `plumb_constraint_propose`, `plumb_validate`, `plumb_mask_add`, `plumb_mask_remove`, `plumb_lesson_add`, `plumb_lesson_list`, `plumb_lesson_remove`, `plumb_study`, `plumb_study_take`, `plumb_segment`, `plumb_production_define`, `plumb_production_list`, `plumb_production_remove`, `plumb_socket_add`, `plumb_grammar_expand`

## R. Landscape — 1
- `hayba_import_landscape` [C++] — TS wrapper over UE-side `landscape_import` legacy handler

**Subtotal A–R (registerToolsCore): 111**

---

## S. Deferred-routing meta-tools — 15 (registered ONLY when `settings.toolRouting === 'deferred'`, in routing/register.ts; all [TS])
- Tool/pack routing (4): `hayba_search_tools` (BM25+embedding tool index), `hayba_pack_list`, `hayba_pack_load`, `hayba_invoke` (polymorphic dispatcher → captured TS handler or executeCommand C++/python)
- Asset retriever (3): `hayba_asset_search`, `hayba_asset_browse`, `hayba_asset_reindex`
- Slivers (4): `hayba_sliver_list`, `hayba_sliver_get`, `hayba_sliver_run` (+UE bridge), `hayba_sliver_import`
- DAG / journal (4): `hayba_dag_status`, `hayba_dag_record`, `hayba_dag_rebuild`, `hayba_journal_tail`

**Subtotal S: 15**

---

## Per-domain count table
| Domain | Count | Backing |
|---|---|---|
| A. Code-mode/meta | 5 | TS + C++ |
| B. World | 1 | C++ orchestrator |
| C. Actor | 4 | C++ |
| D. Material | 20 | C++ |
| E. Texture | 4 | C++ |
| F. Asset | 1 (+4 schema-only) | C++ |
| G. Scene | 2 | C++ |
| H. Editor | 6 | C++ |
| I. Introspect | 1 | PY |
| J. PCG primitives | 5 | PY (+C++) |
| K. Fab | 4 | C++ |
| L. Asset-sources | 6 | HTTP |
| M. PCGEx | 17 | TS (+C++ legacy) |
| N. Conventions | 2 | TS |
| O. Zone painter | 3 | TS |
| P. Validator | 6 | TS |
| Q. PLUMB | 23 | TS |
| R. Landscape | 1 | C++ |
| S. Deferred routing | 15 | TS |
| **TOTAL** | **126** | |

Backing split: **~48 C++-backed**, **6 python_run-backed** (hayba_introspect + 5 pcg_* primitives; pcg_cook_and_wait is hybrid), **6 HTTP**, **~66 pure-TS** (PCGEx, conventions, zone-painter, validator, PLUMB, routing/asset/sliver/dag meta-tools), plus python_run itself as the universal escape hatch.

---

## Exposure modes (which subset is eagerly listed)
- **Code Mode ON (default; `config.codeMode`, the registerToolsCore early return at line 887):** only the 5 domain-A meta tools are eagerly exposed; all other 106 are discovered on demand via `get_tool_signature` + invoked via `python_run`. Their schemas are still recorded (recordEagerSchemas runs unconditionally).
- **Code Mode OFF (`HAYBA_CODE_MODE=off`):** all 111 registerToolsCore tools exposed eagerly.
- **Deferred (`toolRouting:'deferred'`):** the shim captures every tool but registers natively only the 48-name `ALWAYS_ON_META` set (meta + world_generate + check_ue_status + asset/sliver/dag/journal/search/pack/invoke + 6 validator + 23 plumb) plus the 15 domain-S meta-tools; everything else is gated behind `hayba_pack_load` / reachable via `hayba_invoke`. Note `python_run`, `hayba_propose_plan`, `hayba_mark_plan_step` are NOT in the deferred always-on set (only via pack/invoke).

## Disabled / parked (commented out in index.ts, NOT counted)
Gaea + terrain + knowledge block (lines ~1402–1626) and `hayba_ue_landscape_pipeline`: `hayba_search_gaea_archetypes`, `hayba_get_full_archetype_graph`, `hayba_query_gaea_knowledge`, `hayba_brainstorm_gaea`, `hayba_bake_terrain`, `hayba_create_terrain`, `hayba_open_in_gaea`, `hayba_read_terrain_variables`, `hayba_set_terrain_variables`, `hayba_open_session`, `hayba_close_session`, `hayba_add_node`, `hayba_remove_node`, `hayba_connect_nodes`, `hayba_get_graph_state`, `hayba_get_parameters`, `hayba_set_parameter`, `hayba_list_node_types`, `hayba_cook_graph`, `hayba_ue_landscape_pipeline` (~20 disabled).

Relevant files: `D:/Hackathons/hayba/mcp-tools/hayba-mcp/src/tools/index.ts` (registrations + STANDARD_DESCRIPTORS + recordEagerSchemas), `D:/Hackathons/hayba/mcp-tools/hayba-mcp/src/tools/routing/register.ts` (deferred meta-tools + ALWAYS_ON_META), `D:/Hackathons/hayba/mcp-tools/hayba-mcp/src/tools/ue-python.ts` (python_run-backed helper).


## Capability-gap analysis

I have a complete picture: ~70 first-class MCP tools, ~200 C++ commands across 36 handlers (most reachable only via `hayba_invoke via:ue_legacy` against a 73-command sidecar allowlist, not as schema'd tools), and `python_run` as the universal hatch. Key confirmation: `blueprint_add_node` returns `not_implemented_in_v1` (K2 graph authoring is a stub). Here is the gap analysis.

---

# Hayba UE MCP — Capability-Gap Analysis

## Framing: three tiers of "coverage"
The repo has THREE distinct surfaces, and "missing" means different things at each:
1. **First-class MCP tools** (`server.tool()` in `tools/index.ts`, ~70): heavily weighted to material (~22), PLUMB (~28), PCGEx (~16), actor(4), texture(4), asset-sources(6), plus world_generate/scene/editor/render/fab. This is what an agent sees with full schemas, validation, niche briefings, PLUMB auto-correct.
2. **C++ handlers that EXIST but have NO schema'd tool** — reachable only via `hayba_invoke {via:'ue_legacy'}` (allowlist in `legacy-commands/sidecar.json`) or `python_run`. ~22 whole domains live here: `blueprint_* seq_* anim_* niagara_* metasound_* gas_* bt_* foliage_* spline_* wp_* ism_* physics_* input_* ui_* net_* level_* build_* test_* data_* project_* audio_* docs_*` plus actor/asset/mesh extras. `list_tool_categories` advertises them but flags them not-callable-as-tool.
3. **Genuinely absent** — no C++ handler, no tool: Lighting/Lumen, Nanite, ControlRig, Data Layers, Chaos/destruction, PhysicsAsset, transactions/undo, Interchange import config, MoviePipeline render, landscape sculpt/paint.

**The single biggest structural gap is tier-2→tier-1 wrapper debt:** ~100 working C++ commands with zero first-class tools. That's cheap surface (thin TS wrappers + schema + sidecar entry), not net-new engine work.

Below, each area lists: current state, what's missing, est. tools, and feasibility (PY = `python_run`-feasible / C++ = needs native code / MIX).

---

## 1. Blueprint authoring — **CRITICAL GAP** (handler exists, core is a stub)
- **Have (C++, invoke-only):** `blueprint_create / add_component / add_variable / add_function / add_event / compile / get_info / document / set_defaults / connect_nodes`. No first-class tools at all.
- **STUB:** `blueprint_add_node` returns `"not_implemented_in_v1"` (`HaybaMCPBlueprintHandler.cpp:345`). So the actual valuable part — K2 graph node authoring — does not work. `connect_nodes` is near-useless without nodes to connect.
- **Missing:** K2 node spawning (UK2Node_CallFunction, Variable get/set, Branch/Sequence/ForEach, math/cast/MakeStruct, custom events, timelines, event dispatchers), pin wiring, component hierarchy/attachment, construction script logic, Blueprint Interfaces, Function/Macro Libraries, child BP creation, BP→C++ nativization hints.
- **Est tools:** 12–18. **Feasibility: C++** (UnrealEd K2 graph APIs are essentially absent from Python; `BlueprintEditorLibrary` is thin). This is the hardest high-value domain and currently the largest false-advertised capability.

## 2. Sequencer / Cinematics
- **Have (C++, invoke-only):** `seq_create / add_track / add_keyframe / add_camera_cut / set_playback_range / play / export / get_info` (mature, 449 lines).
- **Missing:** possessable/spawnable binding, more track types (skeletal-animation, audio, material-parameter-collection, attach, event, fade, transform tangents, subsequence/shot tracks), keyframe interpolation/tangent control, and especially **MoviePipeline / MRQ automated render-to-disk** (the cinematics payoff).
- **Est tools:** 8–12 beyond current. **Feasibility: PY** (`unreal.MovieScene*`, `MoviePipelineQueueEngineSubsystem` are well-exposed; render is async/needs idle-gating).

## 3. Niagara — **hard ceiling**
- **Have (C++, invoke-only):** `niagara_list / spawn / set_param` — runtime spawn + user-parameter override only.
- **Missing:** system/emitter/module **authoring** (create from template, add emitter, spawn-rate, renderers, modules). 
- **Est tools:** 4–8. **Feasibility: C++, LOW** — Niagara has almost no Python/editor authoring API; even C++ emitter authoring is unstable across versions. Realistic ceiling = instantiate-from-template + param packs (mostly already present). Flag as a known engine limitation, not a quick win.

## 4. Landscape sculpt/paint — big gap (only import exists)
- **Have:** `hayba_import_landscape` (C++ `ALandscape::Import`; per project memory, Python spawn is a placeholder stub).
- **Missing:** heightmap sculpt/edit-layers, **weightmap (paint-layer) authoring** for material layers, landscape splines (roads/rivers), LandscapeGrassType, add/remove/resize components, import multiple weightmap layers, runtime virtual texture wiring, Nanite landscape.
- **Est tools:** 6–10. **Feasibility: MIX** — heightmap blob math PY; weightmap paint + edit layers + splines = **C++** (`FLandscapeEditDataInterface`, `LandscapeEditLayers`).

## 5. Foliage
- **Have (C++, invoke-only):** `foliage_add_instance / remove_instances / list_types / paint_at`.
- **Missing:** FoliageType **asset authoring** (density, scale range, align-to-normal, collision, cull distance), procedural foliage spawners, grass types, paint-by-mask/landscape-layer, scatter-on-actors.
- **Est tools:** 4–6. **Feasibility: PY** (`FoliageEditorLibrary`, `InstancedFoliageActor`, `FoliageType` are reflected).

## 6. Physics / Chaos — broad gap
- **Have (C++, invoke-only):** `physics_set_simulate / set_collision_profile / add_impulse` (runtime-ish).
- **Missing:** **PhysicsAsset** authoring (bodies + constraints for skeletals), **Chaos destruction** (GeometryCollection from meshes, fracture/cluster/fields), cloth, physical materials, collision-primitive generation (UCX / convex decomposition / auto-convex), constraint actors, ragdoll setup.
- **Est tools:** 8–12. **Feasibility: MIX** — physical-material + collision-profile PY; PhysicsAsset + GeometryCollection fracture/fields = **C++** (limited Python).

## 7. Animation / ControlRig — broad gap
- **Have (C++, invoke-only):** `anim_blueprint_get_info / add_state / add_transition / set_condition / compile` (state-machine authoring, 454 lines).
- **Missing:** **ControlRig entirely** (rig graph, controls, FK/IK — none); AnimSequence import/**IK Retargeter**/retarget; **AnimMontage** authoring (sections, slots, notifies); anim-graph nodes (blend spaces, layered blend, blend-by-bool/enum); Skeleton sockets/virtual bones; **BlendSpace** assets; AnimNotify tracks; Pose assets.
- **Est tools:** 10–15. **Feasibility: MIX** — Montage/Sequence/Notify/BlendSpace PY; **ControlRig = C++** (no meaningful Python authoring API).

## 8. Audio / MetaSounds — relatively well-covered
- **Have (C++, invoke-only):** `metasound_create / add_node / connect / set_input / compile / list` (graph authoring exists!), `audio_play / list / set_volume`.
- **Missing:** SoundCue graph authoring, Sound Class/Mix/**Submix** routing, Attenuation-settings assets, audio components on actors, MetaSound presets/param packs, source/submix effect chains, Quartz.
- **Est tools:** 5–8. **Feasibility: PY** (`USoundCue`, `USoundSubmix`, attenuation are reflected; MetaSound graph already C++).

## 9. UMG / Widgets — minimal
- **Have (C++, invoke-only):** `ui_create_widget / add_element / query` (369 lines, basic).
- **Missing:** real widget-tree authoring (CanvasPanel/VerticalBox/Grid/Overlay + slot layout/anchors), property binding, **widget animations**, event bindings (Blueprint-graph territory → blocked by §1 stub), styling, named slots, compile.
- **Est tools:** 6–10. **Feasibility: MIX** — tree + slots partly PY (`WidgetBlueprint`/`WidgetTree`, awkward); graph event-bindings = **C++**.

## 10. World Partition / Data Layers — read-only today
- **Have (C++, invoke-only):** `wp_get_cells / load_cell / get_streaming_state` (read/stream only, 144 lines).
- **Missing:** **Data Layer asset create/assign/state**, HLOD setup+build, WP conversion, **Level Instances / Packed Level Actors**, minimap, landscape-WP, runtime grids config.
- **Est tools:** 6–10. **Feasibility: MIX** — Data Layers + Level Instances PY (`DataLayerEditorSubsystem`, `EditorLevelUtils`); HLOD build = **C++/commandlet**.

## 11. Lighting / Lumen — **absent**
- **Have:** nothing dedicated (lights spawnable via raw `actor_spawn`).
- **Missing:** light-actor param helpers, **Lumen scene config** (PostProcessVolume GI/reflections, project settings), **GPU Lightmass / static bake**, SkyAtmosphere/ExponentialHeightFog/VolumetricCloud/SkyLight setup presets, reflection-capture place+build, light environment presets, exposure/auto-exposure.
- **Est tools:** 6–10. **Feasibility: PY** (all reflected UPROPERTIES; bake triggers via editor subsystem/console). Easy, high-value win.

## 12. Nanite — **absent, trivial win**
- **Missing:** enable/disable Nanite on StaticMesh, Nanite settings (fallback %, position precision, preserve area), batch-enable across asset set, Nanite for foliage/landscape.
- **Est tools:** 2–3. **Feasibility: PY** (`StaticMesh.nanite_settings` + `build`). Lowest-effort gap in the whole list.

## 13. PIE / gameplay testing — handlers exist, not surfaced
- **Have (C++):** `editor_start_pie` (tool) + `editor_stop_pie / pie_press_key / pie_screenshot / pie_wait_for / pie_assert` (invoke-only; PIEHandler is mature, 520 lines).
- **Missing first-class:** input injection, gameplay assertions, **live actor/game-state read during PIE**, possess pawn, time/slomo control, simulate-vs-play, **Functional Test / Gauntlet / automation** runner integration, spawn-at-runtime.
- **Est tools:** 6–10 (mostly TS wrappers over existing C++ + a few new). **Feasibility: MIX** — wrappers cheap; new state-read on game thread = **C++** (note the game-thread dispatch deadlock hazard in project memory).

## 14. Packaging / Cook
- **Have (C++, invoke-only):** `build_project / build_cook / generate_project_files` (BuildHandler, 419 lines).
- **Missing:** per-platform cook config, staging/packaging via **BuildCookRun/UAT**, DLC/chunking, content-validation pre-cook, build-target selection, Insights/trace capture.
- **Est tools:** 4–6. **Feasibility: MIX** — UAT is subprocess (PY blocked by Tier-3 sandbox; better as C++/external runner).

## 15. Asset import pipelines
- **Have (C++):** `asset_import`, `asset_search / get_info / duplicate / rename / move / validate / fix_redirectors / get_dependencies / get_referencers` (mature; some as schema'd tools, most invoke-only).
- **Missing:** **Interchange pipeline config** (FBX/glTF/USD: materials, collision, LODs, skeleton, morph targets), **USD stage** workflows, Datasmith, reimport, bulk import with per-type rules, texture-import presets, asset-actions automation.
- **Est tools:** 6–10. **Feasibility: PY** (`AssetImportTask`, `InterchangePipeline`, `UsdStageActor` reflected).

## 16. Transactions / Undo — **absent, flagged in project memory**
- **Missing:** transaction wrapping (`FScopedTransaction`) around mutating handlers, **undo/redo tools**, checkpoint/rollback, dry-run→commit pattern (only `world_generate` has dry_run).
- **Est tools:** 3–5 (begin/end transaction, undo, redo, checkpoint/restore). **Feasibility: C++** for robustness — needs every mutating C++ handler wrapped in a transaction; Python `ScopedEditorTransaction` exists but won't capture the existing C++ handler mutations. This is the highest-leverage *cross-cutting* gap (enables safe agent experimentation).

## 17. Multi-select / batch ops — partial, easy win
- **Have:** `actor_batch_spawn`, `ism_add_instances`, `actor_call_function`.
- **Missing:** editor **selection management** (get/set selection, select-by-query/class/tag/material), batch transform/property-set across selection, batch rename, batch material-assign, align/distribute/snap-many, group/attach, find-replace-actor-class. (Roblox MCP peer has `mass_set_property / mass_duplicate / search_by_property / bulk_set_attributes` — Hayba lacks equivalents.)
- **Est tools:** 6–10. **Feasibility: PY** (`EditorActorSubsystem` selection + loops). High-value, cheap.

## 18. Vision / screenshot feedback — strongest area, minor gaps
- **Have:** `editor_capture_viewport`, `render_camera` (verifies file), `editor_pie_screenshot`, visual sidecar (`hayba_compare_clip_score`, `generate_moodboard`, `fetch_references`, `plumb_segment`/SAM), SceneCapture world-pos pass.
- **Missing:** multi-angle **orbit/turntable** capture, per-asset **thumbnail** generation, auto-frame/auto-focus on actor bounds, **buffer-visualization passes** (depth/wireframe/normals/basecolor/overdraw), before/after diff capture, annotation/highlight overlays, viewport-bookmark capture.
- **Est tools:** 4–8. **Feasibility: MIX** — orbit/thumbnail/auto-frame PY; buffer passes / scene-capture = **C++** (spike exists per memory).

---

## Cross-cutting / smaller domains also under-surfaced (C++ exists, no tools)
- **Level/World mgmt:** `level_load/save/create/list/get_info/get_spatial_index/set_bookmark/goto_bookmark` (8, invoke-only) — needs first-class wrappers + sublevel/streaming authoring. PY/MIX.
- **AI:** `bt_*` (4) exist; missing Blackboard authoring, EQS, AIController/NavMesh/nav-modifier setup. MIX.
- **Splines/roads:** `spline_*` (5) exist; missing **SplineMeshComponent** deform (roads/fences/pipes) + landscape splines. PY.
- **GAS:** `gas_*` (4) exist (invoke-only); missing attribute-set authoring, gameplay-cue, ability-graph (BP-graph dependent). MIX.
- **Enhanced Input:** `input_*` (3) exist (invoke-only) — wrap + add modifiers/triggers. PY.
- **Networking:** `net_*` (2) exist. Niche.
- **Data assets / project / docs / test:** `data_* project_* docs_* test_*` exist invoke-only — cheap wrappers.

---

## Summary scoreboard (rough)

| Area | Engine reachability | Net-new tools | Primary effort |
|---|---|---|---|
| Blueprint K2 graph | hard (stub now) | 12–18 | **C++** |
| Sequencer + MRQ render | good | 8–12 | PY |
| Niagara authoring | very hard | 4–8 | **C++ (low ceiling)** |
| Landscape sculpt/paint | medium | 6–10 | **C++**/MIX |
| Foliage assets | good | 4–6 | PY |
| Physics/Chaos | medium-hard | 8–12 | MIX/**C++** |
| Animation/ControlRig | mixed | 10–15 | MIX/**C++** |
| Audio/SoundCue/Submix | good | 5–8 | PY |
| UMG widgets | medium | 6–10 | MIX |
| World Partition/Data Layers | good | 6–10 | MIX |
| Lighting/Lumen | good | 6–10 | **PY (easy win)** |
| Nanite | trivial | 2–3 | **PY (easiest win)** |
| PIE/gameplay test | exists, unsurfaced | 6–10 | MIX |
| Packaging/cook | exists | 4–6 | MIX |
| Asset import (Interchange/USD) | good | 6–10 | PY |
| Transactions/undo | absent | 3–5 | **C++ (highest leverage)** |
| Multi-select/batch | partial | 6–10 | **PY (cheap, high-value)** |
| Vision feedback | strong | 4–8 | MIX |
| Level/AI/Spline/GAS/Input wrappers | exist, unsurfaced | ~30 | PY/MIX |

**Total addressable:** ~140–190 net-new tools, of which roughly half are thin TS wrappers over already-working C++ (sidecar `via:ue_legacy` debt).

## Recommended prioritization
1. **Quick PY wins (days):** Nanite (2–3), Lighting/Lumen (6–10), Multi-select/batch + selection (6–10), Foliage assets (4–6), Asset-import/Interchange (6–10). All `python_run`-feasible, no rebuild.
2. **Surface the tier-2 debt:** schema'd TS wrappers + sidecar entries for `level_* seq_* anim_* foliage_* spline_* physics_* input_* ui_* gas_* bt_* data_* project_* build_* test_*` (≈100 commands already in C++). Cheap, immediately expands honest tool catalog.
3. **High-leverage C++:** transactions/undo (unlocks safe agent experimentation), then fix the **Blueprint `add_node` stub** (the largest false-advertised capability).
4. **Accept ceilings:** Niagara and ControlRig authoring are genuine UE Python limitations — scope them to template-instantiation + param overrides rather than full graph authoring.

Relevant files: `D:/Hackathons/hayba/mcp-tools/hayba-mcp/src/tools/index.ts` (tool registry), `D:/Hackathons/hayba/mcp-tools/hayba-mcp/src/tools/code-mode/list-tool-categories.ts` (advertised vs callable), `D:/Hackathons/hayba/mcp-tools/hayba-mcp/src/legacy-commands/sidecar.json` (invoke allowlist), `D:/Hackathons/hayba/unreal/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/handlers/HaybaMCPBlueprintHandler.cpp:345` (the `not_implemented_in_v1` stub).


## In-editor AI chat revival

I have the complete picture. Here is the dense report.

---

# Reviving the in-editor AI chat panel (BYOK) — findings + revival spec

## 1. Where the code lived / current state

### A. In-editor C++ Slate panel — STILL IN TREE, dormant, slimmed
- `SHaybaMCPChatPanel` — `unreal/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/HaybaMCPChatPanel.h` (108L) + `.cpp` (932L). Renamed from `SHaybaMCPWizardWidget` in **`d0317e4`** *"refactor(ue): rename SHaybaMCPWizardWidget -> SHaybaMCPChatPanel"*. The `.cpp` header comment records the slimming: *"All Wizard / ModeSelect / MCPStatus / inline-Settings / Steps-sidebar code was removed; those concerns live in dedicated panels."* So the panel was **not removed — it was renamed and reduced to a pure chat surface**.
- LLM HTTP client (C++): `FHaybaMCPClaudeClient` — `HaybaMCPClaudeClient.h` (28L) + `.cpp` (146L). Despite the name it is dual-protocol: Anthropic (`x-api-key` + `anthropic-version: 2023-06-01`, system at top level) vs OpenAI-compatible (`Authorization: Bearer`, system as first message), selected by `FHaybaMCPSettings::IsAnthropicEndpoint()` = `BaseURL.Contains("anthropic.com")` (`HaybaMCPSettings.h:86`). Parses `content[0].text` (Anthropic) or `choices[0].message.content` (OpenAI). Handles 401/429/non-200. This is the C++ counterpart to the renamed-panel work; it predates the rename (`58a4016` *"sync PCGExBridge plugin with Claude API integration"*, `82fa0ae`).
- System prompt: `HaybaMCPWizardPrompt.h` `GetHaybaMCPWizardSystemPrompt()` — hard-codes a "return ONLY `{reply, graph:{nodes,edges}}` JSON" PCGEx-graph contract (no tool schema).
- Chat data model: `HaybaMCPWizardState.h` — `FHaybaMCPChatMessage{bFromUser, Text, AttachedGraph, bShowActions, Timestamp}`, `FHaybaMCPWizardSession{SessionId, Goal, Steps[], CurrentStep, Messages[], bWaitingForAI}`.
- Key storage: `HaybaMCPSettings.cpp` — `GetSharedApiKey`/`SetSharedApiKey` read/write **plaintext** to `GEditorPerProjectIni` `[HaybaShared]ApiKey`; also per-toolkit `[HaybaMCPToolkit] ApiKey/BaseURL/Model`. `Model` default `claude-opus-4-6-20251101`, `BaseURL` default `https://api.anthropic.com/v1/messages`.
- Settings UI: `HaybaMCPSettingsPanel.cpp:31-38,418-423` — `LlmModelBox`, `LlmBaseUrlBox`, `LlmApiKeyBox` (`.IsPassword(true)`). Single key + base URL + model; **no provider dropdown/presets**.
- Wiring: `HaybaMCPMainPanel.cpp` — `EHaybaPanel::Chat` (enum in `HaybaMCPMainPanel.h:13`), built at `:313` `SNew(SHaybaMCPChatPanel, Module).MainPanel(this)`, **gated to API-key mode only** (`:182-185` `bIntegrated = OperationMode==Integrated; if(!bIntegrated) Items.Add(EHaybaPanel::Chat)`), and is the default panel for API-key users (`:109`, `MainPanel.h:31`). Onboarding/mode-select shipped in `e530d04` *"branching onboarding wizard"* (`HaybaMCPOnboardingWidget.cpp`).
- Tool-observability seam (already real): `FHaybaMCPModule::OnToolCallRecorded` multicast (`HaybaMCPModule.h:81-82`), fired from `HaybaMCPCommandHandler.cpp:581,721` → `HaybaMCPModule.cpp:554 Broadcast`. The chat panel subscribes during an in-flight send (`HaybaMCPChatPanel.cpp:870`) to stream `• <toolName>` trace lines into a placeholder message. The same delegate also feeds `SHaybaMCPToolStreamPanel`.
- Create/Test buttons use the TCP path: `Module->SendTcpCommand("create_graph"|"execute_graph", params, cb)` (`ChatPanel.cpp:789,818`; `Module.h:39`). Build deps present: `HTTP`, `Json`, `JsonUtilities` in `HaybaMCPToolkit.Build.cs:39-40`.

### B. TS LLM client abstraction — REMOVED, never carried forward
- `packages/hayba/src/agents/llm-client.ts` (86L) + `tests/agents/llm-client.test.ts` — added in **`ac46d40`** *"feat(ts): add LLM client abstraction (Anthropic + OpenAI-compat)"*. This is the **only proper tool-calling shape** anywhere in the repo's history: `LLMTool{name,description,input_schema}`, `LLMToolCall{id,name,input}`, `LLMResponse{content, toolCalls, stopReason: 'end_turn'|'tool_use'|'max_tokens'}`, `createLLMClient()` driven by env (`HAYBA_LLM_BACKEND`/`_API_KEY`/`_MODEL`/`_BASE_URL`), dynamic `import('@anthropic-ai/sdk')` / `import('openai')`, mapping our tools → Anthropic `tools` and OpenAI `tools:[{type:'function'}]`.
- **Fate:** the repo restructure (**`b20eb6e`/`9848126`** *"restructure — apps/hayba-explorer, mcp-tools/, desktop packages co-located"*) moved `packages/hayba/src/agents/` → `mcp-tools/hayba-mcp/src/agents/` but carried **only** `agent-registry.ts` + `types.ts` — `llm-client.ts` was dropped and never re-added. It exists in **no** current path; `mcp-tools/hayba-mcp/package.json` has **no** `@anthropic-ai/sdk` or `openai` dependency. What remains (`mcp-tools/hayba-mcp/src/agents/agent-registry.ts`, 87L; `types.ts`, 13L) is only an archetype/tool-filter/shared-memory manifest loader with a `// TODO: integrate AgentRegistry into src/index.ts` — **no runtime LLM loop**.

### C. Architecture "AI binding pipeline" (the 8 providers) — REMOVED; separate from the chat panel
This is a **one-shot style-binding generator** for the web "atlas" demo, not the editor chat — but it is the origin of the "8 providers" list.
- Lived in `packages/architecture/src/ai/`: `types.ts` (`29b1aa1`), `prompt-builder.ts` (`839452b`), `response-parser.ts` (`e134664`), `provider-mock.ts` (`8774539`), `provider-anthropic.ts` (`5647731`, BYOK `dangerouslyAllowBrowser`), `provider-openai-compat.ts` (`2849a75`), `generate-binding.ts` (`05fbb77`); `@anthropic-ai/sdk` dep added in `7b63c45`. Design doc `d1b353b` *"AI binding pipeline plan (8 providers — mock, anthropic, groq, openrouter, openai, ollama, lmstudio, custom)"*.
- The **8 providers** = `mock`, `anthropic`, and the OpenAI-compat family `{groq, openrouter, openai, ollama, lmstudio, custom}`. `OPENAI_COMPAT_PRESETS` (in `provider-openai-compat.ts`) carried `baseUrl/defaultModel/needsKey/keyHint` per provider (Groq `gsk_…`, OpenRouter `sk-or-…`, OpenAI `sk-…`, Ollama/LM Studio keyless).
- MCP handler `architecture_generate_binding` — **`4d47e58`** in `packages/hayba/src/tools/worldbuilding/architecture-handlers.ts` (106L): env-keyed (`ENV_KEY_BY_PROVIDER`, `BASE_URL_BY_PROVIDER`, `DEFAULT_MODEL_BY_PROVIDER`), serializes bigint seed as hex at the MCP boundary.
- Web BYOK panel (8 providers, localStorage) — **`94b09a9`** in `packages/architecture/demo/index.html` (147L).
- **Removal:** MCP handler dropped in **`f9077fa`/`13ef711`** *"MCP culture CRUD tool surface; remove style-guide tools"* (superseded by the PLUMB/culture direction); the whole `src/ai/` dir + SVG editor demo deleted in **`f40c8a2`/`e04eae1`** *"chore(architecture): remove SVG editor + AI binding pipeline"* (2307 deletions). Reason was supersession/parking of the atlas experiment, not a defect.

## 2. How the in-tree panel actually works (and its gaps)
Flow: API-key user → Chat tab → first send `InitializeSession` → `SendToMCP("[INIT] Goal:…")` → `SendToMCP` checks `HasApiKey()`, adds a `…` placeholder, subscribes `OnToolCallRecorded`, calls `FHaybaMCPClaudeClient::SendMessage(systemPrompt, userMsg, sharedKey, model, cb)` → single HTTP POST → `OnClaudeResponse` parses `{reply, graph}`, renders AI bubble + Approve/Preview/Create/Test buttons; Create/Test marshal via `SendTcpCommand`.

**Hard gaps vs. a real agent:**
1. **No tool-calling loop.** `BuildRequestBody` sends **no `tools` field**; the model only emits a graph JSON. The `OnToolCallRecorded` trace reflects tools fired by *external* MCP clients (Claude Desktop/Code), **not** tools this panel's LLM decided to call. It is a one-shot generator, not an agent.
2. **No streaming.** Single POST; `bIsStreaming` is cosmetic; `StopGeneration()` has `// TODO: wire FHaybaMCPClaudeClient::Cancel()` and cannot abort the HTTP request.
3. **No conversation history.** Each call sends only the latest user message (`Session.Messages` is never serialized into the request).
4. **Provider mgmt = a substring heuristic** (`anthropic.com`), single key, no presets. The rich 8-provider UX only ever existed in the removed TS/web pipeline.
5. **Insecure key storage** — plaintext in `GEditorPerProjectIni`.
6. **No session persistence** — `BuildRecentSessionsMenu` is a disabled "coming soon" placeholder (Q8-b TODOs throughout).

## 3. What it takes to ship a production in-editor BYOK agent

**Recommended architecture: put the agentic loop in the Node MCP server, keep C++ as a thin streaming chat client.** The server already owns the full tool catalog + gating + validator + journaling (`mcp-tools/hayba-mcp/src/tools/index.ts`, `list_tool_categories`/`get_tool_signature`/`hayba_invoke`, `DisabledTools` honored via `Saved/HaybaMCP/disabled-tools.json`). Re-implementing tool-calling in C++ duplicates all of that and risks the game-thread deadlock class documented in `docs/audit/2026-06-22-crash-and-architecture-audit.md`.

### 3.1 Provider/key management + secure storage
- Resurrect the provider catalog from `OPENAI_COMPAT_PRESETS` (commit `2849a75`) + the `ENV_KEY_BY_PROVIDER`/`BASE_URL_BY_PROVIDER`/`DEFAULT_MODEL_BY_PROVIDER` maps (commit `4d47e58`) as a single shared `providers.ts`. 8 entries: mock, anthropic, groq, openrouter, openai, ollama, lmstudio, custom.
- Replace the single `LlmApiKeyBox` in `HaybaMCPSettingsPanel.cpp` with a provider dropdown that auto-fills baseURL/default model/key-hint and shows a keyless badge for Ollama/LM Studio/mock.
- **Secure storage:** stop writing the key to `GConfig` plaintext (`HaybaMCPSettings.cpp:21-25`). On Windows use DPAPI (`CryptProtectData`, `FWindowsPlatformMisc`) and store the ciphertext blob; expose `GetSharedApiKey` to decrypt on demand. Keep per-provider keys keyed by provider id. Never log the key (the journal at `bEnableExecutionJournal` must redact).

### 3.2 Streaming
- Server-side: re-add `llm-client.ts` (lift verbatim from `ac46d40`) and extend `complete()` with a `stream` variant yielding SSE deltas (Anthropic `messages.stream`, OpenAI `stream:true`). Surface a local sidecar endpoint (`SidecarURL` already exists: `HaybaMCPSettings.h:56` `http://localhost:7821`) e.g. `POST /chat/stream` returning SSE.
- C++ side: `FHaybaMCPClaudeClient` already uses `FHttpModule`; switch to `Request->OnRequestProgress`/streamed reads (or consume the sidecar SSE) and append deltas to the in-progress message; implement the promised `Cancel()` by holding the `IHttpRequest` and calling `CancelRequest()` so `StopGeneration()` works.

### 3.3 Tool-calling loop driving our MCP tools
- In the sidecar, run the agentic loop using `llm-client.ts` types (`stopReason==='tool_use'`): build `tools[]` from the live registry (`get_tool_signature`/`list_tool_categories`), honoring `DisabledTools` and the agent archetype `tool_filter`/`canUseTool` already in `agent-registry.ts`. On each `tool_use`, dispatch through the existing tool layer (`hayba_invoke` → TS handler or TCP→C++ game-thread handler), feed `tool_result` back, repeat until `end_turn`.
- **Plan Mode integration:** before any destructive tool the server must respect `bPlanApproved` (`HaybaMCPModule.h:69`) / the Plan panel handshake — the loop should pause and emit a plan for approval rather than auto-executing (reuse `HaybaMCPPlanPanel`/`HaybaMCPPlanOverlay`).
- Game-thread safety: all C++ handlers run on the game thread (`HaybaMCPTcpServer.cpp:133`); the loop is async on the Node side, so tool dispatch stays non-blocking — do **not** add an in-C++ blocking loop (avoids the audit's class-A/B deadlocks).

### 3.4 Slate UI (mostly already built)
- `SHaybaMCPChatPanel` already has toolbar, scroll-with-"↓ N new" chip, footer (connection/model/mode segments → Settings), input with ⏎/⇧⏎, empty-state prompt cards, per-message copy/context menu, and Approve/Preview/Create/Test affordances. Keep all of it.
- Add: streaming token append into the in-progress bubble; a real tool-call trace fed by the agent loop (reuse the existing `OnToolCallRecorded` subscription at `ChatPanel.cpp:870` — it already renders `• tool` lines); render `tool_use`/`tool_result` as collapsible steps; wire `OnPreviewGraphFromMessage` to route into `SHaybaMCPPlanPanel` (the existing `// TODO Q15-b`); session persistence to disk to light up `BuildRecentSessionsMenu` (Q8-b).
- Replace the graph-only `GetHaybaMCPWizardSystemPrompt()` with an agent system prompt that describes the MCP tool surface (or let the server inject it).

### 3.5 Ties to tool-stream / validator panels
- The agent loop's tool calls already flow through `FHaybaMCPModule::RecordToolCall` (`CommandHandler.cpp:581,721`) → `OnToolCallRecorded.Broadcast` (`Module.cpp:554`), which feeds both the chat trace and `SHaybaMCPToolStreamPanel` (`Module.h:52`) — no new plumbing needed for observability.
- After mutating tools, have the loop call the validator surface (`validator_run`/`plumb_validate`; panels `SHaybaMCPValidationPanel` `Module.h:56`) and render pass/fail inline, plus the Diff panel (`SHaybaMCPDiffPanel` `Module.h:55`) for before/after — closing the agent → validate → approve loop the panels were built for.

### 3.6 Concrete revival checklist (smallest viable path)
1. Restore `mcp-tools/hayba-mcp/src/agents/llm-client.ts` from `ac46d40`; add `@anthropic-ai/sdk`/`openai` deps; add streaming.
2. New `providers.ts` from `2849a75` presets + `4d47e58` env/baseURL/model maps (8 providers).
3. Sidecar `POST /chat/stream` (SSE) running the tool-calling loop over the live registry, gated by `DisabledTools`/archetype filter/Plan Mode.
4. C++: provider dropdown + DPAPI key storage in `HaybaMCPSettingsPanel.cpp`/`HaybaMCPSettings.cpp`; switch `FHaybaMCPClaudeClient` (or a new `FHaybaMCPAgentClient`) to consume the SSE stream and support `Cancel()`.
5. `SHaybaMCPChatPanel`: append streamed deltas, render tool steps, wire Preview→Plan panel, add session persistence.

**Net:** the Slate UI and the tool-observability seam are already production-grade and in-tree; the LLM call is a single-turn, no-tools, no-stream stub. The fastest correct revival reuses the removed `llm-client.ts` (tool-calling shape, `ac46d40`) and the removed provider catalog (`2849a75`/`4d47e58`) **server-side**, and turns the C++ panel into a streaming front-end over the existing MCP tool layer — rather than rebuilding tool-calling in C++.


## Production-readiness audit

Audit complete. Findings below.

---

# Hayba MCP Toolkit — Production-Readiness Audit (2026-06-28)

## Verdict
The TS server is in good shape (gate green: `tsc` exit 0, **524 vitest tests / 88 files pass**). The UE plugin's crash-resilience improved markedly since the 2026-06-22 audit — the TCP dispatch was rearchitected and most of that audit's confirmed crashes are now **fixed**. But three editor-freeze blockers remain live, SEH coverage is narrow, the plugin has no distributable/marketplace path, and the transport layer is fragile on reconnect/port-rediscovery. Not production-ready for unattended use; close to ready for supervised/single-instance use.

**Important context correction:** `docs/audit/2026-06-22-crash-and-architecture-audit.md` is stale. Its load-bearing premise — "every handler runs on the game thread via `AsyncTask(GameThread)` at `HaybaMCPTcpServer.cpp:133`" — no longer holds. `HaybaMCPTcpServer.cpp` now drains commands on a **game-thread FTSTicker** (`DrainPendingCommands`, line 158-175) running `ProcessCommand` synchronously, explicitly to fix the `python_run`→Interchange re-entrancy crash (`check(RecursionGuard==1)`). Handlers still execute on the game thread, so class-B blocks still freeze the editor, but the class-A self-deadlocks the audit feared were separately fixed with `IsInGameThread()` guards.

## Ranked production blockers

### P0 — Editor freeze: `build_*` blocks the game thread up to 5 min
`unreal/.../handlers/HaybaMCPBuildHandler.cpp:248` — `Future.WaitFor(FTimespan::FromSeconds(kShortJobTimeoutSec))`, `kShortJobTimeoutSec = 300.0` (line 34). The comment at lines 227-228 ("already invoked off the game thread by the TCP server") is **factually wrong** under the new ticker dispatch. Any `build_project`/`build_cook`/`build_generate_project_files` freezes the whole editor (no render/input/TCP) for up to 300s. `docs/audit/2026-06-22-mcp-async-command-conversions.md` documents the job-envelope fix as "**planned, not implemented**." Compounding: the TS side times out far earlier (see P1-transport), so the call returns an error while UE stays frozen.

### P0 — Editor freeze: `test_run` busy-sleeps the game thread up to 120s/test
`unreal/.../handlers/HaybaMCPTestHandler.cpp:227` — `FPlatformProcess::Sleep(0.01f)` latent-command pump loop on the game thread; the engine can't tick inside the sleep so latent tests never settle and run to the full 120s timeout each. `test_names:["all"]` = serial multi-minute blackouts. Same "planned, not implemented" status.

### P1 — Narrow SEH crash-guard coverage
`HaybaSeh::RunGuarded` / `ExecPythonGuarded` wrap **only** `python_run` (`HaybaMCPPythonHandler.cpp`) and material compile (`HaybaMCPMaterialHandler.cpp`). The general dispatch path (`HaybaMCPCommandHandler::ProcessCommand` ← `DrainPendingCommands`) is **not** SEH-guarded, so any native AV / engine `check()` in the other ~33 handlers still takes down the editor. A single seam — wrap `ProcessCommand` in `HaybaSeh::RunGuarded` and return a framed error — would convert the whole surface to recoverable. (The python handler itself is mature: SEH + dangling-delegate BLOCK/WARN sets for #283/#284 + eager in-guard GC of the script namespace.)

### P1 — TCP transport: cached port, no reconnect, timeout mismatch, dead `timeout` code
`mcp-tools/hayba-mcp/src/tcp-client.ts` + `src/tools/tool-executor.ts`:
- **Port resolved once, cached forever** (`getUEClient()` memoizes the singleton with the port from first `discoverPortFromInstanceRegistry()` call). If UE restarts on a fallback port (52343-52350), the Node client keeps hitting the stale port — no rediscovery on reconnect.
- **No auto-reconnect/backoff.** On socket `close`, pending requests reject; `ensureConnected()` only reconnects if `isConnected()` is false, and then to the same stale port.
- **Timeout mismatch:** executor cost timeouts are low 2s / medium 10s / high 60s (`tool-executor.ts:29-33`); UE blocks up to 300s (build) / 120s (test) / 600s (PIE). Calls time out while UE is still working → orphaned requests.
- **Blind one-retry** (`tool-executor.ts:73-81`) re-sends after a transport failure with no idempotency check; for non-idempotent destructive commands (`actor_spawn`/`actor_delete`) a retry after a timeout where UE already executed the first request causes **duplicate mutations**.
- The `timeout` `UeToolErrorCode` (line 8) is **dead** — tcp-client throws a generic `Error('Timeout…')` that the executor wraps as `code:'transport'`, never `'timeout'`.

### P1 — No plugin distribution / marketplace path
- `.uplugin` (all 5 modules) pinned to `"EngineVersion": "5.7.0"` exactly. 5.7 is bleeding-edge; no 5.5/5.6 support; locks the install to one engine build.
- No prebuilt `Binaries/` — users must regenerate VS project files and recompile (README step 1). CHANGELOG repeatedly warns "**Requires a plugin recompile to take effect**," so shipped behavior lags source.
- `HaybaMCPToolkit.Build.cs` injects **engine private headers** via `PublicSystemIncludePaths` (`LandscapeEditor/Private`, `MaterialEditor/Private`). Private headers are the single most version-fragile thing in UE and are disallowed/discouraged for Fab/marketplace packaging — they will break across minor engine versions.
- `bUseUnity = false` workaround (colliding anonymous-namespace `EditorWorld`/`ReadVec`/`FindActorByName` helpers across handler TUs) → slower builds and signals real code-org debt (the audit's "shared helper module" candidates).
- "Installed": false, no Fab/marketplace metadata, no icon/screenshots/category vetting.

### P1 — `python_run` is the de-facto API; typed PCG/author primitives are missing
`docs/HANDOFF-mcp-agent-ergonomics-postmortem.md` (dated today, P3): ~90% of a real authoring session was hand-rolled `python_run` against UE reflection because the `pcg_*`/`plumb_*` wrappers don't cover the core author loop (add node / set prop / wire pin / cook+inspect). P1 in that doc: **no UE reflection-introspection tool** (`get_tool_signature` covers MCP schemas, not the UE class/pin/enum surface the agent actually authors against) → dozens of trial-and-error round-trips. So despite the "100+ tools" headline, the practical production surface is `python_run` + guessing.

### P2 — Error-envelope inconsistency (render/build escape the convention)
`HaybaMCPRenderHandler.cpp:493-498` (and build) return `FHaybaHandlerResult::Ok()` carrying a nested `{ok:false, error:{kind,engineHint}}`, so a render **failure** travels as a transport-level success (`resp.ok === true`). `tool-executor.ts:83` then returns the failure payload **as success data**. The TS layer must special-case these handlers; the wire's one-failure-shape invariant has a silent exception. (Audit candidate #3.)

### P2 — Routing packs reference dozens of unregistered tools
Test run emits `[routing] workflow pack "X" references unknown tool "Y"` for `architecture_*` (12), connectors (`hayba_polyhaven_*`/`sketchfab_*`/`fab_*`, 11), `planet-sim`, and even core `python_run`/`render_camera`/`wait_for_idle`/`editor_stream_log`. `mcp-tools/hayba-mcp/src/tools/routing/packs.yaml` is partly aspirational — an agent loading those packs in Code Mode gets tool refs that don't resolve via `hayba_invoke`.

### P2 — Remaining bounded game-thread blocks
- `HaybaMCPPIEHandler.cpp:386/467/503` — `Sleep` loops on the game thread during PIE waits. The overflow/negative-timeout crash IS fixed (line 327 `FMath::Clamp(TimeoutMs, 0, 600000)`), but the cap is **10 minutes** — a `PIEWaitFor` can still freeze the editor that long.
- `HaybaMCPRenderHandler.cpp:309` — `Sleep(0.25s)` per poll, now inline on the game thread.

### P2 — Zero unit tests for the 33 C++ handlers
C++ tests (8 files under `Source/.../Private/Tests/`) cover only PLUMB (socket contract/solver/store, unsat-core, determinism, tag, opening). No tests for TCP framing, the `HaybaGameThread` seam, `ProcessCommand` dispatch/auth/plan-gate ordering, or any handler. Handlers are welded to `GEditor`/`LoadObject` globals (no editor-context seam), so they're integration-only. The 524 TS tests largely exercise wrappers + `InMemoryToolExecutor`, not the live UE path.

### P3 — Half-wired auth
`HaybaMCPSecurityManager.cpp:86-108` validates an `auth` token against `FHaybaMCPSettings::CapabilityToken`, but `tcp-client.ts` **never sends an `auth` field** (frames only `{cmd,id,params}`). If a user sets a capability token, **every command is rejected** ("Missing auth token"). Latent because the default token is empty (auth disabled); the only real protection is `127.0.0.1` binding.

### P3 — Committed binary artifact
`mcp-tools/hayba-mcp/hayba-memory.db` is **git-tracked** (SQLite binary) — repo bloat, merge conflicts, potential stale/leaked data. Should be gitignored.

## What's already solid (don't regress)
- **Crash fixes since 06-22 audit, verified in current source:** `CaptureBeforeState` (now `HaybaGameThread::RunSyncVoid` inline, `HaybaMCPCommandHandler.cpp:232`); `render_camera` self-deadlock (`IsInGameThread` guard, `HaybaMCPRenderHandler.cpp:473`); `wait_for_idle` (now cooperative single-poll, returns inline); editor viewport `StaticCast` (now `IsA` check, `HaybaMCPEditorHandler.cpp:25`); spline OOB (bounds checks, `HaybaMCPSplineHandler.cpp:160/189`); BT cycle (rejected at `bt_connect`, `HaybaMCPBehaviorTreeHandler.cpp:278`); PIE timeout overflow (clamped, `:327`).
- `HaybaGameThread::RunSync*` seam (`Public/HaybaMCPGameThread.h`) — the audit's #1 deepening candidate, implemented: inline-if-on-GT + pooled FEvent + leak-on-timeout.
- Ticker-based TCP dispatch correctly avoids the task-graph re-entrancy crash; localhost-only bind; 1 MB frame cap both sides.
- `python_run` crash hardening (SEH + dangling-delegate gating + in-guard GC) and the `editor_capture_viewport` P0 image-block fix (`editor-capture-viewport.ts`, wired at `index.ts:922`).
- PLUMB/validator are the most mature subsystems: extensive TS tests (grammar/graph/junction/lesson/room-grammar/primitive-attrs/plumb) + the only C++ test coverage; validator rules/runner/history/tool-hooks all tested.
- Docs/onboarding coherent: CONTEXT.md, ARCHITECTURE.md, getting-started.md, wiki (7 pages), 4 ADRs, detailed CHANGELOG.

## Suggested fix order
1. P0 build/test job-envelope conversion (plan already written in `docs/audit/2026-06-22-mcp-async-command-conversions.md`) — eliminates the two multi-minute freezes.
2. P1 SEH-wrap `ProcessCommand` — one seam makes the whole 33-handler surface crash-recoverable.
3. P1 transport: re-discover port on reconnect, add backoff reconnect, align executor timeouts to UE cost ceilings, gate the retry to idempotent commands, wire the `auth` field.
4. P1 distribution: provide prebuilt binaries + widen `EngineVersion`, remove private-header includes (or document non-marketplace status honestly).
5. P2 envelope unification (Err with structured payload), prune/validate `packs.yaml` against the live catalog, gitignore `hayba-memory.db`.

Key files: `unreal/.../handlers/HaybaMCPBuildHandler.cpp:248`, `HaybaMCPTestHandler.cpp:227`, `HaybaMCPPIEHandler.cpp:386`, `HaybaMCPCommandHandler.cpp` (ProcessCommand/DrainPendingCommands seam), `HaybaMCPSeh.cpp`, `Public/HaybaMCPGameThread.h`, `mcp-tools/hayba-mcp/src/tcp-client.ts`, `src/tools/tool-executor.ts`, `src/tools/routing/packs.yaml`, `unreal/HaybaMCPToolkit/HaybaMCPToolkit.uplugin`, `HaybaMCPToolkit.Build.cs`.


## Architecture & extensibility

Architecture & extensibility audit complete. Findings below.

---

# Hayba MCP — Add-a-Tool Path & Extensibility Audit

## A. The add-a-tool path, end to end

### A1. TS registration (the authoring side)
Per "standard" tool there are today **4 distinct edit surfaces**, all in `mcp-tools/hayba-mcp/src/tools/`:

1. **Wrapper file** `<domain>/<tool>.ts` — exports `meta: HaybaToolMeta`, a Zod `schema`, and a `ToolHandler` that `safeParse`s then calls `executeCommand('<cmd>', parsed.data)`. Example `actor/actor-spawn.ts:25-32` is 8 lines of pure boilerplate (validate → `executeCommand('actor_spawn', …)` → stringify).
2. **Import block** at the top of `index.ts:19-156` — one or two import lines per tool (`handler` + `meta`, sometimes `schema`). ~140 lines of hand-maintained imports.
3. **`ToolDescriptor`** entry in `STANDARD_DESCRIPTORS` (`index.ts:197`+) — re-declares name/description/meta/handler/cost/returns **and the Zod shape inline again** (e.g. `actor_spawn` shape at `index.ts:225-231` duplicates `actor-spawn.ts:17-23`).
4. For tools that don't fit the standard shape, a **hand-written `server.tool(...)` + `remember(...)`** site inside `registerToolsCore` (`index.ts:756`+). There are **104 `server.tool(` calls vs only 32 descriptors** — i.e. ~70 tools never got migrated onto the descriptor path and remain fully hand-wired (editor_*, render_camera, pcg_*, asset-sources, etc.).

The descriptor is consumed by two iterators that mirror historic timing:
- `recordEagerSchemas` → `recordToolSchema(d)` → `recordSchema()` — **always** runs (Code Mode on/off); feeds `get_tool_signature` via `schema-registry.ts` (`index.ts:1953/1966`, `register-tool.ts:68`).
- eager block `for (const d of STANDARD_DESCRIPTORS) registerTool(server, session, d)` (`index.ts:906`) — only when `config.codeMode === false`; does `server.tool(appendMeta(...))` + `registerToolMeta` (`register-tool.ts:78-96`).

`register-tool.ts` already collapsed the *old* triplication (server.tool+remember+reg) into one descriptor — but the descriptor still **re-declares the schema** the wrapper file already owns, and the wrapper file still exists.

### A2. Code-Mode deferred routing / packs
`registerTools` (`index.ts:669`) branches on `settings.toolRouting`:
- **deferred** (γ-hybrid): monkey-patches `server.tool` to *capture* every registration into `Map<string,CapturedTool>` **without forwarding** (`index.ts:679-695`), forces `codeMode=false` so the eager block captures everything, restores, then calls `registerDeferredRouting` (`routing/register.ts:123`). That wires the meta-tools (`hayba_search_tools/pack_list/pack_load/invoke`), builds a BM25+embedding `ToolIndex` over captured docs, and a `PackRegistry`.
- **Pack assignment**: domain pack = subdir name via `deriveDomainPacks` (`pack-discovery.ts:5`); workflow packs from `routing/packs.yaml`. A tool's dir is resolved by `inferDir()` — a **hardcoded prefix→dir table** (`index.ts:733-745`, `actor_→actor`, `scene_→scene`, …) that must be edited for every new prefix.
- **Always-on surface** is two hand-maintained lists that must stay in sync: the `ALWAYS_ON_META` Set (~50 names, `register.ts:41-90`) and ~40 explicit `passthrough('…')` calls (`register.ts:284-322`).

### A3. Transport (generic — zero per-tool cost)
`tcp-client.ts`: length-prefixed JSON frames (4-byte BE length + `{cmd,id,params}` → `{id,ok,data|error,code}`), singleton with port discovery from `Saved/HaybaMCP/instances/*.json`. `tool-executor.ts:59` `executeCommand` derives timeout from cost, does one transport retry, maps `resp.code`→`UeToolError`. **Adding a command needs no transport changes** — this layer is already fully generic.

### A4. C++ TCP server → game-thread dispatch
- `HaybaMCPTcpServer.cpp`: background `FRunnableThread` accepts/reads frames, enqueues to a `PendingCommands` queue **drained on the game thread via `FTSTicker`** (`:68`, `:158`) — deliberately NOT `AsyncTask(GameThread)` so a handler can re-enter the task graph (python_run→Interchange import). Load-bearing; documented at `:63-67`.
- `HaybaMCPCommandHandler.cpp::ProcessCommand` (`:479`): parse → reject empty id/cmd → auth gate → ~5 hardcoded special-cases (`hayba_propose_plan`, `ui_memory_set`, `ui_tool_stream*`, `get_setting`) → **Plan-Mode gate keyed off `IsDestructiveCommand()` hardcoded list** (`:27-36`) → `CommandToHandler.Find(Cmd)` → wrap in editor transaction if destructive → `(*Found)->Handle(Cmd,Params)` → journal → push to panels → trim response.
- Handler contract `IHaybaMCPHandler.h`: `GetDomain()`, `GetCommands()→TArray<FString>`, `Handle(Cmd,Params)→FHaybaHandlerResult`. Each handler (`HaybaMCPActorHandler.cpp`) is: a literal command list in `GetCommands()` (`:63-81`), an **if-chain in `Handle()`** (`:83-101`), and one method per command doing **manual `TryGet*Field` param reads + manual `FJsonObject` output building** (`:106-637`). **31 handler files**, hand-registered in `HaybaMCPModule.cpp:88-125`. Adding a C++ command = edit 3 places in the .cpp (+ Module.cpp for a new handler) and **rebuild the plugin**.

### A5. python_run escape hatch
`python/python-run.ts:66` → `client.send('python_run')`. C++ `HaybaMCPPythonHandler.cpp` runs under an SEH guard (`ExecPythonGuarded`), a 3-tier security gate (tier-3 fs/subprocess blocked), and a dangling-delegate registration gate (#283/#284). Universal, but: untyped, no schema/discovery, crash-prone, and bypasses the structured journal/diff/transaction semantics that typed commands get.

### A6. The sidecar (third source of truth)
`src/legacy-commands/sidecar.json` = **72 hand-authored** command docs (params/returns/`agent_callable`/`has_ts_wrapper`). Feeds the `get_tool_signature` fallback (`code-mode/get-tool-signature.ts:67`) and `hayba_invoke`'s `ue_legacy` allowlist. Kept in sync by lint `scripts/check-legacy-wrappers.mjs` — which checks **existence only**, not field-level drift (explicitly flagged in `get-tool-signature.ts:104-108`). `scripts/add-underground-wrappers.mjs` is a one-shot codegen that bulk-appended sidecar entries — i.e. **codegen is already the ad-hoc workaround** for the scaling problem.

## B. What makes adding a tool slow today
A single new C++-backed, agent-callable, discoverable tool touches **4-7 files across 2 languages + a plugin rebuild**, and the same parameter set is re-declared in up to **4 representations** that can independently drift:

| Representation | Location |
|---|---|
| Wrapper Zod `schema` | `tools/<domain>/<tool>.ts` |
| Descriptor Zod `schema` | `STANDARD_DESCRIPTORS` in `index.ts` |
| Sidecar `params[]` | `legacy-commands/sidecar.json` |
| C++ `TryGet*Field` reads | `handlers/HaybaMCP*Handler.cpp` |

Plus list-maintenance: import block (`index.ts`), `inferDir` prefix table, `ALWAYS_ON_META` Set + `passthrough()` calls, `Module.cpp` registration, `IsDestructiveCommand` list. None of this scales to hundreds.

## C. Concrete drift hazards found (evidence)
- `IsDestructiveCommand` (`HaybaMCPCommandHandler.cpp:27`) — the comment at `:31` records a **real shipped bug**: the list said `python_exec` (a non-existent name) so `python_run` silently bypassed the Plan-Mode gate. A schema-driven `destructive` flag would have made this structurally impossible.
- `inferDir` (`index.ts:733`) and the two always-on lists (`register.ts:41`, `:284`) are hand-kept parallel copies of information the descriptor already implies.
- 104 `server.tool` vs 32 descriptors — the migration to the "single descriptor" model is only ~30% done.

## D. Recommended refactor (do this before the blitz)

**Principle: a tool becomes *data*, declared once, with codegen + generic dispatch on both sides.**

1. **Collapse to one descriptor as the sole authoring surface.** Extend `ToolDescriptor` so each tool carries `{name, domain, cost, meta, schema(zod), returns}` plus exactly one of: `ueCommand: string` (→ `register-tool` synthesizes the passthrough handler that today lives in every wrapper file — `actor-spawn.ts` becomes unnecessary), `pyTemplate` (see #4), or `handler` (rare custom TS). This removes surfaces #1 (wrapper file) and #3's schema duplication in one move. Derive pack from `domain` (delete `inferDir`'s table) and always-on from a `descriptor.alwaysOn` flag (delete both lists in `register.ts`).

2. **Auto-collect descriptors.** Each domain folder exports `descriptors: ToolDescriptor[]`; a generated barrel concatenates them. The two iterators already loop the list — just make the list auto-collected instead of a 470-line literal + 140-line import block. New TS tool = drop one object in a domain file; registration, schema-recording, pack assignment, and `get_tool_signature` all flow for free.

3. **Generate the sidecar, don't hand-write it.** `deriveSignature` already turns Zod→param docs (`schema-registry.ts:33`). Emit `sidecar.json` from the descriptor set at build time; replace the existence-only lint with a "generated == committed" check (the pattern `scripts/gen-plumb-enums.ts` already establishes here). Eliminates the 4th schema representation for every TS-backed command.

4. **python-backed tool factory = the vehicle for "hundreds".** Most new tools are thin UE-API wrappers that need no C++. Add a `pyTemplate` descriptor field: a parameterized Python snippet that `register-tool` binds validated params into and dispatches through the already-hardened `python_run` handler (SEH guard, tiering, crash gate), capturing structured JSON. Result: **schema-validated, discoverable, journaled tools with zero plugin rebuilds** — author hundreds by adding manifest entries. Reserve C++ handlers for hot-path/crash-prone ops only.

5. **C++ declarative command table (only if hot-path C++ tools proliferate).** Replace per-handler `GetCommands()` list + `Handle()` if-chain with a single `TMap<FString, FCommandSpec>` where each spec carries param names/types/required + a lambda. `GetCommands()`/`Handle()` derive from the table; add an `mcp_describe_commands` command that emits each command's schema from the table — making the sidecar **generatable from the running plugin** (closing the field-level drift the current lint can't catch) and letting the router validate params and the `destructive` flag generically (kills the `IsDestructiveCommand` bug class).

**Sequencing:** (1)+(2)+(3) first — pure TS refactor, no rebuild, immediately removes ~3 surfaces/tool and the schema drift, and finishes migrating the ~70 still-hand-wired tools. Then (4) — unlocks no-rebuild tool authoring at scale. Then (5) only if C++ tool count justifies it.

**Files that anchor the refactor:** `src/tools/register-tool.ts` (extend descriptor + synthesize handlers), `src/tools/index.ts` (replace STANDARD_DESCRIPTORS literal + import block with auto-collected barrel; delete `inferDir`), `src/tools/routing/register.ts` (replace `ALWAYS_ON_META`/`passthrough` with `descriptor.alwaysOn`), `src/tools/schema-registry.ts` + new `scripts/gen-sidecar.ts` (generate `legacy-commands/sidecar.json`), `unreal/.../Private/HaybaMCPCommandHandler.cpp` + `IHaybaMCPHandler.h` (optional `FCommandSpec` table + `mcp_describe_commands`).

