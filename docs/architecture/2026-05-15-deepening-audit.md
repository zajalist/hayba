# Architecture deepening audit — 2026-05-15

Survey of the entire monorepo (apps, packages, mcp-tools, tools) for shallow
modules, leaky seams, and friction points where deepening a module would
concentrate complexity, improve testability, and improve AI-navigability.

Vocabulary follows the `improve-codebase-architecture` skill's glossary:
**module**, **interface**, **deep / shallow**, **seam**, **leverage**,
**locality**, **deletion test**.

Ranked high → low impact. Numbers are reference IDs for follow-up issues.

---

## 1. `snapshot_model` lives in the Tauri shell, not the tectonics crate

**Files**
- `apps/hayba-explorer/src-tauri/src/planet.rs` — `PlanetSnapshot` struct (lines 19-64), `snapshot_model` (200-303), `compute_slope` (166), `latitude_band` (178), `collision_kind` (187)
- `apps/hayba-explorer/src/App.tsx` — re-declares `PlanetSnapshot` as TS interface (31-51), duplicate `eraForMa` (73-92)
- `apps/hayba-explorer/src-tauri/src/wizard.rs` — calls `snapshot_model` four times

**Problem**
`snapshot_model` (~100 lines) encodes domain knowledge — what boundary cells look like, how slope is normalised, what a collision kind means — and it lives in the Tauri shell rather than the `hayba_tectonics_v2` crate. The crate has no concept of "what the renderer needs"; that knowledge is scattered. `PlanetSnapshot` is declared twice (Rust + TS) with no tooling ensuring they stay in sync.

**Symptom**
`App.tsx:73` comment: `/** Mirrors hayba_tectonics_v2::time::era_for_ma. */` — a comment that exists only because the real function is unreachable from TS. The TS copy has no tests. `collision_kind` encoding is documented in `App.tsx` as `"0=none, 1=Subduction, 2=Orogeny, 3=Buffer-kill, 4=Drag"` — a magic number protocol maintained by reading prose.

**Solution sketch**
Move `PlanetSnapshot`, `snapshot_model`, `compute_slope`, `latitude_band`, `collision_kind` into `hayba_tectonics_v2::export`. Tauri shell's `planet.rs` becomes a thin re-export. A build script generates the TS interface from the Rust struct's serde shape (or commits a `snapshot_schema.json` so drift is caught by CI). Era table in `eraForMa` is deleted; Rust returns the string.

**Why it matters**
Every new sim attribute (climate phase, precipitation, biome) must currently be wired through a four-point seam manually. Deletion test confirms it is deep: removing `snapshot_model` from `planet.rs` and moving it to the crate concentrates all field-selection logic in one tested Rust module. The seam shrinks from "multiple implicit contracts" to "one typed boundary." High leverage — hottest path in the app.

---

## 2. `App.tsx` is an 870-line god-object orchestrating five phases

**Files**
- `apps/hayba-explorer/src/App.tsx` — all 870 lines

**Problem**
Holds the lifecycle for five phases (wizard / baking / boundaries / densities / simulating), owns six `useRef`s for imperative 3D handles, drives four `useEffect` keyboard handlers, contains inline JSX for playback buttons (841-898), runs the animation tick loop (396-425), handles boundary raycasting (428-478), dispatches all Tauri `invoke` calls. Panel components receive non-overlapping prop bundles direct from `App.tsx`'s state — panels are shallow JSX skin over logic that lives upstairs.

**Symptom**
`DensitiesPanelDocked` calls `invoke("apply_density_rank")` directly (line 26), bypassing `App.tsx`'s snapshot-recolor logic, then relies on `onChange` to push the result back up. No single place where "a snapshot arrived" is handled — at least five call sites manually rebuild `BoundaryModel`, call `globeRef.current?.recolorFromSnapshot`, call `globeMeshRef.current?.updateFromSnapshot`. The pattern repeats at lines 379, 405-415, 515-516, 608-629, 694-698.

**Solution sketch**
Extract a `SimSession` (or hook) that owns the `ManagedSim` state mirror on the TS side: holds current `snapshot`, exposes `commitSnapshot(snap)` that atomically rebuilds `BoundaryModel` and triggers both renderers, emits mode-transition events. Each panel receives `SimSession`, not a bag of callbacks. Playback tick, raycasting, keyboard handlers move into named hooks (`usePlayback`, `useBoundaryPick`, `useCellInspect`). `App.tsx` becomes an orchestrator of those hooks + the layout shell.

**Why it matters**
Deletion test: if you delete `App.tsx`, every piece of logic scatters to N panels and N hooks with no home — deep, but currently un-navigable because everything lives at the same level. Extracting `commitSnapshot` alone would eliminate the five duplicate recolor sequences, making the sim-step path testable as a pure function without a React harness.

---

## 3. `PlanetSnapshot` → shader attribute pipeline is a 9-location unprotected contract

**Files**
- `apps/hayba-explorer/src/viewport/mesh.ts` — `attrNames` (35-39), `updateFromSnapshot` (88-110)
- `apps/hayba-explorer/src/viewport/shaders/planet.glsl.ts` — vertex attributes (2-12), varyings (15-27)
- `apps/hayba-explorer/src/App.tsx` — `PlanetSnapshot` interface (31-51)

**Problem**
The 11-attribute array `["elevation", "slope", "plateId", "continental", "isBoundary", "collisionKind", "subductionProgress", "orogenicUplift", "volcanicIntensity", "morAgeSteps", "crustAge"]` in `mesh.ts` (36-39) is manually kept in sync with GLSL `attribute float` declarations. Adding a sim attribute requires edits to **nine** locations with no schema linking them:
1. Rust `PlanetSnapshot` struct
2. `snapshot_model` loop
3. TS `PlanetSnapshot` interface
4. `mesh.ts` `attrNames`
5. `mesh.ts` `updateFromSnapshot` body
6. Vertex shader attributes
7. Vertex shader varyings
8. Fragment shader varyings
9. Fragment shader use

**Symptom**
`mesh.ts:105` — `attrs.morAgeSteps.set(snap.cell_mor_age_steps)` uses a `Float32Array` to hold `u16` data; the conversion happens silently because `set()` coerces. Safe today (saturates at 65535, representable in float32) but undocumented and untested.

**Solution sketch**
Canonical `CELL_ATTRS` record in one module mapping `{ snapField, glslType, normalize? }`. Vertex shader is generated from (or validated against) this record. `updateFromSnapshot` iterates the record. Rust struct gets doc-comment encoding contracts. Concentrates a 9-location contract into one typed record.

**Why it matters**
This seam breaks silently when the snapshot grows. No test catches a missing attribute — WebGL uses the previous (or zero) value. The shader compiles. The planet renders incorrectly. High urgency.

---

## 4. `hayba-mcp` `index.ts` is a 1,481-line shallow dispatcher

**Files**
- `mcp-tools/hayba-mcp/src/tools/index.ts` — 1,481 lines, all of `registerTools`

**Problem**
Every one of ~70 tools has the same 4-line body:
```ts
async (params) => {
  const r = await fooHandler(params as Record<string, unknown>, session);
  return { content: r.content, isError: r.isError };
}
```
Zod schema inline, handler imported separately, MCP boilerplate duplicated per-tool. Two coexisting error-wrapping conventions (architecture tools wrap in try/catch with `{ ok, error }` JSON; UE tools use `r.isError`).

**Solution sketch**
Extract `registerTool<T>(server, name, desc, schema, handler)` helper. Registration becomes a flat array of `{ name, schema, handler }` iterated in a loop. Architecture's custom error shape becomes a handler-side convention, not a callsite deviation. `index.ts` shrinks to ~200 lines.

**Why it matters**
AI navigation impeded — the interesting logic (handler implementation) is always two files away from the registration point with no consistent path. Deepening via a registration helper makes adding a new tool a one-liner.

---

## 5. `tools/derive_satmaps/` has three competing pipelines with no shared strategy

**Files**
- `tools/derive_satmaps/derive.py` — Earth raster + Köppen → 2D CLUT (elev × slope)
- `tools/derive_satmaps/extract.py` — satellite crop + DEM → 1D elevation LUT via k-means
- `tools/derive_satmaps/curated.py` — hand-authored OkLab gradient → 1D ramp
- `tools/derive_satmaps/biomes.py` — biome library used by `extract.py` only

**Problem**
Three scripts produce PNGs into the same output directory with no shared interface. `derive.py` outputs 256×256 2D CLUTs. `extract.py` and `curated.py` output 1D vertical strips. The shader samples all of them as `vec2(0.5, 1.0 - h)` — pure 1D vertical sample. **`derive.py`'s slope axis is silently wasted data.**

**Solution sketch**
`SatMapSpec` type (dataclass) with `output_format: "1d_elevation" | "2d_elevation_slope"`, shared by all three. A `build.py` entry imports the spec list, calls whichever strategy module is indicated, validates output dimensions match the spec.

**Why it matters**
Three scripts cannot currently be called from a single `make satmaps` because they have incompatible output contracts and no shared entry point. Adding a new biome requires choosing a script with no guidance on which is canonical.

---

## 6. `Model` exposes `pub fields: Vec<Field>` + `pub plates: Vec<Plate>` — no encapsulation

**Files**
- `apps/hayba-explorer/packages/tectonics/src/model/model.rs` — `pub struct Model { pub grid, pub fields, pub plates, … }` (72-91)
- `apps/hayba-explorer/src-tauri/src/planet.rs` — directly indexes `model.fields[fid]`, `model.grid.neighbours(fid)`, `model.plates.iter_mut()` (224-279)
- `apps/hayba-explorer/src-tauri/src/wizard.rs` — directly mutates `model.fields.get_mut`, `.crust`, `.elevation`, `.refresh_oceanic_lithosphere()` (136-145)

**Problem**
Every field of `Model` is `pub`. Tauri shell reaches directly into `model.fields[fid]` and `model.plates.iter_mut()` to perform operations that are semantically domain-level (boundary detection, slope, collision-kind encoding). Restructuring the internal representation (e.g., SOA layout for SIMD) requires changes in both the crate and the shell.

**Symptom**
`wizard.rs:136-145` directly mutates field state, bypassing any invariant `Model::add_plate` might maintain (it updates inertia; the direct mutation does not). The workaround at line 133 is documented as "idempotent for ids", addressed by calling `update_inertia_tensor` manually at line 148.

**Solution sketch**
Add `pub(crate)` or private accessors; expose named operations: `Model::apply_ocean_fill(fids, plate_id)`, `Model::boundary_scan() -> BoundaryScan`. Prerequisite-met by #1 — once `snapshot_model` lives in the crate, the shell stops needing raw access.

**Why it matters**
Makes the tectonics crate un-unit-testable from outside today: tests must replicate the same field-mutation pattern as `wizard.rs`, which is undocumented internal protocol.

---

## 7. `packages/architecture` has two parallel validation stacks

**Files**
- `packages/architecture/src/validate.ts` — v1 schema validator
- `packages/architecture/src/culture/validate.ts` — v2 culture system validator
- `packages/architecture/src/schema.ts` and `schema-v2.ts` — two schema versions with overlapping concepts
- `packages/architecture/src/kernel/`

**Problem**
Both schema versions are live — `index.ts` exports both. No documented relationship between v1 and v2. Element-registry appears to bridge but direction of travel isn't clear. AI touching the package cannot know whether to extend `validate.ts` or `culture/validate.ts`.

**Solution sketch**
Identify forward-looking schema (likely v2). Deprecate v1 exports behind `@deprecated` JSDoc + namespace re-export. `validateRange` and primitives move to `kernel/primitives.ts` shared by both validators.

**Why it matters**
Mostly plumbing — but blocks AI navigation because the package's public interface is ambiguous. Unifying makes it a clearly deep module.

---

## 8. `eraForMa` is duplicated in TS and Rust with DIFFERENT epoch tables

**Files**
- `apps/hayba-explorer/src/App.tsx` — `eraForMa` (73-92), stage-level table
- `apps/hayba-explorer/packages/tectonics/src/time/mod.rs` — `era_for_ma`, era-level groupings
- `apps/hayba-explorer/src/viewport/globe.ts` — `PLATE_PALETTE` (139-148)
- `apps/hayba-explorer/src-tauri/src/wizard.rs` — `PALETTE` (439)

**Problem**
Comment on `App.tsx:73` claims to mirror Rust — it doesn't. TS uses Holocene/Pleistocene/Pliocene (stages); Rust uses Cenozoic/Cretaceous/Jurassic (eras). `eraForMa(0.0)` returns `"Holocene"` in TS but `"Cenozoic"` in Rust. No test catches it. `PLATE_PALETTE` and `PALETTE` are parallel 8-entry color arrays, not compared or tested.

**Solution sketch**
`step_planet` returns `era_label: String` in the snapshot — eliminates the TS era table. Palette: commit a `palette.json` read by both via `include_str!` (Rust) + `import` (TS) so drift is impossible.

**Why it matters**
Lowest leverage of the 8, but highest tractability. Single source of truth for cross-language constants.

---

## Things already deep — leave alone

- **`hayba-tectonics-v2` model step loop** (`model.rs:174-276`) — 13-phase, well-documented against TE source, narrow public surface (`Model::new`, `add_plate`, `step`, `step_default`, `current_era`).
- **`linguistics` package** — clean per-concern files (phonology, phonotactics, sound-changes, derivation, romanization, name generation), tight `index.ts` re-export surface.
- **`frame-stream` package** — purpose-built binary serializer, small interface (`FrameCache`, `parseHeader`, `applyFrame`), full internal hiding.
- **`planet-physics` package** — five focused files (habitable zone, tidal locking, dynamo, atmospheric escape, stability), no internal leakage.
- **`subduction/collision.rs`** — 24KB file, 4-export public surface (`FieldCollision`, `detect_field_collisions`, `detect_field_collisions_opt`, `resolve_field_collision`).
