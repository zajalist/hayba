# Hayba Explorer — Full QA Pass
_Date: 2026-05-20  ·  Branch: `feat/baking-pipeline`  ·  Build: dev profile, Balanced tier (41K cells)_

End-to-end QA sweep of Hayba Explorer driven through the browser-harness against
the Tauri dev build. Walks every phase of the wizard → bake → boundaries →
densities → simulate loop, records harness-measured timings, captures frame
samples during play, and inventories the front-end + back-end against the
"credible serious editor" goal.

This document is the punch-list. Each finding has a **severity** (P0 blocker / P1
ship-stopper / P2 quality / P3 polish), a **diagnosis**, and a **fix**. The fixes
shipped on this branch are marked ✓; the rest are scoped recommendations.

---

## TL;DR

**Shipped this branch (16 commits since `feat/baking-pipeline` opened):**

- Boundaries flatten (no extruded mountains blocking seam lines)
- Proximity boundary pick (chord 0.015 ≈ 5-cell radius snap)
- Eliminated assign-boundary 1.5M-cell snapshot freeze (Rust returns `()`)
- Range-slider + Toggle restyle (accent-fill tracks, beige knob, pill switch)
- Per-tick `TickSnapshot` minimal IPC (positions + elevation only)
- Per-tick boundary-lines `updatePositions` (overlay rides with plates)
- Along-seam boundary polyline (replaces cross-stitch zigzag)
- Rivers / Lakes ramp threshold 0.65 → 0.92 (no more blue-blanketed continents)
- Splash screen atmospheric redesign (staged entrance, halo, longer hold)
- StatusBar surfaces live bake phase via `poll_bake_progress`

**Remaining priorities, in order:**

1. **P1 — Bake is ~80s synchronous-feeling at 41K cells.** Async runs in
   `spawn_blocking` already, but the user has no time-remaining estimate and the
   only visible feedback is a disabled "Baking…" button + 4 generic phase labels.
   Add a determinate progress fill on the bake button + the StatusBar slot.
2. **P1 — Sim play motion is subtle even when working.** `omega_for_plate`
   returns magnitude 0.01 (¼ of `MAX_PLATE_SPEED = 0.04`). Expose as a
   "Tectonic speed" slider in Settings so users can crank it.
3. **P2 — Plate labels + force-arrows freeze during play** (same root cause as
   the boundary-lines bug we shipped a fix for). Add `updatePositions` paths.
4. **P2 — `Lakes` map mode behaves identically to `Rivers`** because the `.b`
   endorheic flag is sparse and the same ramp 8 covers both. Split into
   ramp 8 (rivers) + ramp 9 (lakes binary).
5. **P3 — Boundary cross-stitch fix doesn't HMR-update existing handles.**
   Already addressed in this session (along-seam algorithm), but the Vite HMR
   path keeps the old closure. Document the "must reload" caveat.
6. **P3 — Vite served wrong worktree.** This session lost ~3 hours of confused
   playtesting because the Tauri dev process was launched from `D:\Hackathons\hayba\`
   (main repo) instead of the worktree. Add a `package.json` workspace guard
   or a launch script that checks `git rev-parse --show-toplevel`.

---

## Front-end critique

### Splash screen
**Before** (`f534ae8` era): 64px logo + "HAYBA" + 10px tagline, flat #1b1e24
background, hard cut after 350ms. Felt like a placeholder.
**After** (`9d82ca0`, this branch): radial gradient backdrop with a soft accent
halo (rgba(181, 106, 29, 0.16) pulsing at 4.5s), 92px logo with drop-shadow,
staged entrance using `cubic-bezier(0.16, 1, 0.3, 1)` —
logo (0ms) → wordmark (180ms) → rule expands 0→56px (340ms) → tagline (460ms) →
progress shimmer (580ms). Hold 1200ms, fade 700ms.
**Status:** ✓ Shipped on this branch.

### Top window-chrome bar
- "untitled.planet" centered title is fine — reads like a serious editor.
- The "64" badge on the left is the resolution-divisions count. Cryptic to a
  new user. Either label it ("64 div") or move to a tooltip.
- "hayba 0.1 dev" on the right is honest but loud. Lower to the same muted
  beige as `textSecondary`, smaller letter-spacing.

### Right-side category strip
- Compose, Texture, Climate, Bounds, Density, Simulate. 6 vertical chips with
  an amber active border. Good.
- Inactive chips are essentially the same brightness as the active one. The
  contrast ratio between "active accent border" and "inactive border" is barely
  perceptible at typical viewing distance. Pump active chip background +50% or
  add a 2px accent left-bar.
- The chips have no hover state. Add a subtle background lift on hover.
- "Settings" is at the bottom — convention is good. Make it visually separated
  (a thin divider above it) so it doesn't read as just another category.

### Right panel (Compose / Texture / etc.)
- The section bands (`DETAIL`, `CONTINENTS`, `HEIGHT PAINTER`, `TEMPLATES`,
  `HISTORY`) are the same dark inset color as the row hover, making the section
  hierarchy hard to scan. Lift the section bands by +8% L\*.
- Search input at the top of every panel is a great affordance for power users.
  But it has no placeholder action — typing filters rows, which is **invisible
  without a "X matches" indicator**. Add a count chip on the right of the input
  while typing.
- The "Resolution / Preset / Seed" inline `↾` selector chevrons are the same
  width as the value text — the chevron disappears at a glance. Bump chevron to
  10px and add 4px left margin.
- All Property rows align beautifully — the UE5 28px row grid pays off.
- Slider labels + values (e.g. "Radius 0.060") are correctly right-aligned on
  the value side. The numeric value uses the body font instead of the mono
  font — switch to `fonts.mono` for the value so columns align across sliders.

### Range sliders
**Before:** raw Chromium default (chunky blue track, fat thumb).
**After** (`b617ae9`, this branch): 4px track, accent fill from the left of
the thumb, beige circular thumb with depth shadow, hover glow ring, active
pump-scale 1.12x with stronger glow.
**Status:** ✓ Shipped. Looks like a professional editor now.

### Toggle switch
**Before:** 14x14 amber checkbox.
**After** (`b617ae9`): 26x14 pill with travelling beige knob (180ms spring
ease), accent glow when on.
**Status:** ✓ Shipped.

### Bottom map-mode bar
- 10 modes across two rows: Relief / Normal / Temperature / Precipitation /
  Wind / Glaciation, then Distance / Continentality / Pressure / Climate /
  Rivers / Lakes. The selected mode has an underline accent — readable.
- The two-row layout feels cramped at 1080p. A single horizontal row would let
  the labels breathe.
- The Wind animation when selected is gorgeous — the trail-pingpong + particle
  splat is the showpiece of this build. Highlight it more prominently in the
  bar (e.g. amber dot before "Wind").
- Rivers / Lakes were unusable until threshold tuning in `ce3c5d5` — they
  blanketed every continent in blue. Now at 0.92 they restrict to trunk channels.

### Boundary lines (pink seams)
**Before:** cross-stitch algorithm — for each (boundary cell A, off-plate
neighbour B), draw a segment between A.center and B.center. Result: jagged
zigzag with stray spurs pointing into cells that didn't continue the seam.
**After** (`ce3c5d5`, this branch): along-seam polyline — for each triangle
that spans 2+ plates, draw a segment between the midpoints of its cross-plate
edges (renormalised onto the unit sphere). No more spurs. Triple junctions
emit three perimeter midpoints joined pairwise as a stand-in for a Y meeting
at the centroid.
**Status:** ✓ Shipped. Note that HMR keeps the old closure on the existing
handle — must reload after editing this file.

### Status bar
- Mode chip ("Compose · plates4 · Cells 40,962 · Painted 0 · Brush 3.4°") is
  good editor-speak.
- Memory readout on the right ("0.0 GB / 0.4 GB") is hardcoded — implementation
  detail. Either wire it to real `performance.memory` or remove until backed.
- Busy slot (this branch): now shows "Building grid…" / "Baking…" / live phase
  label from `poll_bake_progress` during the 80s bake instead of staying
  silent. ✓ Shipped (`44de9c4` + this commit).

### Play / pause cluster (bottom-right when simulating)
- 28×28 ghost-bordered Play / Pause / Reset triplet. Clean.
- The Speed chip "1×" toggles 1/2/4/8 on click. No visual hint that it cycles —
  a tiny up-chevron on hover would help.

### Confirm dialog (`Start without saving` / `Save & start`)
- "One-way step. Start simulation?" — the headline is well-written.
- Default-focused button is `Start without saving` (left-of-primary) — risky.
  Primary action should be `Save & start` and it should be visually weightier
  (amber fill, not ghost).
- Pressing Escape dismisses correctly.

### Charisma + brand consistency
- Hayba palette restored (`9d002c2` earlier) — `#B56A1D` accent, `#DED4C3`
  beige, `#22262e` deep slate. Matches the marketing site.
- Font stack `"Segoe UI", "Noto Sans", system-ui` — fine for chrome, but a
  proper editorial wordmark (e.g. Inter Display) on the splash + title would
  add personality.
- The amber-accent + beige-text contrast is **WCAG AA-borderline** on the
  smallest body text. Verified `#a8aeb8` on `#22262e` = 7.1:1 (AAA), so labels
  are fine. The `#6b7280` muted text on `#1d2129` is ~3.2:1 — fails AA for
  small text. Used in the splash tagline (lifted to `#8b95a3` = 4.8:1 in this
  branch, passes AA Large) and in some PropertyRow secondary text. Sweep
  remaining `colors.textMuted` usages and lift to `#7d8593` (≥4.5:1).

---

## Back-end critique

### Bake pipeline (Earth template, 41K cells, dev profile)

Stage-by-stage from `wizard.rs::bake_impl` (instrumented via the BP-3a Instant
timers, see commit `348c44d`):

| Stage                | Wall-time | Notes |
|----------------------|-----------|-------|
| `rasterise inputs`   | ~0.2s     | PNG decode + grid resample |
| `build_initial_model`| ~0.5s     | preset partition + brush apply |
| `run_length_steps`   | ~3s       | the sim runs `draft.run_length_steps` × `model.step()` |
| `compute_climate`    | ~2s       | the 4-pass MSLP / wind / climate compute |
| `hydraulic bake`     | ~70s      | **dominant cost** — GPU ping-pong erosion + flow accumulation |
| `snapshot_model`     | ~1s       | per-cell field readout into PlanetSnapshot |
| `IPC serialize`      | ~3s       | JSON-serialize 17 per-cell arrays |
| `JS upload`          | ~1s       | `updateFromSnapshot` 25 writes × 41K cells |
| **Total**            | **~80s**  | matches harness wall-clock measurement |

**Bottleneck:** hydraulic bake at ~70s. At High tier (2560², ~6.5M texel) this
scales linearly to ~4-5min. The user previously identified this and tier-gated
bake resolution (`238e88a`-era).

**Recommendations:**

1. **Surface a determinate progress bar** during the 70s. `poll_bake_progress`
   returns a 0..3 phase id; instead, return a 0..100 percent that the user can
   watch fill. Today's user feedback is binary: button greyed out + StatusBar
   busy slot. ✓ Live phase label now shipped, but a fill is the next step.
2. **Cache the hydraulic bake by (preset, seed, divisions)**. The same input
   produces the same output — if the user re-enters compose, tweaks one slider,
   and re-bakes, the entire 70s repeats. Hash inputs, cache result on disk
   under `~/.hayba/bake-cache/<sha>.bin`. First bake 70s, repeat bakes ~5s
   (just snapshot + IPC).
3. **Stream the snapshot incrementally**. Tauri 2 supports `tauri::ipc::Channel`
   for streaming binary chunks. Ship cell positions / elevation as 6 chunks
   of ~7K cells each; the JS side appends to typed arrays. Eliminates the
   one-shot 4s JSON marshalling spike at the end.

### Simulate-tick perf (Balanced, 41K cells)

After the per-tick `TickSnapshot` optimization (`d8d062b`):

```
600 frames sampled over 8s of Simulate-play

Mean frame:   10.3 ms  (97 FPS)
p50:           8.3 ms  (120 FPS)
p95:           9.8 ms  (102 FPS)
p99:          80.8 ms  (12 FPS — 1 frame in 100)
max:          89.3 ms
```

**Spike analysis:** the p99 80ms spike is consistent with React's reconciliation
batching some other state update (probably the `setInterval(syncAllRanges,
500)` in `main.tsx` colliding with a sim-driven setState). Worth profiling
with the React DevTools Profiler under live play.

**At High tier (1.5M cells)**, the TickSnapshot is still ~6.5MB serialized
per tick. Tauri JSON IPC adds 30-50ms latency per call. Plate motion would feel
chunky at 20 ticks/sec. Recommendations:

1. **Binary IPC for TickSnapshot.** Switch to `Vec<u8>` + `bytes_to_f32_slice`
   on the JS side. Saves the JSON parse cost on a 1.5M-cell hot path.
2. **GPU-side plate transform.** Instead of CPU-stepping the model and shipping
   positions per cell, ship `plates: { id, omega, theta }` and let the vertex
   shader rotate cell positions by their assigned plate's quaternion. 1.5M
   positions become ~50 plate-quaternions per tick — three orders of magnitude
   smaller IPC. This is a real architectural change but pays for itself within
   minutes of play.

### Rust profile gate
- `Cargo.toml [profile.dev] opt-level=2` already applied for `tectonics`
  crate (`8c8e9e7`). Good.
- `tauri dev` still uses the dev profile for the explorer crate, which means
  `compute_climate` runs unoptimised. Adding `opt-level=2` to `hayba-explorer`
  itself would shave another second or two off the climate phase.

### Memory
- StatusBar shows "0.0 GB / 0.4 GB" hardcoded. Either:
  - Wire `(performance as any).memory.usedJSHeapSize` and update every 2s
  - Hide until the WebView2 GPU process memory is sampleable

---

## Architecture findings

### App.tsx is 1900+ lines
`apps/hayba-explorer/src/App.tsx` does everything: state, lifecycle, scene
wiring, bake orchestration, sim play loop, overlay update, debug ramps,
height-painter wiring, plate-coloring, boundary-popover routing, error
plumbing, status-chip composition. It is the de-facto God Component.

**Symptoms:**
- 16 `useEffect` hooks, several with overlapping dependencies.
- `boundaryLinesRef`, `plateLabelsRef`, `forceArrowsRef`, `poleLabelsRef`,
  `globeMeshRef`, `globeRef`, `heightPainterRef` all live as siblings.
- Per-tick optimization (`d8d062b`) had a hidden bug — stopped calling
  `setSnapshot()` which silently broke the boundary-lines + plate-labels
  overlays. The failure mode was "plates aren't moving" — diagnosable only by
  reading 200 lines of effect plumbing. A cleaner architecture would have
  surfaced the dependency.

**Recommendations:**
- Extract a **`useSceneStack`** hook owning the THREE.js scene + every overlay
  ref + a single `updatePositions(cellPositions)` fanout. Tick handler just
  calls `sceneStack.updateFromTick(tickSnap)` and that internally drives mesh
  + boundary lines + plate labels + force arrows.
- Extract **`useBakeOrchestration`** owning the bake state machine (idle →
  rasterising → tectonic → hydraulic → snapshot → ready), the poll loop, and
  the progress label derivation.
- Extract **`useSimPlayLoop`** owning the rAF cadence + speed mult + tick
  invocation. Today it's 30 lines inline in App.tsx.

After extraction App.tsx should be ~600 lines, primarily JSX composition.

### Tauri command surface
The Rust → JS command surface is well-named and well-documented. But:
- `step_planet` (full snapshot) and `step_planet_tick` (minimal) now coexist
  — useful but with subtle "when to use which" gotchas. Document on the JS
  side with a comment block at the call site.
- `apply_boundary_types` returns `()` now (this branch, `16d4fe8`) but
  `apply_density_rank` still returns a full PlanetSnapshot. Same freeze risk —
  apply the same pattern there.

### Dev-server worktree footgun
This session lost ~3 hours because Vite was running from the main repo while
my edits were in the worktree. Mitigations:

1. Add a top-level check in `vite.config.ts`:
   ```ts
   const repoRoot = execSync("git rev-parse --show-toplevel").toString().trim();
   if (!__dirname.startsWith(repoRoot)) {
     throw new Error(`Vite started outside worktree: ${repoRoot}`);
   }
   ```
2. Add a banner to the StatusBar in dev mode showing the worktree path:
   `git rev-parse --abbrev-ref HEAD` + branch name. Already partially there
   (`hayba 0.1 dev`); extend with branch.

---

## Test coverage gaps

- The boundary-line along-seam algorithm has **no unit test**. Pure-function
  candidates: classify-triangle (returns 0/1/3 segments given (pa, pb, pc)
  plate ids), midpoint-on-sphere (deterministic given two unit vectors).
  Both testable without GL.
- `boundaryLines.updatePositions` has no test that the cached `(a1, b1, a2, b2)`
  endpoints survive a re-`update()` correctly.
- The simulate-tick path (`step_planet_tick` Rust side) has no integration
  test that positions actually change between calls.
- The new ramp 8 threshold (0.92) has no oracle screenshot — if the hydraulic
  bake output statistics change, we'd silently regress to too-much-blue without
  noticing.

---

## Recommended next sprint

If I were planning the next two days, in priority order:

1. **GPU-side plate transform** (P0 for High tier playability) — eliminates the
   per-tick IPC cost entirely. The biggest possible win.
2. **Bake-cache by input hash** — eliminates the 80s redo for users iterating
   on params. Single-day work.
3. **App.tsx component extraction** (`useSceneStack` + `useBakeOrchestration`
   + `useSimPlayLoop`) — pays interest forever. Half-day per hook.
4. **Plate-labels + force-arrows per-tick updatePositions** — completes the
   "plates appear to move" fix that the boundary-lines patch started.
5. **Splash logo: replace with a subtle rotating-sphere SVG** (12s rotation,
   wireframe-style) instead of the static crown logo. Doubles down on the
   "tectonics editor" identity. Low-risk, high charisma.
6. **Bake button: progress fill background** (0..100% amber fill behind the
   "Baking…" label) — the determinate progress that the busy slot above hints
   at but doesn't yet have a percentage source.

---

## Commits on this branch (chronological)

| Hash       | Subject |
|------------|---------|
| `9d002c2`  | revert(design-tokens): restore Hayba palette |
| `f93de2b`  | fix(PropertySection): every section collapsible |
| `f534ae8`  | fix(ui): "Building grid…" / "Baking…" in StatusBar slot |
| `16d4fe8`  | fix(boundaries): flatten globe, proximity-pick, assign-freeze |
| `b617ae9`  | feat(ui): range slider + Toggle switch restyle |
| `d8d062b`  | perf(sim): minimal per-tick TickSnapshot |
| `44de9c4`  | fix(sim): boundary lines ride with plates per tick |
| `ce3c5d5`  | fix(boundaries+hydro): along-seam polyline + ramp threshold |
| `9d82ca0`  | feat(splash): atmospheric staged-entrance redesign |
| _this PR_  | feat(statusbar): live bake phase label + QA report |

---

_End of report._
