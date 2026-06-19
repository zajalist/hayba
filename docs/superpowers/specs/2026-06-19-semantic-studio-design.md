# Hayba Semantic Studio — design

**Date:** 2026-06-19
**Status:** design (approved direction; pending written-spec review)
**Branch context:** builds on `feat/mcp-ux-validation-overhaul` (the shipped PLUMB core, tools, and profile/constraint stores)

## 1. Purpose

Give a creator a dedicated Unreal editor window — the **Semantic Studio** — where they (or the AI) take a freshly imported StaticMesh (e.g. from FAB), have the AI **study** it, and author the asset's **masks** and **constraints** directly on the mesh, visually. The output is a reusable **Profile** that drives validation (the PLUMB Verdict) and feeds generative tools (slivers) when building scenes.

Canonical workflow: *import door → "Study with AI" → AI bakes masks (glue faces, swing volumes, vine/decal zones) + a constraint graph → user reviews/repaints/locks → save → the door's semantics now apply to every placement everywhere.*

## 2. Core concepts

### 2.1 The mask is the unifying noun
A **mask** is an AI-baked (or human-authored) region tied to an SM, visualized in the Studio viewport. Every mask is a **separate entity** (own name, color, visibility toggle). Two geometric flavors:

- **Surface mask** — a set of mesh faces/region painted on the mesh surface. Examples: `glue_left`/`glue_right`/`glue_top` (faces that sit against walls), `vine_zone`, `decal_spots`.
- **Volume mask** — a translucent 3D shape positioned around the mesh (box / sphere / capsule / convex), manipulated with a transform gizmo. Examples: `swing_front`, `swing_back`, required clearance. **Volume masks are not painted** — they are seen as translucent volumes.

### 2.2 The constraint is the verb
A **constraint** is one of a **closed set of primitives**. Each constraint either:
- reads **pure geometry** (math only), or
- **references a mask** (the node wires a mask's region into the primitive).

Masks are nouns, primitives are verbs. Both live on the asset's **Profile**.

### 2.3 The closed primitive set (11)
The grammar never grows; authoring only fills values. Adding `surface_contact` to the shipped 10:

| # | Primitive | Gate | Default | Reads | Checks |
|---|-----------|------|---------|-------|--------|
| 1 | grounded | stability | hard | geometry | base on ground plane within tolerance (encodes pivot offsets) |
| 2 | clearance | collision | hard | mask/geom | nothing intrudes within `min_m` (point at a volume mask) |
| 3 | support_margin | stability | hard | geometry | CoM over support footprint by `min_m` |
| 4 | upright | stability | soft | geometry | tilt of up-axis under `max_deg` |
| 5 | scale_range | constraints | soft | geometry | scale within `[min,max]` |
| 6 | count_per_m2 | constraints | soft | mask/geom | density ≤ `max` over an area |
| 7 | proximity | constraints | soft | mask/geom | distance to target within `[min_m,max_m]` |
| 8 | inside_outside | constraints | soft | mask | inside/outside a region (volume mask) |
| 9 | facing | constraints | soft (qual) | mask/sem | front points at target within `max_deg` (lock to hard-gate) |
| 10 | affordance_clear | constraints | soft (qual) | surface/volume mask | named affordance region unoccluded (lock to hard-gate) |
| **11** | **surface_contact** | **stability** | **hard** | **surface mask** | **glue-mask faces sit within ε of another surface (proper anchoring); inverse of clearance** |

**`reach` gate** is dropped from the active scene-building set: kept reserved in the `GateName` enum for contract stability, always emitted as `skipped`.

## 3. Architecture: a standalone editor window (Approach 1)

A separate dockable editor window (not the level viewport, not the native SM editor), modeled on the **Material Editor** but with the **SM as the canvas** like the **Static Mesh Editor**. Authoring is per-asset, in local space. The level viewport stays a *consumer* (the Phase-4 green/red overlay shows masks + live Verdict when placing instances) — it never authors.

### 3.1 Window shell — four regions

```
┌─ Hayba Semantic Studio — SM_Door_01 ────────────────────────────────────┐
│ [Study with AI ▸] [Bake Geometry] [Save] [Export JSON] [Import]         │
├───────────────┬──────────────────────────────────────┬──────────────────┤
│ MASKS         │            3D VIEWPORT               │ INSPECTOR        │
│ ◉ glue_left   │   SM_Door_01 + mask overlays         │ (selected mask)  │
│ ◉ glue_right  │   surface masks paint on faces       │ name / type      │
│ ○ swing_front │   volume masks = translucent shapes  │ color / conf 🔒  │
│ ◉ vine_zone   │   gizmo on selected volume mask      │ mask params      │
│ [+ surface]   │                                      │                  │
│ [+ volume]    │                                      │                  │
├───────────────┴──────────────────────────────────────┴──────────────────┤
│ CONSTRAINT GRAPH  (UE5 node editor — see §4)                             │
└──────────────────────────────────────────────────────────────────────────┘
```

- **Left — Mask list.** One row per mask, color swatch + eye toggle. `+ surface` / `+ volume`.
- **Center — Viewport.** `AdvancedPreviewScene` rendering the SM alone. Surface masks render as colored overlays on faces; volume masks as translucent shapes with a transform gizmo when selected. Per-mask visibility from the list.
- **Right — Inspector.** Selected mask: name, type, color, AI confidence, lock toggle, mask-specific params.
- **Bottom — Constraint graph** (§4).

## 4. The constraint node graph

The bottom panel is a real UE5 node graph (`SGraphEditor` / `UEdGraph`, the Blueprint/Material/PCG tech) so it inherits UE5's node look. Unlike PLUMB's freeform (and broken) graph, ours is **typed and closed** — that is the entire reason it works.

### 4.1 Node kinds (the only ones that exist)
- **Mask node** — one per mask; outputs a typed `Region` pin (green).
- **Geometry node** — the baked facts (base, up/front, bounds); outputs `Geometry` pins (blue).
- **Primitive node** — the 11, and only the 11. Takes a `Region` or `Geometry` input + inline-editable params, `·hard`/`·soft` toggle; outputs a `ConstraintResult` pin (orange).
- **Gate node** — collision / stability / constraints (reach reserved, hidden).
- **Verdict node** — single output; collects gate results into the Verdict.

### 4.2 Data flow & guarantees
`Mask | Geometry → Primitive → Gate → Verdict`. Pins are **typed**: a `Region` cannot wire into `grounded` (wants `Geometry`); no expression nodes, no branches, no custom predicates. This preserves the shipped "fill values, can't write logic" guarantee — visually. **The graph compiles to the closed-primitive evaluations already implemented** (`src/plumb/evaluate.ts`); the evaluator is unchanged. The graph is the source of truth; flat `Constraint[]` is the compiled artifact.

### 4.3 AI authors into the same graph
"Study with AI" **drops nodes and wires** onto this canvas from the same palette — it does not emit hidden JSON. The result is inspectable, editable, and provably valid (typed pins + closed palette). The user watches the graph assemble, then tweaks params or unwires nodes.

### 4.4 Live feedback
Selecting a node highlights its mask overlay in the viewport. A **Verdict** run against a sample placement lights result pins/gates **green/red** with the fix vector — the same `Verdict` object, made visual.

## 5. Mask data model (additions to Profile)

Extends the shipped `Profile`. Masks supersede the crude `affordances` boxes.

```ts
type Mask = {
  id: string;
  type: 'surface' | 'volume';
  color: string;            // overlay color
  source: 'ai' | 'human';
  confidence: number;       // 0..1 (ai)
  locked: boolean;          // gates whether qualitative primitives may hard-gate
  // surface:
  triangles?: number[];     // mesh triangle indices (deterministic, v1)
  // volume:
  shape?: { kind: 'box'|'sphere'|'capsule'|'convex'; transform: Transform; extents?: [number,number,number]; radius?: number; points?: [number,number,number][] };
  detail?: string;          // free-text semantic note (e.g. "vines if abandoned")
};
```

- **Surface masks v1** store a **triangle-index set** (deterministic, exact, no texture pipeline). A UV/texture-paint upgrade is a later option.
- **Volume masks** store a shape + transform; `clearance`/`inside_outside`/`affordance_clear` reference them.
- The **constraint graph** (nodes + edges) is serialized on the Profile alongside masks; compiled to `Constraint[]` for evaluation.

## 6. AI "Study" flow
A new MCP tool (`plumb_study`, or an extension of `plumb_profile_annotate`) takes the asset + optional depth hint and returns a set of masks + a constraint graph (closed palette only). Depth is user-controllable: tier 1 placement (glue/swing/clearance) → tier 2 narrative (vine/decal zones). The plugin renders the result live in the Studio; nothing is enforced until the user reviews and (for qualitative) locks.

## 7. Semantic Library browser
A sibling tab/window listing every SM with a Profile:
- Grid/list with thumbnail, mask count, constraint count, confidence/lock badges, source (ai/human).
- Search/filter by name, primitive used, mask type, tag binding, lock state.
- Open → Semantic Studio for that asset.
- **Multi-select → bulk operations** (§8).

## 8. Bulk operations
On a multi-selection in the Library:
- Re-bake geometry, re-run AI study (with a chosen depth).
- Apply/remove a constraint template across the selection (e.g. "all trees get `grounded`").
- Set a param across the selection (e.g. `clearance.min_m = 1.0`).
- Bulk lock/unlock a field; bulk retag (reuse architecture tag axes).
- Bulk export/import.

## 9. JSON export/import
Profiles (masks + graph + constraints) export to JSON and import back — already the on-disk store format (`profiles.json` / `constraints.json` under `.scratch/`). Export = share an asset's semantics; import = adopt a library. Round-trips through the existing stores.

## 10. Quality-of-life / UX
- **Live Verdict while placing** — drag an instance in the level, see green/red gates + fix arrows (Phase-4 overlay as the consumer).
- **"Explain failure"** — click a red gate → plain-language reason + the fix vector drawn as an arrow.
- **Constraint templates per tag** — author once on `kind=tree`, all trees inherit.
- **Confidence/lock badges** everywhere; "promote AI mask to locked" one-click.
- **Diff view** — compare AI's proposed graph vs the current saved one before accepting.
- **Provenance** — who/what authored each mask + edit history (reuses `Provenance`).
- **Search by primitive/mask type** in the library.
- **Memory tab** (shipped) browses the same stores read-only as the lightweight entry point.

## 11. What is reused vs new
**Reused (shipped, tested):** the closed-primitive evaluator, Verdict assembly, profile/constraint stores, bake (cm→m, pivot offset), `mesh_get_info` bounds auto-fetch, sliver `requires` union, the Memory panel reader.

**New:**
- `surface_contact` primitive (#11) in `src/plumb/primitives.ts` + gate adjustment (`reach` reserved).
- Mask data model on `Profile`; graph serialization + graph→`Constraint[]` compile step.
- `plumb_study` MCP tool (AI emits masks + graph).
- UE plugin: the Semantic Studio window (Slate + `AdvancedPreviewScene` viewport + surface/volume mask rendering + `SGraphEditor` constraint graph), the Library browser, bulk ops, viewport overlay consumer.

## 12. Risks / open questions
- **Surface-mask representation:** triangle-index set (v1, chosen) vs UV/texture paint (richer, heavier). Revisit if face granularity is insufficient.
- **Graph ↔ flat constraints:** the graph is the source of truth; need a clean compile + a migration for the existing flat constraints (wrap each as a trivial 1-primitive graph).
- **`surface_contact` semantics:** "within ε of another surface" needs a scene-time line-trace/overlap; define ε and the surface set (any static geometry vs tagged walls).
- **Scene-level graph (deferred):** this spec is per-asset. Wiring multiple assets' masks together at scene scope is a future spec.
- **Engine coupling:** `SGraphEditor`/`UEdGraph` APIs shift between UE versions; isolate behind our own node model.

## 13. Out of scope (this spec)
- Scene-level (multi-asset) constraint graph.
- UV/texture-based surface masks.
- Runtime (in-game) evaluation; this is editor-time authoring + validation.
