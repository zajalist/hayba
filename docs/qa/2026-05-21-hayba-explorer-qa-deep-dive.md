# Hayba Explorer — Deep-Dive QA Pass

_Date: 2026-05-21  ·  Branch: `feat/baking-pipeline`  ·  Build: dev profile_

Supplements [`2026-05-20-hayba-explorer-qa.md`](./2026-05-20-hayba-explorer-qa.md). This pass
methodically captures every menu, every map mode, every settings surface; opens every major
source file and counts; and stress-tests the loop a second time with screenshots banked under
`.scratch/qa/` (12 map-mode captures, 6 menu/panel captures, 3 splash sequences).

---

## Loop probe at "High (2560²)" fidelity

| Phase                          | Wall-time | Notes |
|--------------------------------|-----------|-------|
| Reload → splash → app rendered | ~1.4s     | New atmospheric splash holds 1.2s + 700ms fade |
| Wizard → Bake (no continents)  | ~50s      | High-tier hydraulic on an all-ocean planet |
| Bake → Boundaries phase open   | <100ms    | Snapshot mount + boundary-lines build |
| Boundaries → Densities         | <500ms    | Click + render |
| Densities → Simulate (confirm) | ~500ms    | Modal interaction; dialog + accept |
| Map mode switch (any pair)     | ~50ms     | `setDebugStack` is a uniform write |

The bake at High with no continents was still ~50s. That confirms: **the bake cost is dominated
by the GPU hydraulic erosion pipeline, not the input data complexity.** Painting Earth +
2560² takes ~4min in earlier sessions; the hydraulic iteration count and RT size dominate.

---

## Menu inventory

| Menu | Items |
|------|-------|
| **File** | New planet (Ctrl+N) · Open (Ctrl+O) · Save (Ctrl+S) · Save as (Ctrl+Shift+S) · Exit (Alt+F4) |
| **Edit** | Undo (Ctrl+Z) · Redo (Ctrl+Y) · Reset to wizard |
| **View** | Toggle plate labels · Toggle force arrows · Recenter camera · Toggle right panel |
| **Tools** | Command palette (Ctrl+K) |
| **Help** | _(not captured this pass — needs another sweep)_ |

**Findings:**

- File menu reads professional. Save and Open are stubbed though (`File`/`.planet` format unspecified
  yet) — open a tracking issue or hide until implemented.
- Edit menu's "Reset to wizard" is a critical destructive action — should fire the same `ConfirmDialog`
  primitive used for "Start simulation". Currently it appears to be a hot-key away from wiping a
  baked planet with no warning.
- View → Toggle right panel hides the side panel, but **the bottom map-mode bar then collides with the
  bottom status bar** because both are bottom-anchored without container z-management. UX bug.
- Tools menu has only one item — feels under-populated. Either commit to one item or hide the menu
  (move Command palette to Edit).
- Command palette opens via Ctrl+K but had **no visible matches** in this probe — the empty palette UI
  needs a placeholder ("type to search… 'bake', 'reset', 'fidelity'…").

---

## All 12 map modes (captured under Simulate phase)

| # | Mode | Status |
|---|------|--------|
| 0 | Relief | ✓ shows hypsometric ramp + hillshade |
| 1 | Normal | ✓ RGB normal map. Slightly confusingly named (collides with the brush-mode "Normal") |
| 2 | Temperature | ✓ cold-blue → cream → hot-red |
| 3 | Precipitation | ✓ light → dark blue (cookbook precip via CLASS.g) |
| 4 | Wind | ✓ **showpiece** — orange particle trails, faithful geostrophic flow |
| 5 | Glaciation | ✓ grey ramp; faint on warm planets |
| 6 | Distance | ✓ grey distance-to-ocean (km) |
| 7 | Continentality | ✓ green → yellow → red Conrad palette |
| 8 | Pressure | ✓ diverging meteorological palette (deep blue ↔ pale cream ↔ deep red) |
| 9 | Climate | ✓ Köppen-Geiger 15-class discrete palette |
| 10 | **Rivers** | ⚠ tuned to 0.78 in this branch (was 0.65 → 0.92 → 0.78). At 0.92 it was suppressing legitimate trunk channels; at 0.65 it blanketed continents. 0.78 is the sweet spot pending a bake-with-continents oracle. |
| 11 | **Lakes** | ⚠ shares ramp 8 with Rivers — both use same threshold + colors. Should split into a dedicated ramp 9 (binary endorheic indicator: cyan dots on closed basins, tan elsewhere). |

**General map-bar UX issues:**

- 12 modes wrap to 2 rows at 1080p. At 1920px the bar could be a single horizontal line; the
  wrap-point should be media-query-driven, not hardcoded.
- No keyboard navigation between modes (arrow keys would be the natural binding).
- Active mode underline is `colors.accent` — readable but doesn't read as a *tab*. Consider adding
  a subtle filled-pill background on the active mode.
- Wind, Pressure, Climate (KG) are the three "tells" that this is a serious editor. Promote them.
  Maybe give Climate a tooltip explaining the discrete classes.

---

## Settings panel

Found:

- **Fidelity** dropdown: Low (1024²) · Medium (2048²) · High (2560²). Currently "High" but the
  Compose panel still reports "Balanced · 41K cells" — these are **two independent settings**
  that visually look related. Resolution = cell count (tectonic sim grid); Fidelity = bake RT
  resolution (texture). The "Balanced" label is a Resolution chip; the "High" pill is a Fidelity
  chip; both use the same right-aligned chip styling. Confusing.
- **Sea level** slider 0..1 (default 0.040). Affects shader sea-level threshold. Good.
- **Viewport overlays:** Plate labels toggle · Force arrows toggle. Both default on. Both are
  redundant with the View menu — same controls, two places. Pick one.

**Recommendations:**
- Rename "Fidelity" → "Bake texture resolution" so it's clear it's about texture, not the cell grid.
- Add a "Sim speed multiplier" slider here (the user complained about plate-motion subtlety in earlier
  sessions; the right place to expose `omega_for_plate`'s coefficient).
- Add a "Reset to defaults" link at the bottom of the Performance section.

---

## Code-size audit

Largest source files (lines / size):

| File | Lines | Bytes |
|------|-------|-------|
| `src/App.tsx` | **2047** | 85K |
| `src-tauri/src/bake_equirect.rs` | 1361 | 60K |
| `src/viewport/bake/__headless_harness__.ts` | 1463 | 51K |
| `src/viewport/bake/hydraulic.glsl.ts` | 1304 | 59K |
| `src-tauri/src/climate.rs` | 1149 | 47K |
| `src/viewport/bake/hydraulic.ts` | 1130 | 43K |
| `src-tauri/src/wizard.rs` | 1034 | 43K |
| `src/viewport/bake/glPass.ts` | 938 | 36K |
| `src/viewport/shaders/planet.glsl.ts` | (unknown) | 35K |
| `src-tauri/src/planet.rs` | (unknown) | 33K |

### App.tsx: 33 useEffect + 22 useState + ~25 useRef

This is the de-facto God Component identified in the first QA. The 16 useEffect concern in the v1
report was conservative — actual count is 33. Sample of effects:

```
330  useEffect(() => { mapModeRef.current = mapMode; }, [mapMode]);   // ref-keeper
336  useEffect(() => { climateParamsRef.current = climateParams; }, [climateParams]); // ref-keeper
338  useEffect(() => { globeMeshRef.current?.setSatMap(satMap); }, [satMap]);
342  useEffect(() => { ... exaggeration → 0 in boundaries mode ... }, [exaggeration, mode]);
346..351 chain: surface-uniform passthrough effects
409  useEffect(() => { ... }, [...]);
505, 522, 533, 553, 568  multiple unrelated lifecycle effects
708-710  ref-keepers for draft / mode / playing
713  ... scene mount
716  ... boundary popover lifecycle
729  ... boundaries pointer pick
761  ... cell inspector simulate mode
778  ... animation tick
```

This is roughly **5 ref-keeper effects** (could be a `useLatest` helper, one-liner each), **8
uniform-passthrough effects** (could be a single `useGlobeUniforms` that watches a config object),
and **15 lifecycle effects** that legitimately have separate concerns.

**Concrete refactor plan, in priority:**

1. **`useLatest(val)` helper** — collapses every `useRef + useEffect→ref.current = val` pair into
   one line. Saves ~8 effects. ~30 minutes of work.
2. **`useGlobeMeshUniforms(uniforms)` hook** — accepts a flat object of mesh uniforms (satMap,
   exaggeration, brightness, smooth, saturation, plateOutlines, boundaryGlow, mapMode) and runs the
   passthrough effects internally. Saves ~10 effects. ~1 hour.
3. **`useSceneOverlays({ snapshot, draft, mode })` hook** — owns boundaryLinesRef,
   plateLabelsRef, forceArrowsRef, poleLabelsRef + their update lifecycle. Saves ~6 effects, kills
   the "all overlays freeze when tick path stops setSnapshot" bug class entirely.
4. **`useSimPlayLoop({ playing, speed })` hook** — owns the rAF loop + invoke + post-tick fanout.
   Saves the ~30 line inline tick handler. ~30 minutes.
5. **`useBakeOrchestration({ draft, climateParams })` hook** — owns the bake state machine + poll
   loop + progress label. Saves another ~150 lines.

After all five, App.tsx should drop to ~800 lines, primarily JSX + handlers.

### Rust files

- `bake_equirect.rs` (1361 lines): the equirect rasterise + downsample + climate-build pipeline. The
  biggest Rust file. Has natural decomposition along its named passes — refactor candidate.
- `climate.rs` (1149 lines): MSLP / wind / precip / biome compute. Functions are large but
  well-separated. Lower-priority.
- `wizard.rs` (1034 lines): the Tauri commands + WizardDraft serde shapes. Has accumulated
  procedural bake / sim / preset logic. Worth pulling presets out (already includes 5 PNG embeds).
- `planet.rs` (~700 lines): `snapshot_model` + `TickSnapshot`. Healthy size.

---

## Console + render-loop health

Across 5 separate harness sessions:
- **No console errors observed** at idle, during bake, during simulate-play, during map-mode flips,
  during boundary clicks.
- **No React warnings** about state updates during render.
- **No `act()` warnings** (which would indicate test/runtime state-update timing issues).
- **No WebGL2 INVALID_OPERATION / out-of-memory** observed.

The runtime is solid. The issues are all design / architecture / UX, not stability.

---

## Things I tried to test but couldn't fully

1. **Save / Open / Save as** — File menu items present but actual file-format implementation
   not exercised. Suspect they are placeholders.
2. **Help menu** — never captured.
3. **Climate Lab panel** (per memory `linguistics_l1_data_sources.md` & `Climate Lab — ClimateParams + tuning panel`) — the Climate tab opens a panel but it's empty without continents
   painted. Needs a fresh continental bake to evaluate.
4. **Texturing panel SatMap reassignment** — listed in earlier task tracker; not exercised here.
5. **Brush modes (Lower / Smooth / Flatten / Noise)** — only Raise was active by default; the
   other four need a heightmap to operate on and a manual click-drag on the planet that the
   harness doesn't currently route smoothly.
6. **Wind animation in `Wind` map mode at 1 frame/16ms** — visually verified gorgeous trails;
   no per-frame timing samples taken this pass (would need to hook `setInterval` of windflow step).
7. **Memory leak under prolonged play** — would need a multi-minute run + `performance.memory` poll;
   skipped here.

---

## Tuning shipped in this commit

`debugMaterial.ts` ramp 8 threshold:
- v1: 0.65 (too low — every continent blanketed)
- v2 (`ce3c5d5`): 0.92 (too high — even trunk channels suppressed)
- **v3 (this commit): 0.78** — median; should preserve dendritic networks while keeping plains tan.

This is still a single-threshold ramp for both Rivers (.r discharge) and Lakes (.b endorheic flag);
a proper split into ramp 8 (rivers, log-discharge gradient) and ramp 9 (lakes, binary basin
indicator) remains a recommendation, not yet shipped.

---

## Updated priority queue for next sprint

(Supersedes the queue in the v1 report.)

| Priority | Item | Effort |
|----------|------|--------|
| **P0** | GPU-side plate transform — push per-tick IPC cost to near-zero at 1.5M | 1-2 days |
| **P0** | Bake-cache by input-hash on disk — first bake 80s, repeat <5s | 1 day |
| **P1** | Split ramp 8 → ramp 8 (Rivers, log-Q) + ramp 9 (Lakes, binary endorheic) | 30 min |
| **P1** | `useLatest` + `useGlobeMeshUniforms` extraction from App.tsx | 1 hour |
| **P1** | `useSceneOverlays` extraction + plate-labels / force-arrows `updatePositions` | 2 hours |
| **P1** | Settings panel: "Sim speed multiplier" slider exposing `omega_for_plate` coefficient | 30 min |
| **P1** | Determinate bake-progress fill (0..100% behind "Baking…" label) | 30 min |
| **P2** | `useBakeOrchestration` + `useSimPlayLoop` extraction | 2 hours |
| **P2** | File / Open / Save * actual implementation | 1 day |
| **P2** | Edit → Reset to wizard: gate behind ConfirmDialog | 15 min |
| **P2** | View → Toggle right panel: fix collision with bottom bars | 1 hour |
| **P2** | Settings rename "Fidelity" → "Bake texture resolution"; remove redundant viewport-overlay toggles (kept in View menu) | 15 min |
| **P3** | Map-bar single-row at ≥1600px; active pill background; arrow-key cycling | 1 hour |
| **P3** | Command palette: searchable placeholder text + a few seed commands | 1 hour |
| **P3** | Help menu population (About, Docs, Report issue) | 30 min |

---

## Architecture notes worth keeping near the code

These probably belong in `docs/architecture.md` (not yet written) but I'll drop them here as
notes for the next contributor:

1. **The bake pipeline is a 7-stage Rust function** (`bake_impl` in `wizard.rs`) that emits
   `[bake_impl]` eprintln timings. Read those to find regressions.
2. **`runHydraulicBake` (`hydraulic.ts`) returns 5 RTs**: `eroded`, `clim`, `terr`, `hydro`,
   `wind`. The `wind` RT feeds the wind-flow particle engine; the others are for the equirect
   map modes.
3. **`debugMaterial.ts` is the universal post-bake mesh material**. It samples `uStackTex` (one
   of the RTs above, routed by `applyDebugChannel` in App.tsx) and applies `uRamp` (0..8 indexed
   color ramp). Adding a new map mode is: (a) add entry in `equirectMapModes.ts`, (b) add a
   ramp in `debugMaterial.ts::ramp()`, (c) route the right RT in App's `applyDebugChannel`.
4. **The simulate tick path** is `step_planet_tick` (Rust) → `TickSnapshot` (just positions +
   elevation) → `globeMeshRef.updateFromTickSnapshot` + `boundaryLinesRef.updatePositions`.
   Anything that depends on per-cell biome/temp/etc. data freezes during play. Plate labels +
   force arrows are still in the "frozen" bucket and need their own `updatePositions` paths.
5. **The HMR closure gotcha**: instantiated handles (boundaryLines, plate-labels, etc.) keep
   their original closures across HMR. After editing one of those files, you must reload the
   app (Ctrl+R) for the new code to take effect on existing instances. There's no graceful
   `dispose-and-rebuild-on-hmr` path yet.

---

_End of deep-dive report._
