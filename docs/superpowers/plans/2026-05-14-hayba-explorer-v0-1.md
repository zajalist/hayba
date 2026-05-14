# Hayba Explorer v0.1 ("Hello Planet") Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the Tauri desktop app at `apps/hayba/`, embed `hayba-tectonics-v2`, render a hardcoded baked planet's initial state in a Three.js viewport with Hayba's design language. Prove the Tauri ↔ Rust ↔ webview pipeline end-to-end.

**Architecture:**
- Tauri 2.x (Rust shell + webview frontend) with the Rust backend embedded as a workspace dependency.
- One Tauri command (`bake_demo_planet`) runs an in-process bake at `divisions=64` (~40k cells), returns the initial state as a serializable payload.
- Frontend: Vite + React + TypeScript + Three.js. Loads via the local webview, calls the Tauri command on mount, renders the result.
- Hayba design tokens (`#B56A1D`, Noto Sans, Charis SIL, slate background) ship as a tiny shared `packages/hayba-design-tokens/` package.

**Tech Stack:** Tauri 2.x, Rust (workspace member), Vite 5, React 18, Three.js, TypeScript.

**Acceptance bar:** `pnpm tauri dev` (or `cargo tauri dev`) launches the app; within ~10s a planet appears in the viewport — visible continents (orange/Hayba accent on continental cells), ocean (slate-blue on oceanic cells), interactive drag-to-rotate. No console errors. Dark slate background, Hayba splash.

---

### Task 1: Repo structure + workspace wiring

**Files:**
- Create: `apps/hayba/` (directory)
- Modify: `Cargo.toml` (workspace root) — add `apps/hayba/src-tauri` as a workspace member
- Create: `packages/hayba-design-tokens/package.json`
- Create: `packages/hayba-design-tokens/index.ts` (exports tokens used by marketing site)

- [ ] **Step 1:** Confirm the workspace root `Cargo.toml` already lists `packages/hayba-tectonics-v2`. Add a new member entry for `apps/hayba/src-tauri` to the `[workspace]` members array.
- [ ] **Step 2:** Create `packages/hayba-design-tokens/package.json` with `name: "@hayba/design-tokens"`, `type: "module"`, `main: "./index.ts"`, `private: true`.
- [ ] **Step 3:** Create `packages/hayba-design-tokens/index.ts` exporting the token constants used in the marketing site:
  ```typescript
  export const colors = {
    bgDeep: "#1b1e24",
    bgBase: "#22262e",
    bgPanel: "#2a2e36",
    accent: "#B56A1D",
    accentHover: "#d77f24",
    secondary: "#6a9fdc",
    secondaryHover: "#8ab5e6",
    textPrimary: "#e5e8eb",
    textSecondary: "#a8aeb8",
    textMuted: "#6b7280",
    borderMid: "#2f343d",
    borderSoft: "#3d434e",
  } as const;
  export const fonts = {
    sans: '"Noto Sans", system-ui, sans-serif',
    serif: '"Charis SIL", Georgia, serif',
    mono: '"Noto Sans Mono", ui-monospace, monospace',
  } as const;
  ```
- [ ] **Step 4:** Commit `feat(hayba-explorer): scaffold workspace layout for v0.1`.

### Task 2: Tauri scaffold

**Files:**
- Create: `apps/hayba/src-tauri/` (whole Tauri Rust shell)
- Create: `apps/hayba/src-tauri/Cargo.toml`
- Create: `apps/hayba/src-tauri/tauri.conf.json`
- Create: `apps/hayba/src-tauri/src/main.rs`
- Create: `apps/hayba/src-tauri/src/lib.rs`
- Create: `apps/hayba/src-tauri/build.rs`
- Create: `apps/hayba/src-tauri/icons/` (use Hayba favicon from marketing site as the icon set; minimum: a 32x32 + 128x128 + 256x256 PNG)

- [ ] **Step 1:** Initialize Tauri's Rust crate at `apps/hayba/src-tauri/` with:
  ```toml
  [package]
  name = "hayba-explorer"
  version = "0.1.0"
  edition = "2021"

  [build-dependencies]
  tauri-build = { version = "2", features = [] }

  [dependencies]
  tauri = { version = "2", features = [] }
  serde = { version = "1", features = ["derive"] }
  serde_json = "1"
  hayba-tectonics-v2 = { path = "../../../packages/hayba-tectonics-v2" }
  glam = "0.27"
  ```
- [ ] **Step 2:** Create `tauri.conf.json` with:
  - `productName: "Hayba Explorer"`
  - `version: "0.1.0"`
  - `identifier: "com.hayba.explorer"`
  - `build.frontendDist: "../dist"`, `build.devUrl: "http://localhost:5173"`
  - `app.windows[0]`: title "Hayba Explorer", width 1280, height 800, decorations true, transparent false, background hex `#1b1e24`
- [ ] **Step 3:** `main.rs`: trivial entry that calls `hayba_explorer_lib::run()`.
- [ ] **Step 4:** `lib.rs`: register a `bake_demo_planet` Tauri command stub that returns `serde_json::json!({"status": "stub"})` for now. Wire `tauri::Builder::default().invoke_handler(tauri::generate_handler![bake_demo_planet]).run(...)`.
- [ ] **Step 5:** `build.rs`: standard `tauri_build::build();`.
- [ ] **Step 6:** Run `cargo check -p hayba-explorer`. Must compile clean.
- [ ] **Step 7:** Commit `feat(hayba-explorer): Tauri Rust shell scaffolded`.

### Task 3: Frontend scaffold (Vite + React + TS)

**Files:**
- Create: `apps/hayba/package.json`
- Create: `apps/hayba/vite.config.ts`
- Create: `apps/hayba/tsconfig.json`
- Create: `apps/hayba/index.html`
- Create: `apps/hayba/src/main.tsx`
- Create: `apps/hayba/src/App.tsx`
- Create: `apps/hayba/src/global.css`

- [ ] **Step 1:** `package.json` with deps: `react`, `react-dom`, `three`, `@hayba/design-tokens` (workspace:* link), `@tauri-apps/api`, devDeps: `@vitejs/plugin-react`, `vite`, `typescript`, `@types/react`, `@types/react-dom`, `@types/three`. Scripts: `dev`: `vite`, `build`: `tsc -b && vite build`, `tauri`: `tauri`.
- [ ] **Step 2:** `vite.config.ts`: enable react plugin, set `server.port: 5173`, `server.strictPort: true`, `clearScreen: false`.
- [ ] **Step 3:** `index.html`: minimal shell. Title "Hayba Explorer". Body: a `#root` div + a `#hayba-splash` div with the Hayba name in Charis SIL, centered on slate background — matches marketing-site splash.
- [ ] **Step 4:** `main.tsx`: mount React; dismiss splash on app ready.
- [ ] **Step 5:** `App.tsx`: stub — a full-viewport `<div>` with the slate background, the text "Hayba Explorer v0.1 — booting…" centered.
- [ ] **Step 6:** `global.css`: set body background to `colors.bgDeep`, default font to `fonts.sans`, no margins.
- [ ] **Step 7:** Run `pnpm install` (or `npm install`) at `apps/hayba/`. Then `pnpm dev` — verify Vite serves at localhost:5173, shows the booting placeholder.
- [ ] **Step 8:** Commit `feat(hayba-explorer): Vite frontend scaffold (boot placeholder)`.

### Task 4: Tauri ↔ frontend smoke test

**Files:**
- Modify: `apps/hayba/src-tauri/src/lib.rs`
- Modify: `apps/hayba/src/App.tsx`

- [ ] **Step 1:** In `lib.rs`, make `bake_demo_planet` return `serde_json::json!({"n_cells": 42, "message": "hello from Rust"})`.
- [ ] **Step 2:** In `App.tsx`, on mount call `invoke("bake_demo_planet")` from `@tauri-apps/api/core`. Display the returned `message` and `n_cells` on the placeholder screen.
- [ ] **Step 3:** Run `pnpm tauri dev`. Verify the desktop window opens, calls the Rust command, and the placeholder shows `hello from Rust (n_cells=42)`.
- [ ] **Step 4:** Commit `feat(hayba-explorer): Tauri ↔ frontend round-trip smoke test`.

### Task 5: Real bake — Rust side

**Files:**
- Modify: `apps/hayba/src-tauri/src/lib.rs`
- Create: `apps/hayba/src-tauri/src/planet.rs`

- [ ] **Step 1:** Create `planet.rs` that defines:
  ```rust
  use hayba_tectonics_v2::model::Model;
  use hayba_tectonics_v2::wizard::OrbitalParams;
  use serde::Serialize;

  #[derive(Serialize)]
  pub struct PlanetSnapshot {
      pub divisions: u32,
      pub n_cells: u32,
      pub cell_positions: Vec<[f32; 3]>,
      pub cell_plate_ids: Vec<i32>, // -1 for ocean
      pub cell_elevation: Vec<f32>,
      pub cell_continental: Vec<u8>,
  }

  pub fn bake_demo() -> PlanetSnapshot { /* ... */ }
  ```
  The function constructs a `Model` at `divisions=64`, runs `total_steps=20` step iterations with `dt_ma=0.5`, then dumps the final state into the snapshot.
- [ ] **Step 2:** Plate seeding — use the same 8-plate pattern from `tools/peels-audit/wizard-d32.json` (4 oceanic + 4 continental, scattered around the sphere). Hardcode it in `bake_demo`.
- [ ] **Step 3:** Wire `bake_demo_planet` in `lib.rs` to call `planet::bake_demo()` and return the snapshot via `serde_json`.
- [ ] **Step 4:** `cargo check -p hayba-explorer` compiles. Then `cargo test -p hayba-explorer planet::` — add a smoke test that asserts `bake_demo` returns a snapshot with `n_cells == 40962` and at least 4 distinct plate ids.
- [ ] **Step 5:** Commit `feat(hayba-explorer): real planet bake at divisions=64`.

### Task 6: Three.js viewport — empty scene

**Files:**
- Create: `apps/hayba/src/viewport/Viewport.tsx`
- Create: `apps/hayba/src/viewport/scene.ts`
- Modify: `apps/hayba/src/App.tsx`

- [ ] **Step 1:** `scene.ts` exports `createScene(canvas: HTMLCanvasElement)` that sets up:
  - `THREE.WebGLRenderer({ canvas, antialias: true, alpha: false })`
  - `THREE.Scene` with background `colors.bgDeep`
  - `THREE.PerspectiveCamera` at `(0, 0, 3.5)` looking at origin
  - One directional light + ambient
  - A placeholder `THREE.Mesh(SphereGeometry(1, 32, 16), MeshStandardMaterial({color: 0x444444}))` so we know rendering works
  - Animation loop driven by `requestAnimationFrame`
- [ ] **Step 2:** `Viewport.tsx` mounts a full-bleed `<canvas>` and calls `createScene` on first render. Returns the canvas in a styled wrapper.
- [ ] **Step 3:** Replace `App.tsx` body with `<Viewport />`.
- [ ] **Step 4:** Run `pnpm tauri dev`. Verify a gray sphere renders on slate background.
- [ ] **Step 5:** Commit `feat(hayba-explorer): Three.js viewport with placeholder sphere`.

### Task 7: Drag-to-rotate (OrbitControls)

**Files:**
- Modify: `apps/hayba/src/viewport/scene.ts`

- [ ] **Step 1:** Import `OrbitControls` from `three/examples/jsm/controls/OrbitControls.js`.
- [ ] **Step 2:** Wire up: damping enabled, minDistance 1.5, maxDistance 8, enableZoom true, enablePan false.
- [ ] **Step 3:** Update animation loop to call `controls.update()`.
- [ ] **Step 4:** Verify drag rotates the sphere; wheel zooms; pan disabled.
- [ ] **Step 5:** Commit `feat(hayba-explorer): orbit controls`.

### Task 8: Render real planet — globe mesh from snapshot

**Files:**
- Create: `apps/hayba/src/viewport/globe.ts`
- Modify: `apps/hayba/src/viewport/scene.ts`
- Modify: `apps/hayba/src/App.tsx`

- [ ] **Step 1:** `globe.ts` exports `buildGlobeMesh(snapshot: PlanetSnapshot): THREE.Mesh`. For v0.1, build a per-vertex-color point cloud rather than a triangulated mesh — much simpler and proves the data flow:
  ```typescript
  const geo = new THREE.BufferGeometry();
  const positions = new Float32Array(snapshot.n_cells * 3);
  const colors = new Float32Array(snapshot.n_cells * 3);
  for (let i = 0; i < snapshot.n_cells; i++) {
    positions[3*i] = snapshot.cell_positions[i][0];
    positions[3*i+1] = snapshot.cell_positions[i][1];
    positions[3*i+2] = snapshot.cell_positions[i][2];
    const isContinent = snapshot.cell_continental[i] === 1;
    const [r, g, b] = isContinent ? [0.71, 0.42, 0.11] : [0.13, 0.21, 0.34]; // accent vs ocean
    colors[3*i] = r; colors[3*i+1] = g; colors[3*i+2] = b;
  }
  geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
  return new THREE.Points(geo, new THREE.PointsMaterial({ vertexColors: true, size: 0.015 }));
  ```
- [ ] **Step 2:** `scene.ts` exposes an `addGlobe(snapshot)` method that removes the placeholder mesh and adds the globe.
- [ ] **Step 3:** `App.tsx`: on mount, invoke `bake_demo_planet`, then pass the result to the viewport via a ref or context. When the snapshot arrives, the viewport's `addGlobe` is called.
- [ ] **Step 4:** Run `pnpm tauri dev`. Verify: ~10s after launch (Rust bake takes time), the placeholder disappears and a point-cloud planet appears with orange continents and slate ocean.
- [ ] **Step 5:** Commit `feat(hayba-explorer): render baked planet as point cloud`.

### Task 9: Hayba chrome polish

**Files:**
- Create: `apps/hayba/src/components/SplashScreen.tsx`
- Create: `apps/hayba/src/components/StatusBar.tsx`
- Modify: `apps/hayba/src/App.tsx`
- Modify: `apps/hayba/src/global.css`

- [ ] **Step 1:** `SplashScreen.tsx`: full-bleed overlay with "Hayba Explorer" in Charis SIL (huge), a thin orange divider, "Worldbuilding tectonics" tagline below. Fades out on app ready. Matches marketing-site splash visually.
- [ ] **Step 2:** `StatusBar.tsx`: a 32px bar pinned to bottom of viewport showing current state in plain language: "Idle", "Baking planet…", "Planet ready — 40,962 cells, 8 plates". Stub stop button (disabled for v0.1, present so the layout is right).
- [ ] **Step 3:** `App.tsx` composes: viewport + status bar + splash (fades out when first snapshot arrives).
- [ ] **Step 4:** `global.css`: load Noto Sans + Charis SIL via Google Fonts or local woff2 files. Apply font-family to body.
- [ ] **Step 5:** Run `pnpm tauri dev`. Verify: splash on boot → fades into viewport with status bar.
- [ ] **Step 6:** Commit `feat(hayba-explorer): splash + status bar Hayba chrome`.

### Task 10: README + v0.1 milestone close

**Files:**
- Create: `apps/hayba/README.md`
- Modify: `docs/superpowers/specs/2026-05-14-hayba-explorer-design.md` — append a "v0.1 status" section

- [ ] **Step 1:** `README.md` covers: what is Hayba Explorer (link to design spec), how to run (`pnpm install && pnpm tauri dev`), v0.1 capabilities list, next-milestone roadmap.
- [ ] **Step 2:** Append to the design spec a "v0.1 status (2026-05-14)" section listing what shipped + what's deferred to v0.2.
- [ ] **Step 3:** Tag the commit `hayba-explorer-v0.1`.
- [ ] **Step 4:** Commit `docs(hayba-explorer): v0.1 README + spec status note`.

---

## Off-ramps

- **Tauri CLI not installed.** Install via `cargo install tauri-cli --version "^2.0"` or `npm install -g @tauri-apps/cli`. Document the install step in the README.
- **`hayba-tectonics-v2` API doesn't quite expose what `bake_demo` needs.** Add the missing accessor methods on the Rust side; commit them separately as a `feat(rust):` change before continuing with the planet snapshot task.
- **Three.js point cloud looks bad/sparse.** Acceptable for v0.1 — it proves the data flow. Triangulated mesh with proper Voronoi cell faces is v0.2 work.
- **Rust bake takes >30s.** Drop `total_steps` to 5 for v0.1 — we just need a baked state, not a long-run simulation.
- **Tauri 2.x APIs changed since this plan was written.** Defer to the current Tauri quickstart docs (`https://tauri.app/start/`) when wiring `invoke_handler` and `generate_handler` — the *shape* of the plan stays correct.
