# Hayba Explorer (`hayba.exe`) — Design Spec

**Date:** 2026-05-14
**Status:** Spec approved; implementation begins with peels audit + TE plumbing (Phase 10.1 finish), then Hayba Explorer build.

## TL;DR

Build **`hayba.exe`** — a Tauri-based standalone desktop application — as the long-term Hayba viewer for the tectonic simulation. Position it as a **professional creator tool** that doesn't gatekeep geological knowledge: power features foregrounded, educational scaffolding available but optional. Ship with a **full MCP automation surface** so AI agents (Claude sessions, the UE plugin) can drive planet authoring while the human watches in real time.

TE (`tectonic-explorer/`) becomes a debug-only viewer; further investment in its UI/UX stops once Phase 10.1 plumbing is complete.

---

## Architecture

### The current mismatch (resolved here)

TE and Rust both use the **peels** icosphere library. Both produce cells via `10·d² + 2` where `d` is `divisions`. The mismatch we observed (cells rendering at wrong positions when TE loaded a Rust-baked `world.bin`) is **most likely a pure parameter mismatch** — TE's config sets `divisions: 32` (~10k cells) but the bundled `viz/data/world.bin` was baked at `divisions: 128` (~164k cells). Cells don't agree because the spheres have different sizes, not different recipes.

There may also be subtle drift in the Rust port of peels (off-by-one in iteration order, pentagon-pole indexing differences). We don't know without checking.

### The fix: lightweight peels audit

Verify the Rust port of peels matches the TS implementation at:

- **Layer 1 — Cell positions.** For a given `divisions`, both produce the same `n_cells` and place each cell ID at the same `(x, y, z)`. Verified by serializing both at `d=32` and diffing position arrays.
- **Layer 2 — Neighbor adjacency.** For each cell, both list the same neighbors in the same order. Verified by diffing neighbor tables.

Layer 3 (auxiliary acceleration structures) is deferred — not blocking.

### Resolution as a runtime parameter

Cell count becomes a **bake-time choice**, baked into the `WorldSave`:

| Preset | divisions | cells | feel |
|---|---|---|---|
| Quick | 32 | 10,242 | fast, chunky plates |
| Balanced | 64 | 40,962 | default — smooth, tractable sim |
| High-Fidelity | 96 | 92,162 | film-quality, slow bake |

UI: **preset chips** in the wizard (Quick / Balanced / High-Fidelity). No `divisions` number ever shown to the user.

The frame-stream header already carries `n_cells` per file, so variable resolution Just Works at the wire level. Hayba Explorer reads `n_cells` from the bin header and builds its peels sphere at the corresponding `divisions` on load.

---

## The product

### Audience and positioning

**Creator tool for worldbuilders, game devs, GMs, hobbyists.** Not K-12 education; not a marketing showcase. The user is an adult who chose to be here and wants to build planets.

But creators aren't scientists. **Educational scaffolding is layered in, not stripped out**:

- Inline `?` icons on wizard parameters open a short detail panel ("axial tilt: tilt of the rotation axis vs the orbital plane; higher tilt = stronger seasons").
- One-time first-run tour, dismissible permanently.
- Help drawer with rock-type legend, biome reference, plate-boundary type cheat-sheet — present but not foregrounded.
- **Cross-section view is first-class.** Renders multi-layer crust (sediment / sedimentary / metamorphic / igneous / mantle), lithospheric mantle column, plume columns. Geology cross-sections are a Hayba aesthetic asset and a creator screenshot magnet.

### What we drop from TE

- Wizard tutorial copy ("Now drag continents onto the planet!")
- Always-on rock-type legend
- Concord Consortium / TecRocks branding
- React-Toolbox / MobX
- Verbose labels on every panel

### What we port meticulously from TE

- **Plate motion, look, and feel.** How plates rotate, how boundaries form, the visual signature of subduction zones, mid-ocean ridges, rifts, the cross-section's geological layering. These are the simulation's identity — non-negotiable parity.
- **Boundary editing.** Click a boundary → assign convergent/divergent. Same UX, Hayba design language.
- **Wizard flow.** Continent painting on the sphere, plate seed placement, density assignment. Same steps, redone as a clean form rather than a tutorial.
- **Map modes.** Topographic, plate color, age, rock type. Plus the six new climate modes (temperature, humidity, biome, ocean currents, snow extent, crust stack) gated on real climate data.

---

## Distribution and runtime

### Form factor

**Tauri** desktop app (`hayba.exe`).
- Rust shell directly consumes `hayba-tectonics-v2` — no `world.bin` file dance for in-process bakes.
- WebGL/WebGPU frontend in the webview (React + Three.js, sharing tokens with marketing site).
- ~10–20 MB binary (vs Electron's 150+ MB).
- Cross-platform: Win/Mac/Linux from one codebase.

### Launch vectors

`hayba.exe` is launchable from:
1. **Direct user launch** (Start menu, desktop shortcut, file-association on `.haybasave.json`).
2. **UE plugin button** (HaybaMCPToolkit invokes via local IPC / launches process).
3. **MCP tool call** from a Claude Code session.

### Bundling story

`hayba.exe` is the primary product, distributed standalone (web download from hayba.com initially; Steam / Itch / paid distribution decisions deferred). The **HaybaMCPToolkit UE plugin is a separate optional download** for users who want UE integration.

---

## MCP surface — full automation with live observability

Hayba Explorer ships with an MCP server exposing the **complete authoring surface** so AI agents can drive it. **The user watches the agent drive in real time** — no headless background runs.

### Tools (v1 surface)

- `hayba_launch()` — open the app if not already open.
- `hayba_bake_planet(seed, preset, divisions, run_length_ma, orbital_params?)` — start a bake. UI animates the wizard filling in, then the bake progresses visibly.
- `hayba_load_save(path)` — load a `.haybasave.json`.
- `hayba_pin_snapshot(frame, label)` — add a named snapshot at a frame.
- `hayba_seek(frame)` — scrub the timeline.
- `hayba_set_camera(target, distance, rotation?)` — animated camera move.
- `hayba_set_colormap(mode)` — switch map mode with animated transition.
- `hayba_screenshot(view, out_path)` — capture current view / cross-section.
- `hayba_export_equirect(out_dir, layers)` — Phase 14 export pipeline.
- `hayba_get_state()` — read current planet, frame, camera, colormap (for the agent to plan next steps).

### Live-observability UX rules

- **Single-window, single-session.** No concurrent background runs. To bake, the user watches.
- **MCP call trace panel.** Plain-language ticker: *"Claude is baking planet at d=64, seed 42, 500 Ma…"* Translates technical operations.
- **Stop / take-over button always reachable.** One click freezes the agent and hands keyboard control to the user.
- **Animated transitions for every AI action.** Slider slides, dropdown opens, parameter rolls in — never an instant change that looks like a glitch.
- **AI focus overlay.** A ghostly cursor / halo on top of the live UI showing what the agent is currently touching.

This is the differentiator: *"AI agents compose planets for you while you watch"* is the pitch. Like Cursor's live coding view, but for worldbuilding.

---

## Sequencing

### This week — finish Phase 10.1 plumbing

1. **Peels audit (Layers 1 + 2).** Generate identical `divisions=32` spheres in TS (peels) and Rust (`VoronoiSphere`); diff positions and neighbor tables. Fix any drift.
2. **Plumb `divisions` through the frame-stream header.** Encoder writes it; TE PatchedSphere reads it; matches at load time.
3. **Bake a real `world.bin` at `divisions=32`.** Drop it in TE's static path so the worker can fetch it.
4. **Validate cells land in the right places visually.** Open TE with `?frameStream=true`, screenshot, confirm continents/plates look sane (no chaotic noise).
5. **Plate motion validation.** Scrub the timeline; verify plates rotate as expected given `omega` × elapsed Ma.

**Acceptance bar:** geography correct + plate motion correct. Climate plumbing, new map modes, shaders — all deferred. Done in 1–3 days.

### Weeks 2–6 — Hayba Explorer build

After Phase 10.1 plumbing lands, **stop all further TE investment** (no UI polish, no shader re-land, no new features). Pivot to Hayba Explorer:

1. **Scaffold the Tauri app.** Project structure, design tokens from marketing site, Three.js viewport, basic scene.
2. **Wire the Rust backend directly.** Embed `hayba-tectonics-v2` as a Rust dependency; expose `bake()`, `seek()`, etc. as Tauri commands.
3. **Port the planet renderer.** Globe with peels sphere mesh, plate coloring, dynamic frame playback. Goal: visual parity with TE for the tectonic-motion-and-look side.
4. **Port the wizard as a Hayba-style form** with `?` help icons.
5. **Port the cross-section view.** First-class layout; multi-layer crust + mantle + plumes.
6. **Add the MCP server.** Tauri's plugin system supports it; expose the v1 tools above.
7. **Live-observability UX.** Call-trace panel, stop button, AI focus overlay, animated transitions.
8. **Save/load + export.** WorldSave JSON, equirect PNG export.

Estimate: 3–6 weeks of focused work. Slippage likely on the cross-section view (its layered geology rendering is non-trivial).

---

## Out of scope (deferred)

- **TE shader re-land (Phase 12).** TE's Phase 12 shaders (triplanar, parallax, dynamic snow line) are reverted and stay reverted. Hayba Explorer gets new shaders designed against its own data flow.
- **Phase 14.4 UE5 importer.** Lives outside the monorepo with no VCS; coordinate with user before touching.
- **Cloud sync / auth / collaboration.** Single-user local app for v1.
- **Headless CLI.** Maybe later as `hayba-cli.exe`. For now, MCP routes through the GUI.
- **Mobile / web-only viewer.** Marketing site can embed a *screenshot* of Hayba Explorer; the live tool is desktop-only.

---

## Open questions (lower priority — decide as we go)

- Distribution: hayba.com free download vs paid (Steam / Itch / Gumroad). No decision needed for v1; ship a free download.
- Save file format: JSON for now (Phase 13.1's `WorldSave`). Binary `.haybasave` later if file sizes matter.
- Multi-planet workspaces: out of v1 scope, but the save format should accommodate it later (one save = one planet for now).
- Localization: English only for v1.

---

## v0.1 status — 2026-05-14

Shipped behind tag `hayba-explorer-v0.1`. Plan: `docs/superpowers/plans/2026-05-14-hayba-explorer-v0-1.md`. Run instructions: `apps/hayba/README.md`.

**Landed:**
- Tauri shell at `apps/hayba/src-tauri/` with `hayba-tectonics-v2` as an embedded Rust dependency.
- `bake_demo_planet` Tauri command — builds a `Model` at `divisions=64`, seeds 8 plates (4 continental + 4 oceanic) from a hardcoded preset, runs 5 steps, returns a `PlanetSnapshot` (cell positions, plate ids, elevation, continental flag).
- Vite + React + TypeScript + Three.js frontend in `apps/hayba/src/`. Scene wired with `OrbitControls`, lights, resize observer, RAF loop.
- Point-cloud globe (`buildGlobeMesh`) colored by continental flag — accent (#B56A1D) for continents, slate-blue for ocean.
- Hayba boot splash (Charis SIL serif "Hayba" + tagline), dark slate chrome, accent divider.
- `StatusBar` with state machine (idle / baking / ready / error) — Stop button present but disabled until the MCP layer lands.
- `@hayba/design-tokens` package — single source of truth for color + typography shared between marketing site and explorer.
- Rust unit test (`planet::tests::demo_bake_produces_expected_shape`) asserts shape invariants (40,962 cells, ≥4 distinct plates).

**Deferred to v0.2 and beyond per the design spec:**
- Wizard (planet is still hardcoded — drop-in slot exists at `apps/hayba/src-tauri/src/planet.rs`).
- MCP automation surface (Stop button is a placeholder).
- Time scrubbing / playback, frame timeline.
- Cross-section view.
- Climate map modes (temperature, humidity, biome, ocean currents, snow extent, crust stack).
- Triangulated Voronoi mesh + shaded material (point cloud only for v0.1).
- Save / load (`WorldSave` JSON contract exists in Rust at `packages/hayba-tectonics-v2/src/save/mod.rs`, not yet wired to the UI).
- Export pipeline (equirect PNGs, PBR textures, per-cell JSON).
- Educational tooltips, help drawer, first-run tour.

---

## v0.2 status — 2026-05-14

Shipped behind tag `hayba-explorer-v0.2`. Plan: `docs/superpowers/plans/2026-05-14-hayba-explorer-v0-2.md`.

**Landed (TE-faithful refactor):**
- Wizard panel — right-side 360px, Hayba design language (Segoe UI, slate panel, accent rail).
- Detail preset chips (peels d=32 / d=64 / d=96), tectonic preset chips (plates2 / plates3 / plates4 / plates5 / plates5Uneven), seed reroll, brush size slider, clear-continents, bake.
- **TE-faithful plate partitioning.** Each tectonic preset is TE's actual PNG raster (`tectonic-explorer/.../data/platesN.png`), embedded into the Tauri Rust binary via `include_bytes!`. Every cell sampled by equirectangular projection of its unit-sphere position. HSV-hue (rounded to 10° buckets) → plate id; HSV-value → base elevation. Algorithm matches `generate-plates.ts`.
- **Continent painter.** Left-click & drag paints continental crust over the preset's partition. Right-click drags to rotate the camera. Brush angular radius slider (~0.9° → ~14.3°). Client-side 3D kd-tree with range query batches all cells inside the brush per pointer event. User brush wins over preset elevation on overlap.
- **Status bar** — drops the glowy AI-slop dot. Now a 2px accent rail + small-caps tracked state word + Consolas/Noto Mono numerics ("draft · plates4 · 40,962 cells · 1,204 painted · seed 12345").
- **Splash + tokens.** Tokens refactored to match the marketing-restyle brief — Segoe UI / Noto Sans, `#B56A1D` filled accent, `#e8821c` text accent, Charis SIL reserved for IPA samples only (never as a heading serif). Splash uses the Hayba logo SVG inline.
- Rust unit tests cover preset partitioning (plates2 → 2 plates, plates4 → ~4) and brush-overrides-preset semantics.

**Wizard parity gaps (deferred to v0.3+):**
- TE step 3 (force assignment) — currently auto-assigns deterministic per-plate omega from the draft seed.
- TE step 4 (density rank) — currently continental plates get density 0.35, oceanic 1.05; no user override.
- Continent erasing (eraser mode toggle).
- Triangulated Voronoi mesh — viewport still renders a point cloud, not a shaded surface.
