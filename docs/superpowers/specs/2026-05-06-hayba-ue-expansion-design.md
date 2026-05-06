# HaybaOS UE Plugin Expansion — Full Design Spec
**Date:** 2026-05-06  
**Status:** Approved for planning  
**Scope:** HaybaMCPToolkit C++ plugin, Node.js MCP layer, visual sidecar add-on, hayba swarm agents, workflow skills

---

## 1. Overview

This spec describes the full expansion of `HaybaMCPToolkit` from a PCG/landscape-focused tool into the complete **HaybaOS** agentic level design system described in *"Architecting Agentic 3D Scene Generation: Optimizing Large Language Models for Unreal Engine Integration via HaybaOS"*.

The system gives Claude:
- **Scene Intelligence** — read actors, spatial relationships, world structure
- **Scene Manipulation** — spawn/transform/delete actors, run Python, modify Blueprints and materials
- **Visual Perception** — viewport capture with CLIP/SpatialCLIP/OWLViT embeddings
- **Spatial Navigation** — World Partition cell index + semantic cluster cognitive map
- **Multi-Agent Orchestration** — 5 configurable swarm agents with shared SQLite memory

Plugin version bumps: `0.2.0` → `0.3.0` (first phase), `1.0.0` at full 34-domain completion.

---

## 2. Architecture

### 2.1 Domain-Partitioned C++ Handler System

The existing monolithic `FHaybaMCPCommandHandler` becomes a **thin router**. Each of the 34 domains gets its own handler class registered at startup.

```
FHaybaMCPTcpServer
  └─ FHaybaMCPCommandHandler  (router + rate limiting enforcement)
       ├─ FHaybaMCPActorHandler           actor_*
       ├─ FHaybaMCPLevelHandler           level_*
       ├─ FHaybaMCPAssetHandler           asset_*
       ├─ FHaybaMCPBlueprintHandler       blueprint_*
       ├─ FHaybaMCPMaterialHandler        material_*
       ├─ FHaybaMCPEditorHandler          editor_*
       ├─ FHaybaMCPSceneGraphHandler      scene_*
       ├─ FHaybaMCPPythonHandler          python_*
       ├─ FHaybaMCPDocsHandler            docs_*
       ├─ FHaybaMCPPCGHandler             pcg_* (existing, migrated)
       ├─ FHaybaMCPLandscapeHandler       landscape_* (existing, migrated)
       ├─ FHaybaMCPFoliageHandler         foliage_*
       ├─ FHaybaMCPSplineHandler          spline_*
       ├─ FHaybaMCPWorldPartitionHandler  wp_*
       ├─ FHaybaMCPSequencerHandler       seq_*
       ├─ FHaybaMCPAnimationHandler       anim_*
       ├─ FHaybaMCPNiagaraHandler         niagara_*
       ├─ FHaybaMCPAudioHandler           audio_*
       ├─ FHaybaMCPMetaSoundHandler       metasound_*
       ├─ FHaybaMCPGASHandler             gas_*
       ├─ FHaybaMCPBehaviorTreeHandler    bt_*
       ├─ FHaybaMCPISMHandler             ism_*
       ├─ FHaybaMCPPhysicsHandler         physics_*
       ├─ FHaybaMCPInputHandler           input_*
       ├─ FHaybaMCPUIHandler              ui_*
       ├─ FHaybaMCPNetworkHandler         net_*
       ├─ FHaybaMCPStaticMeshHandler      mesh_*
       ├─ FHaybaMCPTextureHandler         texture_*
       ├─ FHaybaMCPDataAssetHandler       data_*
       ├─ FHaybaMCPProjectHandler         project_*
       ├─ FHaybaMCPBuildHandler           build_*
       ├─ FHaybaMCPTestHandler            test_*
       ├─ FHaybaMCPConventionsHandler     conventions_* (existing, migrated)
       └─ FHaybaMCPWizardHandler          wizard_* (existing, migrated)
```

**Command naming convention:** `category_verb` — e.g. `actor_spawn`, `blueprint_add_node`, `material_create`. All existing commands aliased to new convention with legacy names kept for backwards compatibility through `0.x`.

### 2.2 Shared Response Builder

All handlers use `FHaybaMCPResponseBuilder` — enforces:
- Max 50 items per array field (configurable)
- Max 512 chars per string field
- Max 20 top-level fields per response
- Handlers opt into pagination explicitly via `cursor`/`limit` params

### 2.3 Security & Rate Limiting

**C++ TCP server layer:**
- Capability token authentication — configurable secret in `HaybaMCPSettings`, validated on every request before routing
- Execution journal — every command logged with timestamp, params, result, execution duration to `hayba-execution.log` in project directory
- Python 3-tier safety pre-pass (see §4.9)

**Node.js MCP layer:**
- Rate limiting: 60 requests/minute per session, configurable in `HaybaMCPSettings`
- ToolCaching via `lru-cache`: read-only commands cached 2-5s TTL, invalidated on any mutation command

### 2.4 Code Mode (Progressive Tool Discovery)

Default on. Claude always has access to 3 meta-tools:
- `list_tool_categories` — returns all 34 domain names + command counts
- `get_tool_signature` — returns full schema for a specific command on demand
- `python_run` — direct Python execution

Full domain schemas pulled only when Claude requests them. Toggle to disable in `HaybaMCPSettings` for users preferring full tool visibility. Token reduction: ~92% on complex multi-domain tasks.

### 2.5 Cost-Aware Tool Schemas

Every TypeScript tool file implements `HaybaToolMeta`:

```typescript
interface HaybaToolMeta {
  cost: 'low' | 'medium' | 'high';
  effects: string[];          // e.g. ["spawns_actor", "modifies_level"]
  when: string;               // e.g. "when you need to place a new asset"
  not_when: string;           // e.g. "when you only need to read actor position"
}
```

MCP server injects this into each tool's description string so Claude sees cost before deciding to call.

---

## 3. Spatial Intelligence System

### 3.1 Semantic 3D Scene Graph — Three Modes

Command: `scene_export`

**Mode A — Flat actor list** (fastest)
```json
{ "mode": "flat", "actors": [{ "id": "...", "class": "...", "label": "...", "transform": {}, "bounds": {}, "tags": [] }] }
```

**Mode B — Relational graph** (default, recommended to AI)
- k-NN distance-based relationships: `adjacent_to`, `near`, `far` computed from centroid distance + bounding box overlap
- Physics-derived opt-in: `supported_by`, `inside` — pass `physics_relations: true` (triggers C++ raycasts)
- Output: relational triplets `<actor_a, relation, actor_b>`
- NMS + minimum distance filters applied

**Mode C — Hierarchical**
- Macro → Meso → Micro → Nano levels (World/Biome → Room/Zone → Actor → Socket)
- Top-down RAG: Claude queries by level, drills down on demand

**Spatial windowing (primary):** `center`, `radius` bounding box params. Default 500-actor limit, `truncated: true` + `actor_count_total` when exceeded.  
**Pagination (fallback):** `cursor` + `limit` params when windowing not sufficient.

Mode B is always recommended first in the `list_tool_categories` response description.

### 3.2 Level Spatial Index (Cognitive Map)

Command: `level_get_spatial_index`

Returns the AI's cognitive map of the level — used to determine bounding box coordinates before making precise `scene_export` queries.

**Primary:** World Partition cell grid — each cell has:
- Cell bounds (world-space AABB)
- Actor count
- Top 5 dominant actor classes
- Auto-generated semantic cluster label (e.g. "dense_forest", "urban_block_east")

**Fallback:** Quadtree clustering when World Partition disabled.

**Cluster labeling algorithm:** k-means on actor centroids, cluster label derived from dominant actor class names using a name→semantic mapping table (e.g. `BP_Tree_*` → "forest", `SM_Building_*` → "urban").

Result is lightweight (cells + labels, no full actor data), placed at prompt head with `cache_control`, auto-invalidated after level-mutating commands.

### 3.3 Physics Validation

Command: `scene_validate_physics`

1. **C++ primary:** Raycast downward from each actor's centroid. Actors with no geometry within `2 * bounds.height` below flagged as floating. Overlap checks for interpenetrating geometry.
2. **VLM secondary (opt-in):** Pass `deep_check: true` — captures viewport, sends to visual sidecar with prompt "act as a physics expert, identify structurally impossible geometry". Skipped gracefully if sidecar unavailable.

Returns: `{ floating: [...], interpenetrating: [...], structurally_suspect: [...] }`

---

## 4. Complete 34-Domain Command Catalog

### 4.1 Actor & Scene Control (`actor_*`)
| Command | Description | Cost |
|---|---|---|
| `actor_spawn` | Spawn actor from content path at transform | medium |
| `actor_delete` | Delete actor(s) by label/id | medium |
| `actor_transform` | Set position/rotation/scale | low |
| `actor_get_properties` | Get actor properties (constrained output) | low |
| `actor_set_properties` | Set actor properties by name | medium |
| `actor_list` | List actors (excludes `HaybaMCPCaptureActor` tag) | low |
| `actor_tag` | Add/remove tags | low |
| `actor_snap_to_socket` | Snap actor to named socket on another actor | medium |
| `actor_duplicate` | Duplicate actor with offset | medium |
| `actor_set_visibility` | Show/hide actor | low |
| `actor_get_components` | List components on actor | low |
| `actor_call_function` | Call a function on actor | high |
| `actor_batch_spawn` | Spawn multiple actors from array | high |
| `placement_validate` | Check placement validity (collisions, bounds) | low |

### 4.2 Level & World Management (`level_*`)
| Command | Description | Cost |
|---|---|---|
| `level_load` | Load a level | high |
| `level_save` | Save current level | medium |
| `level_list` | List levels in project | low |
| `level_get_info` | Get current level metadata | low |
| `level_get_spatial_index` | Get cognitive map (WP cells + cluster labels) | medium |
| `level_create` | Create new level | high |
| `level_set_bookmark` | Create/update named spatial bookmark | low |
| `level_goto_bookmark` | Move viewport to bookmark | low |

### 4.3 Asset & Content Management (`asset_*`)
| Command | Description | Cost |
|---|---|---|
| `asset_search` | Search Content Browser by name/type/path | low |
| `asset_get_info` | Get asset metadata + LODs + references | low |
| `asset_import` | Import external file into project | high |
| `asset_duplicate` | Duplicate asset | medium |
| `asset_delete` | Delete asset | high |
| `asset_get_references` | Get assets that reference/are referenced by this asset | low |
| `asset_validate` | Run asset validation checks | medium |
| `asset_rename` | Rename/move asset in Content Browser | medium |

### 4.4 Blueprint System (`blueprint_*`)
| Command | Description | Cost |
|---|---|---|
| `blueprint_create` | Create new Blueprint class | high |
| `blueprint_list` | List Blueprint assets | low |
| `blueprint_get_info` | Inspect Blueprint structure | low |
| `blueprint_add_component` | Add component to Blueprint | medium |
| `blueprint_add_variable` | Add variable to Blueprint | medium |
| `blueprint_add_function` | Add function to Blueprint | medium |
| `blueprint_add_node` | Add node to event graph | medium |
| `blueprint_connect_nodes` | Wire two nodes together | medium |
| `blueprint_compile` | Compile Blueprint | medium |
| `blueprint_document` | Generate natural language documentation of Blueprint | low |
| `blueprint_add_event` | Add event handler | medium |
| `blueprint_set_defaults` | Set class default values | medium |

### 4.5 Material System (`material_*`)
| Command | Description | Cost |
|---|---|---|
| `material_create` | Create new material asset | high |
| `material_add_node` | Add expression node to material graph | medium |
| `material_connect_nodes` | Wire material nodes | medium |
| `material_create_instance` | Create material instance from parent | medium |
| `material_set_param` | Set material instance parameter | low |
| `material_apply` | Apply material to actor/mesh | low |
| `material_list` | List materials in project | low |
| `material_get_info` | Get material node graph info | low |

### 4.6 Editor & Viewport Control (`editor_*`)
| Command | Description | Cost |
|---|---|---|
| `editor_start_pie` | Start Play-In-Editor session | high |
| `editor_stop_pie` | Stop PIE session | medium |
| `editor_set_camera` | Move viewport camera to transform | low |
| `editor_capture_viewport` | Capture viewport via SceneCaptureComponent2D + CustomProjectionMatrix | high |
| `editor_run_console_command` | Execute console command | medium |
| `editor_get_output_log` | Fetch recent output log lines (filtered) | low |
| `editor_stream_log` | Open persistent log stream (filtered by category) | medium |
| `editor_live_compile` | Trigger live C++ compile | high |
| `editor_get_performance_stats` | Get FPS, draw calls, memory stats | low |
| `editor_set_viewport_mode` | Set viewport mode (lit/unlit/wireframe) | low |

### 4.7 Scene Graph (`scene_*`)
| Command | Description | Cost |
|---|---|---|
| `scene_export` | Export semantic 3D scene graph (modes A/B/C) | medium |
| `scene_validate_physics` | Validate physics/structural integrity | medium/high |
| `scene_get_actor_relations` | Get relational triplets for specific actor | low |

### 4.8 Python Execution (`python_*`)
| Command | Description | Cost |
|---|---|---|
| `python_run` | Execute Python script in UE (3-tier safety) | varies |
| `python_stream_log` | Stream Python stdout during execution | medium |

**3-Tier Safety System:**
- **Tier 1** (read-only UE API calls) — always allowed
- **Tier 2** (editor mutations: spawn/modify/delete actors, create assets) — allowed, execution-journaled
- **Tier 3** (filesystem access, `subprocess`, `os.system`) — blocked unless `AllowUnsafePython=true` in plugin settings

Static analysis pre-pass classifies script tier before execution. Scripts classified as Tier 3 when `AllowUnsafePython=false` return an error with explanation.

### 4.9 Documentation (`docs_*`)
| Command | Description | Cost |
|---|---|---|
| `docs_lookup_class` | Look up UE class via live reflection system | low |
| `docs_lookup_api` | Look up properties/functions on a UE class | low |
| `docs_search` | Search for UE classes matching a keyword | low |

All via `TObjectIterator<UClass>` + `TFieldIterator<FProperty/UFunction>` — accurate to installed UE version.

### 4.10 PCG & PCGEx (`pcg_*`)
Existing commands migrated and aliased. New additions:
| Command | Description | Cost |
|---|---|---|
| `pcg_list_assets` | List PCG graph assets | low |
| `pcg_export_graph` | Export graph as JSON | medium |
| `pcg_create_graph` | Create graph from JSON spec | high |
| `pcg_validate_graph` | Validate graph (5-layer validation) | medium |
| `pcg_execute_graph` | Trigger graph generation | high |
| `pcg_read_node_output` | Read cached node output data | low |
| `pcg_list_node_classes` | List PCG/PCGEx node classes | low |
| `pcg_get_node_details` | Get node properties + pins | low |

### 4.11 Landscape (`landscape_*`)
Existing `import_landscape` migrated + additions:
| Command | Description | Cost |
|---|---|---|
| `landscape_import` | Import heightmap (existing) | high |
| `landscape_get_info` | Get landscape actor properties | low |
| `landscape_set_material` | Apply material to landscape | medium |
| `landscape_paint_layer` | Paint landscape layer by weight | high |

### 4.12 Foliage (`foliage_*`)
| Command | Description | Cost |
|---|---|---|
| `foliage_add_type` | Add foliage type to level | medium |
| `foliage_paint` | Paint foliage in region | high |
| `foliage_remove` | Remove foliage in region | high |
| `foliage_list` | List foliage types in level | low |

### 4.13 Spline (`spline_*`)
| Command | Description | Cost |
|---|---|---|
| `spline_create` | Create spline actor | medium |
| `spline_add_point` | Add point to spline | low |
| `spline_set_point` | Set spline point position/tangent | low |
| `spline_get_points` | Get all spline points | low |
| `spline_delete` | Delete spline actor | medium |
| `spline_set_closed` | Set spline open/closed | low |
| `spline_get_length` | Get spline total length | low |

### 4.14 World Partition (`wp_*`)
| Command | Description | Cost |
|---|---|---|
| `wp_get_cells` | Get World Partition cell grid | low |
| `wp_set_streaming` | Enable/disable streaming for cell | medium |

### 4.15 Sequencer (`seq_*`)
| Command | Description | Cost |
|---|---|---|
| `seq_create` | Create Level Sequence asset | high |
| `seq_add_track` | Add track to sequence | medium |
| `seq_add_keyframe` | Add keyframe to track | low |
| `seq_get_info` | Get sequence structure | low |
| `seq_play` | Play sequence in editor | medium |
| `seq_export` | Export sequence to video | high |
| `seq_add_camera_cut` | Add camera cut track | medium |
| `seq_set_playback_range` | Set start/end frames | low |

### 4.16 Animation (`anim_*`)
| Command | Description | Cost |
|---|---|---|
| `anim_blueprint_get_info` | Get AnimBP structure | low |
| `anim_blueprint_add_state` | Add state to state machine | medium |
| `anim_blueprint_add_transition` | Add transition between states | medium |
| `anim_blueprint_set_condition` | Set transition condition | medium |
| `anim_blueprint_compile` | Compile AnimBP | medium |

### 4.17 Niagara VFX (`niagara_*`)
| Command | Description | Cost |
|---|---|---|
| `niagara_list` | List Niagara systems | low |
| `niagara_spawn` | Spawn Niagara system at location | medium |
| `niagara_set_param` | Set Niagara parameter | low |

### 4.18 Audio (`audio_*`)
| Command | Description | Cost |
|---|---|---|
| `audio_play` | Play sound at location | low |
| `audio_list` | List sound assets | low |
| `audio_set_volume` | Set audio component volume | low |

### 4.19 MetaSound (`metasound_*`)
| Command | Description | Cost |
|---|---|---|
| `metasound_create` | Create MetaSound asset | high |
| `metasound_add_node` | Add node to MetaSound graph | medium |
| `metasound_connect` | Wire MetaSound nodes | medium |
| `metasound_set_input` | Set MetaSound input value | low |
| `metasound_compile` | Compile MetaSound | medium |
| `metasound_list` | List MetaSound assets | low |

### 4.20 Gameplay Ability System (`gas_*`)
| Command | Description | Cost |
|---|---|---|
| `gas_create_ability` | Create Gameplay Ability asset | high |
| `gas_grant_ability` | Grant ability to actor | medium |
| `gas_create_effect` | Create Gameplay Effect | high |
| `gas_apply_effect` | Apply effect to actor | medium |

### 4.21 Behavior Tree (`bt_*`)
| Command | Description | Cost |
|---|---|---|
| `bt_get_info` | Get Behavior Tree structure | low |
| `bt_add_node` | Add node to BT graph | medium |
| `bt_connect` | Wire BT nodes | medium |
| `bt_compile` | Compile Behavior Tree | medium |

### 4.22 Instanced Static Mesh (`ism_*`)
| Command | Description | Cost |
|---|---|---|
| `ism_add_instance` | Add instance to ISM component | medium |
| `ism_remove_instance` | Remove instance | medium |
| `ism_list` | List ISM actors in level | low |
| `ism_batch_add` | Add multiple instances from array | high |

### 4.23 Physics (`physics_*`)
| Command | Description | Cost |
|---|---|---|
| `physics_set_simulate` | Enable/disable physics simulation | low |
| `physics_set_collision` | Set collision profile | low |
| `physics_apply_impulse` | Apply impulse to actor | low |

### 4.24 Input (`input_*`)
| Command | Description | Cost |
|---|---|---|
| `input_create_action` | Create Input Action asset | medium |
| `input_create_mapping` | Create Input Mapping Context | medium |
| `input_add_mapping` | Add key mapping to context | low |

### 4.25 UI/UMG (`ui_*`)
| Command | Description | Cost |
|---|---|---|
| `ui_create_widget` | Create UMG Widget Blueprint | high |
| `ui_add_element` | Add UI element to widget | medium |
| `ui_query` | Query UI widget structure | low |

### 4.26 Networking (`net_*`)
| Command | Description | Cost |
|---|---|---|
| `net_debug` | Get network debug info | low |
| `net_set_replication` | Set actor replication properties | medium |

### 4.27 Static Mesh (`mesh_*`)
| Command | Description | Cost |
|---|---|---|
| `mesh_get_info` | Get mesh LODs, materials, bounds | low |
| `mesh_set_lod` | Set LOD settings | medium |
| `mesh_list` | List static mesh assets | low |

### 4.28 Texture (`texture_*`)
| Command | Description | Cost |
|---|---|---|
| `texture_get_info` | Get texture format, size, mips | low |
| `texture_set_compression` | Set compression settings | medium |
| `texture_list` | List texture assets | low |

### 4.29 Data Assets (`data_*`)
| Command | Description | Cost |
|---|---|---|
| `data_create` | Create Data Asset | medium |
| `data_get` | Read Data Asset properties | low |
| `data_set` | Write Data Asset properties | medium |

### 4.30 Project Settings (`project_*`)
| Command | Description | Cost |
|---|---|---|
| `project_get_info` | Get project name, engine version, plugins | low |
| `project_get_settings` | Read project settings section | low |
| `project_set_settings` | Write project settings | high |
| `project_list_plugins` | List enabled plugins | low |

### 4.31 Build (`build_*`)
| Command | Description | Cost |
|---|---|---|
| `build_project` | Compile project via UBT | high |
| `build_cook` | Cook content for platform | high |
| `build_generate_project_files` | Regenerate IDE project files | medium |

### 4.32 Testing (`test_*`)
| Command | Description | Cost |
|---|---|---|
| `test_list` | List available automation tests | low |
| `test_run` | Run automation tests | high |
| `test_get_log` | Get test run log | low |

### 4.33 Conventions (`conventions_*`)
Existing commands migrated. No new additions in first pass.

### 4.34 Wizard (`wizard_*`)
Existing `wizard_chat` migrated. Scaffold for future guided workflows.

---

## 5. Visual Sidecar Add-On

**Location:** `addons/visual-embeddings/`  
**Runtime:** `uv`-managed Python with `pyproject.toml`  
**Install:** `uv sync --extra gpu` (CUDA) or `uv sync --extra cpu`  
**Start:** `uv run hayba-visual-sidecar`  
**Port:** `7821` (local HTTP)

### 5.1 Model Stack

| Model | Purpose | Default | VRAM |
|---|---|---|---|
| CLIP (ViT-L/14) | Scene-level semantic embeddings | Always loaded | ~1GB |
| SpatialCLIP adapter | Spatial acuity (prepositional reasoning) | Lazy-loaded | ~200MB |
| OWLViT | Zero-shot object localization in viewport | Opt-in | ~600MB |
| Feature4X | 4D dynamic scene understanding | Deferred (Sequencer milestone) | TBD |

**Pre-trained SpatialCLIP prefix adapter checkpoint** shipped at `addons/visual-embeddings/checkpoints/spatial-clip-prefix-v1.pt`. Trained on synthetic spatial dataset. Fine-tuning guide in docs for UE-specific adaptation.

**SAM-3D dropped** — UE scene graph provides ground truth actor bounding boxes. CLIP embeddings projected onto actors by screen-space bounding box overlap using scene graph data.

### 5.2 Model Presets (in UE Plugin UI)

| Preset | Models Active | Max in Memory | VRAM Est. |
|---|---|---|---|
| **Minimal** (default) | CLIP only | 1 | ~1GB |
| **Balanced** | CLIP + 1 specialized | 2, swapped on demand | ~2GB |
| **Full** | All enabled models | Unlimited | 12GB+ ⚠️ |

VRAM estimate displayed live in plugin settings panel based on selected preset + enabled models. GPU performance warning shown for Continuous Capture mode and Full preset.

### 5.3 Viewport Capture Pipeline

1. `editor_capture_viewport` called → C++ plugin moves persistent `HaybaMCPCaptureActor` (hidden `SceneCaptureComponent2D`) to match active viewport camera transform
2. `CustomProjectionMatrix` applied to match exact FOV and aspect ratio of viewport
3. Render target captured to memory buffer
4. Buffer sent to visual sidecar via local HTTP POST to `localhost:7821/embed`
5. Sidecar runs CLIP encoder → returns 512-dim embedding vector + optional OWLViT detections
6. CLIP embeddings projected onto actors via screen-space bounding box overlap with scene graph data
7. Response returned to Claude: `{ embedding: [...], detected_objects: [...], clip_score: float }`

**Continuous Capture mode** (opt-in, config + plugin UI toggle): sidecar polls UE render target on timer, keeps cached embedding. `editor_capture_viewport` returns cached result instantly. GPU performance warning shown in settings.

### 5.4 CLIP Score Refinement Loop

`hayba_compare_clip_score` tool compares current viewport embedding against a reference image embedding:
- Reference can be a generated moodboard image, ArtStation fetch, or user-provided path
- Returns cosine similarity score (0.0–1.0)
- Claude uses this as a success criterion: score < threshold → trigger refinement loop

### 5.5 Sidecar Discovery

- MCP server pings `localhost:7821/health` on startup
- `ping` TCP command response includes `visual_embeddings_available: true/false` + `active_models: [...]`
- UE plugin Wizard Widget shows visual status indicator (🟢 connected / 🔴 unavailable / 🟡 degraded)
- Individual `editor_capture_viewport` calls degrade gracefully with clear error if sidecar goes down mid-session

---

## 6. Visual Production Pipeline (Node.js MCP Layer)

Three explicit MCP tools Claude calls at its discretion. Director Agent system prompt instructs use at start of new scene generation tasks.

| Tool | Description |
|---|---|
| `hayba_generate_moodboard` | Generate concept sketches + color palettes via image generation API (DALL-E/SD) |
| `hayba_fetch_references` | Fetch real-world reference images from ArtStation / curated datasets |
| `hayba_compare_clip_score` | Compare viewport CLIP embedding against reference image embedding |

---

## 7. Swarm Agent Architecture

### 7.1 Five Canonical Agent Archetypes

Defined in `hayba.agents.json` per-project. Canonical defaults shipped with hayba.

| Agent | Role | Tool Access | Memory Scope |
|---|---|---|---|
| **Director** | User interface + narrative planner. Converts natural language to structured scene specs. | All tools | Shared |
| **Asset Manager** | Cross-modal asset retrieval. Maps text requirements to Content Browser assets. | `asset_*`, `scene_*` | Shared |
| **Pattern Expert** | Architectural templates + procedural strategies. Spatial composition rules. | `scene_*`, `level_*`, `pcg_*` | Shared |
| **Node Expert** | PCG/PCGEx technical guidance via RAG against engine docs. Validates node connectivity. | `docs_*`, `pcg_*`, `python_*` | Shared |
| **Blueprint Generator** | Constructs final logic graphs, executes tool calls against UE. Monitors execution logs. | All tools | Private + Shared |

Archetypes are fully configurable: role description, system prompt, tool access list, memory scope. Users override per-project in `hayba.agents.json`.

### 7.2 Collaborative Agent Memory (SQLite)

**File:** `hayba-memory.db` in project directory

**Schema:**
```sql
CREATE TABLE memory_blocks (
  id TEXT PRIMARY KEY,
  agent_role TEXT NOT NULL,
  scope TEXT NOT NULL,          -- 'private' | 'shared'
  intent TEXT NOT NULL,         -- WHY this decision was made (mandatory)
  content TEXT NOT NULL,        -- WHAT was decided/found
  accessed_resources TEXT,      -- JSON array of asset paths / commands used
  timestamp INTEGER NOT NULL,
  provenance TEXT,              -- JSON: contributing agents, timestamps
  token_cost INTEGER            -- estimated tokens to load this block
);
```

**Protocol (Akashik-inspired):**
- Agents record findings with mandatory `intent` string — explains WHY, not just WHAT
- Shared blocks scored + delivered to receiving agents by role + current task + available token budget
- Private scratchpad blocks (scope=private) never surfaced to other agents
- Provenance attributes support retrospective permission checks

**Future:** Embedding column for semantic memory search added in later milestone.

---

## 8. Prompt Caching Strategy

Static content placed at Claude API prompt head with `cache_control`:
1. `HaybaToolMeta` schemas for all active tool domains
2. System instructions defining agent role
3. Macro-level scene graph (World Partition cells + cluster labels)

Dynamic content (never cached): current user request, meso/micro scene graph of active area, recent Python execution logs.

Auto-invalidation: macro scene graph re-fetched after any level-mutating command and re-placed at prompt head.

---

## 9. Workflow Skills

Installed in `~/.claude/skills/` (documented in repo getting-started as recommended add-ons).

**Location:** `addons/workflows/`

| Skill | Workflow |
|---|---|
| `hayba-new-scene` | Generate moodboard → fetch references → build macro spatial index → begin scene generation |
| `hayba-refine-scene` | Capture viewport → CLIP score vs references → identify delta → targeted edits |
| `hayba-debug-level` | Validate physics → export scene graph → stream log → identify and fix issues |
| `hayba-pcg-build` | Query PCGEx docs → sketch graph → validate → create → execute → read output |

---

## 10. Plugin UI Additions

New panels/indicators in HaybaMCPToolkit settings UI:

- **Visual Sidecar Status** — 🟢/🔴/🟡 indicator, active models list, VRAM estimate
- **Model Preset Selector** — Minimal / Balanced / Full dropdown with live VRAM display
- **Individual Model Toggles** — SpatialCLIP, OWLViT per-model enable/disable
- **Continuous Capture Toggle** — with GPU performance warning
- **Python Safety Tier** — display current tier, `AllowUnsafePython` toggle
- **Rate Limit Display** — current req/min usage
- **Execution Journal Viewer** — tail of `hayba-execution.log`
- **Capability Token** — masked input field for TCP auth token
- **Code Mode Toggle** — enable/disable progressive tool discovery

---

## 11. Getting Started Add-Ons (Repo Documentation)

The repo's getting-started guide documents three optional add-on tiers:

**Tier 1 — Core (required):** UE plugin + Node.js MCP server  
**Tier 2 — Visual Intelligence (optional):** `addons/visual-embeddings/` sidecar (`uv sync --extra gpu/cpu`)  
**Tier 3 — Workflow Skills (optional):** `addons/workflows/` skills installed to `~/.claude/skills/`

Each tier gets its own getting-started section with prerequisites, install steps, and a GPU performance warning for Tier 2.

---

## 12. Future Optimizations (Deferred)

- **Feature4X** — 4D dynamic scene understanding. Deferred to Sequencer/Animation milestone.
- **Zero-copy shared memory IPC** — `CreateFileMapping`/`MapViewOfFile` for viewport frame transfer. Currently not justified (inference dominates over 5ms HTTP transfer).
- **Semantic memory search** — embedding column on `memory_blocks` table for vector similarity queries.
- **SpatialCLIP fine-tuning** — UE-specific fine-tuning guide provided; pre-trained checkpoint sufficient for initial deployment.
- **SAM-3D** — re-evaluate if open-world scanning without scene graph becomes a use case.

---

## 13. Source Acknowledgements

Implementation adapts best-of-breed patterns from:
- **StraySpark** — 34-domain command taxonomy, category-prefix naming, 207-tool surface area
- **ChiR24/Unreal_mcp** — C++ automation bridge architecture, Blueprint graph manipulation
- **remiphilippe/mcp-unreal** — system tooling (`build_*`, `test_*`), docs reflection pattern
- **runreal/unreal-mcp** — `editor_get_world_outliner`, asset validation, Python remote execution
- **UEMCP** — `actor_snap_to_socket`, `placement_validate`, comprehensive viewport controls
- **Natfii/UnrealClaude** — AnimBP state machine editing, character configuration tools
- **3DGraphLLM** — relational triplet scene graph format
- **KeySG** — hierarchical macro/meso/micro/nano graph topology
