# Hayba Explorer

Desktop viewer for the Hayba tectonic simulation. Tauri + Rust backend + React/Three.js frontend.

**Current milestone:** v0.2 — "Wizard + Painter"

## Run

Prereqs: Rust toolchain, Node 18+, Tauri CLI.

```bash
# from this directory
npm install
npm run tauri dev
```

The desktop window opens directly into the **wizard panel** on the right.

1. Pick a **detail** preset (Quick / Balanced / High-Fidelity → peels d=32 / 64 / 96).
2. Pick a **tectonic preset** — TE's plate rasters: `plates2`, `plates3`, `plates4`, `plates5`, `plates5Uneven`. Each is a pre-baked HSV-hue PNG that the sim projects onto the icosphere to partition cells into plates.
3. Roll a **seed** if you want a different per-plate initial omega.
4. **Paint continents** — left-click and drag on the sphere; right-click drags to rotate. The brush slider scales angular radius from ~0.9° to ~14°.
5. **Bake planet** — runs the sim and shows the post-bake state. "Edit wizard" button returns to the wizard with your draft intact.

## v0.2 capabilities

- Tauri 2.x shell with embedded `hayba-tectonics-v2` Rust backend.
- Tauri commands: `start_wizard(divisions)`, `roll_seed()`, `bake_from_wizard(draft)`, plus the v0.1 `bake_demo_planet`.
- TE-faithful plate partitioning: TE's actual preset PNGs (`plates2.png` … `plates5Uneven.png`) embedded at compile time; each cell sampled per equirectangular projection; HSV-hue → plate id (rounded to 10° buckets, matching `generate-plates.ts`); HSV-value → base elevation.
- Continent painter: raycaster on a hidden unit sphere → client-side 3D kd-tree range query → brush stamps continental crust onto every cell within the angular radius.
- Wizard panel (right-side, 360px) with preset chips, seed reroll, brush-size slider, clear-continents, bake button.
- Status bar in plain language ("draft · plates4 · 40,962 cells · 1,204 painted · seed 12345…").

## Not in v0.2 — deferred milestones

- **v0.3** — MCP server + automated wizard drive + animated UI transitions for AI observability.
- **v0.4** — Cross-section view (multi-layer crust + mantle + plumes).
- **v0.5** — Time scrubbing / playback on a frame timeline.
- **v0.6** — Save / load (WorldSave JSON, Phase 13.1).
- **v1.0** — Export pipeline (equirect PNGs, PBR textures, per-cell JSON).
- **Polish** — triangulated Voronoi mesh + shaded material (currently point cloud).
- **Wizard parity** — TE's force-arrow assignment (step 3) and density-rank ordering (step 4). v0.2 auto-assigns reasonable defaults.

## Architecture

```
apps/hayba/
├── src-tauri/
│   ├── src/lib.rs       Tauri command registration
│   ├── src/planet.rs    Legacy demo bake (v0.1 path; still callable)
│   ├── src/wizard.rs    Wizard draft + bake_from_wizard (TE-faithful)
│   ├── presets/         TE's plates{2,3,4,5,5Uneven}.png — embedded
│   └── tauri.conf.json
├── src/
│   ├── App.tsx          Top-level state machine (wizard ↔ baking ↔ viewing)
│   ├── viewport/
│   │   ├── scene.ts     Three.js scene + OrbitControls (right-drag rotates)
│   │   ├── globe.ts     Point cloud with in-place recolor
│   │   └── painter.ts   Pointer events → raycast → onPaint(x,y,z)
│   ├── wizard/
│   │   ├── state.ts     WizardDraft type + defaults
│   │   ├── kdtree.ts    3D kd-tree (nearest + range query)
│   │   ├── WizardPanel.tsx
│   │   ├── PresetChips.tsx
│   │   ├── ResolutionChips.tsx
│   │   ├── SeedRow.tsx
│   │   └── BrushSlider.tsx
│   └── components/
│       └── StatusBar.tsx
└── index.html           Splash with the Hayba logo + Segoe UI chrome
```

Design tokens (`colors`, `fonts`, `radii`, `shadows`) live in `packages/hayba-design-tokens/` and are shared with the marketing site. Stack: Segoe UI / Noto Sans for UI, Consolas / Noto Sans Mono for numerics, Charis SIL is reserved for IPA samples only (not used in Explorer chrome).
