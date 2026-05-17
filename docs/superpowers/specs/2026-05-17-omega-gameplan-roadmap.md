# Omega Gameplan — Hayba Explorer Planet Pipeline (Roadmap / Index)

**Date:** 2026-05-17
**Branch / worktree:** `feat/baking-pipeline` · `D:\Hackathons\hayba\.claude\worktrees\baking-pipeline-fix`
**Type:** Umbrella roadmap. This is **not** a single implementable spec — it
decomposes a multi-subsystem program into phased sub-projects. **Each phase
gets its own `spec → plan → implement` cycle** when reached. Phase 0 already
has both (see refs) and is in flight.

## Pipeline

```
Compose paint → Tectonic sim → Climate/Masks → Erosion → Texturing → Atmosphere/Render
                                   (cross-cutting: Compose UI/UX finish)
```

## Standing rules (apply to EVERY phase)

- **Visual-gate before next.** No phase (or sub-task with a visible result)
  is "done" until validated on the **real GPU** and inspected by eye. Metrics
  alone never close a visual feature (`feedback_validate_visually_not_just_metrics`).
- **No concurrent app-driving agents.** One shared Vite port / single Tauri
  instance / WebView2 locks → never run a Playwright/Tauri checkpoint agent
  while the user (or another agent) drives the app; serialize
  (`feedback_no_concurrent_app_agents`).
- **TDD + green gates** (cargo `--lib`, `tsc`, vitest) before every commit;
  bare commits, no co-author trailer, stage only named files.
- **Memory:** `project_baking_pipeline_redesign` is the live status anchor.

## Visual-checkpoint protocol (the "actually test it visually" requirement)

Every checkpoint below is a **hard gate**, run one of two ways (never both
at once):

1. **Controller-run (default):** ONE serialized visual-checkpoint subagent
   drives the real Tauri+GPU instance (fresh Vite; relaunch exe with
   `--remote-debugging-port`; reap orphaned `msedgewebview2.exe`), bakes the
   scenario, captures ≥1000px PNGs at the prescribed framings + console, and
   reports. **The controller then opens the PNGs and judges with its own
   eyes** — the agent gathers evidence, the controller decides pass/fail. A
   precise negative is a valid outcome.
2. **User-run:** the user drives it (their eyes are authoritative); the
   controller does NOT dispatch an app agent in parallel.

Each checkpoint specifies: **scenario** (what to bake/where to look),
**pass criteria** (explicit), and **fail → action**. A failed checkpoint
blocks the next sub-task; tune + re-gate.

---

## Phase 0 — Erosion (IN FLIGHT)

**Spec/plan:** `docs/superpowers/specs/2026-05-16-gaea-erosion-port-design.md`
+ `docs/superpowers/plans/2026-05-16-gaea-erosion-port.md`.
**Goal:** Gaea-grade post-paint erosion + erosion = the canonical terrain
render path.

Scope: S1 (done) · S2.2 anisotropic thermal (done) · S2.4 detailMask (done)
· S2.3 flow-mask rivers + concavity/base-level anti-moat (done, in gate) ·
**S2.4→geo-climatic erodibility mask** (precip/orographic × geology proxy;
consumes a minimal Phase-2 slice — may use existing climate precip + a
geology proxy now, refined by Phase 2 later) · **S2.1** 3-class sediment ·
**S2.5** Laplacian band split (clamp-free macro preservation) · **S4**
Sea-node coastline · **S3** view-dependent re-bake **= the production
render path** (B: erosion is the canonical terrain everything downstream
sees; render-from-equirect, cells keep macro silhouette — confirm at plan
time).

**Visual checkpoints:**
- **CP0.a (now):** anti-moat `9a3bd8a` — bake Colossal→Load Earth→Bake;
  Tibet/Tarim + Peru/Andes rim **moat gone**, Afghanistan dendritic ridges
  **still strong**, no new flat/terrace. Fail → tune `concaveScale`/river.
- **CP0.b:** geo-climatic mask — Tibet/Tarim frontier reads as **smooth
  piedmont** (rain-shadow + low relief spared), wet windward flanks carved;
  not a uniform comb. A/B vs current.
- **CP0.c:** S2.1 3-class — visible sediment fans/depositional aprons at
  range fronts; no blowup; ocean/finite invariants hold (headless numeric +
  eyes).
- **CP0.d:** S2.5 band split — macro continent silhouette **preserved with
  NO clamp**; detail rides on it; round-trip identity (headless) + eyes.
- **CP0.e:** S4 — natural shelf/beach/cliff coastlines, ocean sign
  preserved, seam continuous.
- **CP0.f:** S3 — zoomed out **clean** (no noisy texels), zoom-in reveals
  micro detail, **seam invisible incl. lighting**, no stalls; rapid-pan ≤1
  in-flight bake.
- **CP0.GATE:** full eroded planet, multiple continents, eyes + headless
  numeric — gentle, ridged, rivered, mask-selective, coastlined, stable.

## Phase 1 — Tectonics simulation completion

**Spec:** future `…-tectonics-sim-completion-design.md`.
**Goal:** finish the forked Tectonic-Explorer sim into a correct, legible
modelling phase.

Scope: Wizard **boundary-type selection with clear on-canvas visual
feedback** (convergent/divergent/transform shown distinctly); **plate-layer
selection**; Simulate produces **new plate formation, realistic collisions,
orogeny, island-arc formation, stochastic volcanic events**; Boundaries /
Densities / Simulate panel polish (the panels exist; correctness + UX is
the work).

**Visual checkpoints:**
- **CP1.a:** boundary picker — each boundary type renders a visually
  distinct, unambiguous on-canvas affordance; assigning updates it live.
- **CP1.b:** plate-layer selection reflected in the globe before sim.
- **CP1.c:** run sim N steps — plates visibly move; **convergent →
  uplift/orogeny**, **divergent → rift/ridge**, transform → shear; no NaN/
  exploding plates.
- **CP1.d:** island-arc forms at an ocean-ocean convergent boundary;
  stochastic volcanism appears at plausible loci over time.
- **CP1.GATE:** a full wizard→simulate run produces a geologically
  plausible, legible evolving planet (eyes, multi-seed).

## Phase 2 — Climate & global mask system

**Spec:** future `…-climate-mask-system-design.md`.
**Refs:** Shadertoy `MdGBWG` (global wind circulation + temperature),
`XttcWn` (computed/visualized mask suite). Builds on existing `climate.rs`.
**Goal:** physically-plausible global climate + a unified, visualizable
**mask library** that Phase-0 erosion masking and Phase-3 texturing consume.

Scope: Hadley/Ferrel/Polar circulation + prevailing winds; temperature &
precip fields; orographic uplift / rain-shadow; **mask library** (slope,
elevation, aspect, flow/wetness, curvature, coast-SDF, climate) — every
mask a selectable **map-mode overlay** (XttcWn-style debug viz).

**Visual checkpoints:**
- **CP2.a:** wind/temperature map mode — bands & gyres look Earth-like;
  matches `MdGBWG` character.
- **CP2.b:** precip + rain-shadow map mode — leeward dryness visible behind
  ranges (drives CP0.b).
- **CP2.c:** each mask overlay renders correctly & is individually
  inspectable (slope/aspect/flow/curvature/coast/climate) — XttcWn-style.
- **CP2.GATE:** climate fields + full mask suite visually coherent and
  consumed correctly by erosion (re-run CP0.b with full masks).

## Phase 3 — Gaea-style texturing

**Spec:** future `…-gaea-texturing-design.md`.
**Ref:** Gaea SatMap + mask compositing. Builds on TexturingPanel/SatMap.
**Goal:** terrain materials via **SatMaps blended by the Phase-2 mask
library** exactly like Gaea (height/slope/flow/climate driven).

**Visual checkpoints:**
- **CP3.a:** a single SatMap maps onto terrain with no hex/cell artefacts.
- **CP3.b:** mask-composited multi-SatMap (rock on steep, sediment in
  valleys, snow by climate, etc.) — reads like a Gaea export, transitions
  natural, no smooth-brush opacity mush (`feedback_no_smooth_brushes_texturing`).
- **CP3.GATE:** textured eroded planet looks Gaea-grade at macro and zoom.

## Phase 4 — Atmosphere & production planet shader

**Spec:** future `…-atmosphere-render-design.md`.
**Refs:** Shadertoy `XsjGRd` (atmosphere); memory
`project_planet_shader_photoreal` (photoreal Earth-from-orbit, dossier §G.7).
**Goal:** the production planet material compositing erosion (S3) +
texturing (P3) + atmosphere — the deferred "Subsystem D".

Scope: atmospheric scattering, clouds, ocean shading, day/night terminator,
the final composite material (replaces the debug relief sphere entirely).

**Visual checkpoints:**
- **CP4.a:** atmosphere limb/scattering reads photoreal (`XsjGRd`-grade);
  terminator + ocean specular plausible.
- **CP4.b:** full composite (eroded terrain + SatMap texturing +
  atmosphere) at orbit and on zoom — photoreal Earth-from-orbit target.
- **CP4.GATE:** the planet looks like the photoreal target, end to end.

## Phase 5 — Compose finish + UI/UX unification (cross-cutting)

**Spec:** future `…-compose-finish-uiux-design.md`.
**Goal:** finish Compose end-to-end and unify the UI in the existing
`@hayba/design-tokens` ≈ hayba-l10 language (it is already the canonical
theme — **unify, do not re-theme**; UE `HaybaMCPToolkit` informs
icon/onboarding *structure* only).

Scope: erosion-as-real-step UI (delete debug button; Erosion PropertySection
in the 32px-row grid) · **bake progress** (Rust→Tauri events; no silent
freeze) · **save/load** (`save_planet`/`load_planet`) · painter perf at the
1M tiers (dirty-region updates or honest gating) · style-unification pass
(hairline/flat/accent/grid/components per the dossier; fix dup brush-radius
control; error/retry; map-mode coverage; transitions) · **optional, last:**
App.tsx monolith refactor (mode reducer + panel routing extraction).
*C2 progress and C3 save/load are independent and parallelizable anytime.*

**Visual checkpoints:**
- **CP5.a:** every Compose panel matches the dossier (spacing, borders,
  accent, mono values, 32px rows) — side-by-side vs hayba-l10 language.
- **CP5.b:** bake progress is live & honest (no frozen UI); error→retry
  works.
- **CP5.c:** save → reload → identical planet.
- **CP5.GATE:** a full Compose session looks and feels finished &
  on-brand.

---

## Dependencies & ordering

```
Phase 0 erosion ──(needs minimal climate precip + geology proxy: have now)
   │                                  ▲
   │                          Phase 2 climate/masks ──┐
   ▼                                  │               ▼
(B) canonical render path             │        Phase 3 texturing
   │                                  │               │
Phase 1 tectonics ── feeds terrain ───┘               ▼
   (panels exist; runs largely parallel)       Phase 4 atmosphere/render
                                                       │
Phase 5 UI/UX ── cross-cuts all (C2/C3 anytime) ───────┘
```

Order: **0 (in flight)** → minimal **2** slice unblocks Phase-0 full
geo-climatic mask → **1** in parallel (upstream terrain; panels exist) →
**3** (needs 0+2) → **4** (composites 0+3) → **5** cross-cuts throughout.
Visual gate before advancing each.

## Out of scope (YAGNI, this roadmap)

- Per-phase internal designs — each is its own spec at its boundary.
- Live-streamed planetary evolution — tracked post-S3 capstone (erosion
  spec §11b); revisit after Phase 0/S3.
- Aeolian/dune, debris, color-transport simulators (erosion spec §12).

## Open decisions (resolve at the owning phase's spec, non-blocking)

- Phase 0 / B: render-from-equirect vs commit-eroded-to-cells (recommend
  render-from-equirect; confirm at S3 plan time).
- Geology factor source for the geo-climatic mask: existing-data proxy
  (crust age / boundary distance / lithology noise) vs a paintable layer
  (the latter pulls Phase-5 UI in earlier).
- Phase 1 vs Phase 0 ordering if tectonic terrain changes invalidate
  erosion tuning — mitigated by erosion operating on the painted draft;
  revisit if the sim materially reshapes macro terrain.
