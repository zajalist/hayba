# Hayba Explorer

Desktop viewer for the Hayba tectonic simulation. Tauri + Rust backend + React/Three.js frontend.

**Design spec:** `docs/superpowers/specs/2026-05-14-hayba-explorer-design.md`
**Current milestone:** v0.1 — "Hello Planet"

## Run

Prereqs: Rust toolchain, Node 18+, Tauri CLI.

```bash
# from this directory
npm install
npm run tauri dev
```

Within ~10s of launch the desktop window opens with a point-cloud planet —
orange continents (`#B56A1D`), slate-blue ocean, drag to rotate, wheel to
zoom. A status bar at the bottom shows bake state ("Baking demo planet…"
→ "Planet ready — 40,962 cells, 2.5 Ma").

## v0.1 capabilities

- Tauri desktop shell with embedded Rust backend (`hayba-tectonics-v2`)
- One Tauri command: `bake_demo_planet()` — hardcoded 8-plate preset at peels `divisions=64`
- React + Three.js viewport with `OrbitControls`
- Point-cloud globe colored by continental flag
- Hayba splash screen, dark slate chrome, accent divider
- Status bar with state indicator + (disabled) Stop button

## Not in v0.1 — see design spec for roadmap

- Wizard (planet is hardcoded)
- MCP server (Stop button is a placeholder)
- Time scrubbing / playback
- Cross-section view
- Climate map modes
- Save / load
- Export
- Triangulated mesh + shaders (point cloud only for v0.1)

## Architecture

```
apps/hayba/
├── src-tauri/       Rust shell (depends on packages/hayba-tectonics-v2)
│   ├── src/lib.rs   Tauri command surface
│   ├── src/planet.rs  Demo bake — drop-in for the wizard in v0.2
│   └── tauri.conf.json
├── src/             React/TS frontend
│   ├── App.tsx
│   ├── viewport/    scene.ts + Viewport.tsx + globe.ts
│   └── components/  StatusBar.tsx (more in v0.2)
└── index.html       Boot splash
```

Design tokens (`colors`, `fonts`, `radii`, `shadows`) live in
`packages/hayba-design-tokens/` and are shared with the marketing site so
the language stays consistent across surfaces.
