# Hayba Explorer v0.2 ("Wizard + Painter") Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Replace the hardcoded demo planet with a user-driven wizard: resolution preset, seed, plate count, **3D continent painter on the sphere**, bake. Ports TE's continent-drawing interaction faithfully — left-click paints the active plate, right-click drags to rotate.

**Architecture:**
- Wizard state lives on the frontend as a `WizardDraft` (resolution preset, seed, plate count, per-plate continent strokes).
- Three Tauri commands: `start_wizard()` returns cell positions for the chosen resolution so the frontend can build a kd-tree; `bake_from_wizard(draft)` consumes the draft and returns a `PlanetSnapshot`; `roll_seed()` returns a random u64.
- Painter: a low-poly invisible sphere acts as the raycast target. On hit, a client-side kd-tree (built from the cell positions returned by `start_wizard`) snaps to the nearest cell id. Painted cells get added to `draft.plates[active].cell_ids`, the point-cloud color buffer updates in place.
- Three.js OrbitControls rebound so left-click is free for painting (drag rotates with right or middle mouse).

**Tech Stack:** Tauri 2.x, Rust, React, Three.js, `static-kdtree` (or hand-rolled 3D kd-tree — small enough).

**Acceptance bar:**
- Wizard opens on app launch (replacing the auto-bake).
- User picks resolution preset, sees cell count update.
- User picks plate count, sees N color chips appear; clicks one to make it active.
- User paints continents on the sphere with the left mouse — cells under the cursor light up the active plate's color.
- "Bake" button runs the sim, viewport swaps to the baked planet, status bar reflects state.
- "Edit wizard" button returns to the wizard with the previous draft intact.

---

### Task 1: WizardDraft data model + Rust commands

**Files:**
- Create: `apps/hayba/src-tauri/src/wizard.rs`
- Modify: `apps/hayba/src-tauri/src/lib.rs`

- [ ] **Step 1:** Define `WizardDraft` serde struct in `wizard.rs`:
  ```rust
  #[derive(Serialize, Deserialize)]
  pub struct WizardDraft {
      pub divisions: u32,
      pub seed: u64,
      pub plates: Vec<WizardPlate>,
      pub run_length_steps: u32,  // hardcoded to 5 for v0.2; slider in v0.2.1
      pub dt_ma: f32,             // hardcoded to 0.5
  }
  #[derive(Serialize, Deserialize)]
  pub struct WizardPlate {
      pub id: u32,
      pub color_rgb: [u8; 3],
      pub density: f32,
      pub continental: bool,
      pub initial_omega: [f32; 3],
      pub cell_ids: Vec<u32>,  // explicitly painted cells (empty = no continent)
  }
  ```
- [ ] **Step 2:** Define `WizardInit` returned by `start_wizard(divisions: u32)`:
  ```rust
  #[derive(Serialize)]
  pub struct WizardInit {
      pub divisions: u32,
      pub n_cells: u32,
      pub cell_positions: Vec<f32>, // flattened, length = n_cells * 3
  }
  ```
  Implementation builds a `Grid::new(divisions)`, walks fields, returns positions.
- [ ] **Step 3:** Implement `bake_from_wizard(draft: WizardDraft) -> PlanetSnapshot`. Mirrors `planet::bake_demo` but uses the draft's plates + cell assignments. Auto-fill remaining cells across pure-ocean plates (those with `cell_ids: []` and `continental: false`).
- [ ] **Step 4:** Implement `roll_seed() -> u64` using `SplitMix64` from `hayba_tectonics_v2::determinism` seeded with `SystemTime::now()` (one-shot; deterministic replays use the seed value, not the roll).
- [ ] **Step 5:** Register all three commands in `lib.rs::run()`. Compile clean.
- [ ] **Step 6:** Add a Rust unit test that builds a `WizardDraft` with 2 plates (1 continental painted with 100 cells, 1 oceanic), calls `bake_from_wizard`, asserts the snapshot has `n_cells` matching the draft's divisions and at least 100 continental cells.
- [ ] **Step 7:** Commit `feat(hayba-explorer): wizard draft data model + bake_from_wizard (v0.2 T1)`.

### Task 2: Frontend wizard state + KD-tree

**Files:**
- Create: `apps/hayba/src/wizard/state.ts`
- Create: `apps/hayba/src/wizard/kdtree.ts`

- [ ] **Step 1:** `state.ts` exports `WizardDraft` + `WizardPlate` TS types mirroring the Rust structs, plus a `createDefaultDraft(divisions: number)` factory that pre-populates 8 plates (4 continental, 4 oceanic) with random colors from a curated Hayba palette (accent variants + secondary variants).
- [ ] **Step 2:** `kdtree.ts` exports `buildCellKdTree(positions: Float32Array)` and `nearestCell(tree, x, y, z): number`. Implementation: median-split 3D kd-tree, recursive. ~80 lines. Don't pull a dependency.
- [ ] **Step 3:** Add a unit test (Vitest) for kd-tree correctness: build a tree on 1000 random unit-sphere points, verify nearest-cell matches brute-force for 100 random query points.
- [ ] **Step 4:** Commit `feat(hayba-explorer): wizard state + kd-tree (v0.2 T2)`.

### Task 3: Wizard panel UI shell

**Files:**
- Create: `apps/hayba/src/wizard/WizardPanel.tsx`
- Create: `apps/hayba/src/wizard/ResolutionChips.tsx`
- Create: `apps/hayba/src/wizard/SeedRow.tsx`
- Create: `apps/hayba/src/wizard/PlateRow.tsx`

- [ ] **Step 1:** `WizardPanel.tsx`: right-side panel, 360px wide, full height, slate-panel background with a 1px accent left-border. Sections: title (Charis SIL "New planet"), Resolution, Seed, Plates, Continents (instruction + active plate selector), Bake button.
- [ ] **Step 2:** `ResolutionChips.tsx`: three chips Quick/Balanced/High-Fidelity (d=32/64/96). Selected chip uses accent border + filled text; idle uses border-soft. On change, fires `onChange(divisions)` so the parent can rebuild the kd-tree.
- [ ] **Step 3:** `SeedRow.tsx`: monospace seed display + "↻" reroll button (calls `roll_seed`) + manual input for power users (collapsed by default behind a "•••" toggle).
- [ ] **Step 4:** `PlateRow.tsx`: one row per plate showing the plate's color swatch, an id label, a density slider (0.30–1.20), a continental/oceanic toggle. Active-plate radio on the left (only continental plates show the radio — oceanic plates auto-fill).
- [ ] **Step 5:** Commit `feat(hayba-explorer): wizard panel shell (v0.2 T3)`.

### Task 4: Painter — raycast + active-plate paint

**Files:**
- Create: `apps/hayba/src/viewport/painter.ts`
- Modify: `apps/hayba/src/viewport/scene.ts`
- Modify: `apps/hayba/src/viewport/globe.ts`
- Modify: `apps/hayba/src/viewport/Viewport.tsx`

- [ ] **Step 1:** Rebind `OrbitControls` mouse buttons so left is free (`controls.mouseButtons = { LEFT: null, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.ROTATE }`).
- [ ] **Step 2:** Add an invisible `THREE.Mesh(SphereGeometry(1, 64, 32))` to the scene as the raycast target. Material is `MeshBasicMaterial({ visible: false })`. Tag as `name: "painter-target"`.
- [ ] **Step 3:** `painter.ts` exports `attachPainter({ canvas, camera, target, onPaintCell, getActive })`. Listens on canvas pointerdown/pointermove/pointerup with `pointerType=mouse` and `button=0`. On each event, runs a Raycaster against `target`, gets the unit-sphere hit point, fires `onPaintCell(x, y, z)` (the parent uses the kd-tree to snap to the nearest cell + add it to the active plate).
- [ ] **Step 4:** Update `buildGlobeMesh` to accept a `cellPlateMap: Int32Array` instead of just the continental flag, so we can recolor cells per the wizard's current per-plate assignments. Recolor in place via `geometry.attributes.color.needsUpdate = true` rather than rebuilding the mesh.
- [ ] **Step 5:** Commit `feat(hayba-explorer): continent painter — raycast + per-plate paint (v0.2 T4)`.

### Task 5: Wire wizard + painter + viewport in App

**Files:**
- Modify: `apps/hayba/src/App.tsx`

- [ ] **Step 1:** On mount, call `start_wizard(default_divisions=64)` to get cell positions; build the kd-tree.
- [ ] **Step 2:** Initialize `WizardDraft` state.
- [ ] **Step 3:** Render the wizard panel + viewport side by side. The viewport renders a globe colored by the *current* draft (every cell colored by its assigned plate's color, ocean cells in slate).
- [ ] **Step 4:** Painter callback: `(x, y, z) → nearestCell → update draft.plates[active].cell_ids → recolor globe`.
- [ ] **Step 5:** Resolution change: re-call `start_wizard`, rebuild kd-tree, clear paint strokes (warn user via inline copy: "Changing resolution clears continents").
- [ ] **Step 6:** "Bake" button: hides wizard, calls `bake_from_wizard(draft)`, shows status bar + final baked planet.
- [ ] **Step 7:** "Edit wizard" button (status bar): reopens the wizard with the draft intact.
- [ ] **Step 8:** Commit `feat(hayba-explorer): wire wizard + painter into App (v0.2 T5)`.

### Task 6: Polish — Hayba design treatment

**Files:**
- Modify: `apps/hayba/src/wizard/*`

- [ ] **Step 1:** Apply consistent spacing scale (8px / 12px / 16px / 24px). Use design tokens — no inline hex.
- [ ] **Step 2:** Charis SIL for section headings; Noto Sans for body and labels; Noto Sans Mono only for numbers (cell counts, seed, density values).
- [ ] **Step 3:** Hover states use the secondary palette (`#8ab5e6` / `colors.secondaryHover`), active states use accent. Avoid bright glows.
- [ ] **Step 4:** Cell-hover overlay in the painter — a faint ring around the cell under the cursor (1.5x cell size, accent at 30% alpha). No glow.
- [ ] **Step 5:** Commit `style(hayba-explorer): wizard polish — Hayba design language (v0.2 T6)`.

### Task 7: README + spec update + tag

**Files:**
- Modify: `apps/hayba/README.md`
- Modify: `docs/superpowers/specs/2026-05-14-hayba-explorer-design.md`

- [ ] **Step 1:** README: update "v0.1 capabilities" section to "v0.2 capabilities" — add wizard + painter line.
- [ ] **Step 2:** Spec: append v0.2 status section.
- [ ] **Step 3:** Tag `hayba-explorer-v0.2`.
- [ ] **Step 4:** Commit `docs(hayba-explorer): v0.2 README + spec status (v0.2 T7)`.

---

## Off-ramps

- **Kd-tree perf bad at d=96 (~92k cells).** Acceptable — 92k 3D points is still milliseconds to build. If it lags, switch to a fixed-resolution lat/lon raster (peels has one built in, exposed via `Grid::nearest_field` on the Rust side); fire `paint_cell` via Tauri command instead of client-side.
- **Painter feels laggy on pointermove.** Throttle to 30Hz with `requestAnimationFrame`. Don't fire IPC roundtrips on every move event.
- **OrbitControls right-button rotation feels wrong.** Acceptable per the design spec — Hayba Explorer treats left-click as the primary creative action (paint, place, sample). v0.2.1 can add modifier-key painting (`alt+left = paint, left = rotate`) if user feedback wants it.
- **User paints a plate's cells but doesn't paint another's.** That's fine — unpainted plates auto-fill as ocean during bake. No error state needed.
- **`bake_from_wizard` is slow for d=96 (>15s).** Show a progress indicator on the Bake button. Don't try to stream progress from Rust in v0.2 — the Tauri command channel is request-response only; streaming arrives with the MCP layer.

## Out of scope (v0.2.1+)

- Continent erasing (left-shift drag, or right-click on a continent chip's "erase" action)
- Multiple continent strokes per plate (currently one painted region per plate)
- Orbital params panel
- Run-length slider
- Save/load drafts before bake
- "Random fill" button (auto-paint continents per the demo preset)
