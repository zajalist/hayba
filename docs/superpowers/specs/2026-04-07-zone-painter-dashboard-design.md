# Zone Painter & Dashboard Shell — Design

**Date:** 2026-04-07
**Status:** Approved
**Scope:** Spec 5a of the Gaea + PCGEx Joint Workflow series

---

## Context

This is the first of four sub-specs for the Hayba Joint Workflow:

| # | Sub-spec | Depends on |
|---|---|---|
| **5a** | **Zone Painter + Dashboard Shell** ← this spec | — |
| 5b | Gaea Zone Integration | 5a (mask PNG format) |
| 5c | PCG Zone Sampling | 5b (processed mask outputs) |
| 5d | Orchestration Tool (`hayba_scene_workflow`) | 5a + 5b + 5c |

All existing MCP tools (`hayba_bake_terrain`, `hayba_import_landscape`, etc.) remain usable independently. The orchestration tool is a guided layer on top — not a replacement.

---

## Goal

A production-quality React + Vite dashboard (UE5-style dark theme, modern skeuomorphic touches) with:

1. **Project management** — landscape projects, each with their own zone painter + encyclopedia
2. **Zone Painter** — freehand brush canvas for painting named zones; Phase A (blank) and Phase B (heightmap overlay)
3. **Per-project Encyclopedia** — science-based feature library (foliage, vegetation, rocks, props, terrain features) with sliders, FAB links, and a lore field
4. **Dashboard API** — Express endpoints for zone submission, heightmap handoff, project CRUD
5. **MCP tools** — `hayba_open_zone_painter`, `hayba_read_zones`, `hayba_set_painter_heightmap`

---

## Zone Types & Data Model

### Zone

```ts
interface Zone {
  id: string;
  name: string;                    // user-defined, e.g. "Pine Forest", "Mountain Ridge"
  color: string;                   // hex, auto-assigned, user can override
  type: 'terrain' | 'placement';
  placementCategory?:              // required when type === 'placement'
    'foliage' | 'vegetation' | 'rocks' | 'props';
  maskPath: string;                // absolute path to grayscale PNG
  visible: boolean;
}
```

**Terrain zones** (mountains, rivers, canyons, valleys, plateaus) → mask fed into Gaea nodes to shape the heightmap geometry.

**Placement zones** (foliage, vegetation, rocks, small props) → Gaea applies noise to the mask → outputs processed weight map → PCG uses for scattering.

### ZoneSession

```ts
interface ZoneSession {
  projectId: string;
  zones: Zone[];
  masks: { zoneId: string; pngPath: string }[];
  submittedAt: string;             // ISO timestamp
  canvasSize: 1024 | 2048 | 4096;
  phase: 'a' | 'b';
}
```

---

## Encyclopedia Entry

```ts
interface EncyclopediaEntry {
  id: string;
  name: string;
  scientificName?: string;
  type: 'foliage' | 'vegetation' | 'rocks' | 'props' | 'terrain-feature';
  region: string[];                // e.g. ["Boreal", "Alpine", "Mediterranean"]
  ueMeshPath: string;              // empty for base entries
  fabLink?: string;                // link to free FAB marketplace asset
  attributes: {
    densityPerM2?: number;
    heightMinM?: number;
    heightMaxM?: number;
    canopyCoverage?: number;       // 0–1
    understoryCoverage?: number;   // 0–1
    moistureRequirement?: 'low' | 'medium' | 'high';
    elevationMinM?: number;
    elevationMaxM?: number;
    slopePreference?: 'flat' | 'gentle' | 'steep' | 'any';
  };
  lore?: string;                   // free-form text, passed to AI as context when generating PCG
  isBaseEntry: boolean;            // true = shipped with toolkit, false = user-created
}
```

Base entries ship with the toolkit covering major Earth biomes. They have no `ueMeshPath` but include a `fabLink` to a free FAB asset. User-created entries go through a setup wizard.

---

## Project Storage

```
~/.hayba/projects/
  {projectId}/
    project.json        — name, createdAt, lastModified, terrain path, bake status
    zones.json          — ZoneSession (last submitted)
    masks/              — per-zone grayscale PNGs (e.g. pine-forest.png)
    encyclopedia.json   — EncyclopediaEntry[] for this project
```

Global encyclopedia templates live at `~/.hayba/encyclopedia-templates.json` — pre-populated regionally diverse base entries. When a project is created, a wizard asks "Start from templates or blank?" — selecting templates copies relevant entries into the project's `encyclopedia.json`.

---

## Dashboard Architecture

**Tech stack:** React 18, Vite, TypeScript. Static build output to `packages/hayba/dashboard/dist/`, served by the existing Express server at `localhost:52341`.

**Top-level navigation:** Four tabs with dropdowns.

| Tab | Dropdown |
|---|---|
| Projects | All Projects · New Project |
| Encyclopedia | Browse · Add Entry · Import Templates |
| PCG | Asset Browser · Generated Graphs |
| Settings | Conventions · UE Connection · Gaea Path |

**Inside a Project** (breadcrumb: Projects › {name} › {section}):

- **Overview** — terrain info, bake status, zone summary, last imported
- **Zone Painter** — canvas UI, Phase A/B toggle
- **Encyclopedia** — this project's feature library
- **PCG Graphs** — generated graphs per zone

### Zone Painter UI

- HTML5 Canvas, each zone on its own off-screen canvas layer
- Phase A: blank canvas (logical 1024×1024)
- Phase B: baked heightmap loaded as background, zones painted on top
- Brush tools: Paint, Erase, Fill, Zone Picker, Magic Brush (describe intent in natural language)
- Brush settings: Radius, Strength, Falloff (Gaussian), Opacity
- Right panel: Zone layer list (visibility toggle, color swatch, name), Brush settings, Export settings
- Left tool palette: SVG icon buttons, UE5-style (no emoji)
- Status bar: project name, zone count, phase, canvas size, Submit button
- Submit → POST to `/api/zones/submit` → dashboard stores session in memory + writes PNGs to `~/.hayba/projects/{projectId}/masks/`

### UE5 Visual Design

- Dark theme: `#0d0d0d` body, `#141414` titlebar, `#1a1a1a` panels, `#1e1e1e` canvas
- Orange accent: `#e8821c`
- Thin 1px borders at `#111–#2a2a2a`
- Modern skeuomorphism: inset shadow on canvas viewport (feels like a real surface/tablet), subtle gradients on buttons and panel headers, brush cursor circle with soft glow
- SVG icons only — no emoji
- Monospace tabular numbers for all numeric values
- Submit button: orange gradient with inset highlight (`linear-gradient(180deg, #f09030, #e07820)`)

---

## Dashboard API

New endpoints added to `src/dashboard/api.ts`:

```
POST /api/projects
  body: { name: string }
  → creates project dir + project.json, returns projectId

GET /api/projects
  → returns list of projects with summary

GET /api/projects/:projectId
  → returns project.json

POST /api/zones/submit
  body: { projectId, zones: Zone[], masks: { zoneId, pngBase64 }[] }
  → writes PNGs to masks/, saves zones.json, stores ZoneSession in memory

GET /api/zones/current/:projectId
  → returns last ZoneSession for the project

POST /api/zones/heightmap
  body: { projectId, heightmapPath }
  → stores heightmap path in memory for Phase B background

GET /api/zones/heightmap/:projectId
  → returns { heightmapPath } so frontend can load it as canvas background

GET /api/encyclopedia/:projectId
  → returns EncyclopediaEntry[] for the project

POST /api/encyclopedia/:projectId
  body: EncyclopediaEntry
  → adds or updates an entry

DELETE /api/encyclopedia/:projectId/:entryId
  → removes an entry

GET /api/encyclopedia/templates
  → returns global base entries from encyclopedia-templates.json
```

---

## MCP Tools

Three new tools registered in `src/tools/index.ts`:

### `hayba_open_zone_painter`

```ts
{
  projectId?: string;    // if omitted, creates a new project
  projectName?: string;  // used when creating a new project
  phase?: 'a' | 'b';    // default: 'a'
}
// Returns: { url: string, projectId: string, message: string }
// message: "Open http://localhost:52341 and navigate to [project] > Zone Painter"
```

Creates the project directory if needed, sets active context, returns the dashboard URL.

### `hayba_read_zones`

```ts
{
  projectId: string;
}
// Returns: { zones: Zone[], masksDir: string, submittedAt: string, phase: 'a' | 'b' }
// Error if no submission exists yet for this project
```

### `hayba_set_painter_heightmap`

```ts
{
  projectId: string;
  heightmapPath: string;  // absolute path to baked heightmap PNG/R16
}
// Returns: { ok: true }
// Side effect: dashboard Phase B canvas now loads this as background
```

Called automatically by `hayba_import_landscape` or `hayba_bake_terrain` to enable Phase B painting after a bake.

---

## Orchestration Context (from Spec 5d)

The Zone Painter is used at two points in the full scene workflow:

1. **After terrain generation** — Phase B: heightmap loaded as background, user paints adjustments or terrain-shaping zones (mountains, rivers). Alternatively, user opens in Gaea directly.
2. **Foliage/placement phase** — Phase B: same heightmap, user paints placement zones (foliage, vegetation, rocks, props). AI generates masks, shows them in dashboard, user confirms.

The full orchestration workflow is specified in Spec 5d. This spec only covers the dashboard UI and the three MCP tools above.

---

## Testing

**`tests/dashboard/zones.test.ts`**
- `POST /api/zones/submit` stores zone session and writes PNG files to project masks dir
- `GET /api/zones/current/:projectId` returns last submitted session
- `GET /api/zones/current/:projectId` returns 404 when no submission exists
- `POST /api/zones/heightmap` stores heightmap path
- `GET /api/zones/heightmap/:projectId` returns stored path

**`tests/dashboard/projects.test.ts`**
- `POST /api/projects` creates project directory and `project.json`
- `GET /api/projects` returns list of existing projects
- `GET /api/projects/:projectId` returns project metadata

**`tests/dashboard/encyclopedia.test.ts`**
- `GET /api/encyclopedia/:projectId` returns entries
- `POST /api/encyclopedia/:projectId` adds new entry
- `DELETE /api/encyclopedia/:projectId/:entryId` removes entry
- `GET /api/encyclopedia/templates` returns base entries

**`tests/tools/hayba-open-zone-painter.test.ts`**
- Returns correct dashboard URL
- Creates project directory when projectId is new
- Returns existing projectId when project already exists

**`tests/tools/hayba-read-zones.test.ts`**
- Returns zones + mask paths after a submission exists
- Returns error when no submission exists for projectId

**`tests/tools/hayba-set-painter-heightmap.test.ts`**
- Stores heightmap path, retrievable via `GET /api/zones/heightmap/:projectId`

No frontend unit tests — canvas painter verified manually. Visual regression out of scope.

---

## Out of Scope

- Ruins, structures, or building placement (future spec)
- Multiplayer / collaborative painting
- Undo history beyond in-session (no persistent undo stack)
- Exporting zones to formats other than grayscale PNG
- The `hayba_scene_workflow` orchestration tool (Spec 5d)
- Gaea mask input integration (Spec 5b)
- PCG graph generation from masks (Spec 5c)
