# Erosion Rework — Virtual-Pipes Hydraulic on Equirect — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the scrapped bespoke cube-sphere erosion with a small, robust virtual-pipes shallow-water hydraulic simulation on a single equirectangular grid that visibly carves terrain-responsive, precip-coupled dendritic drainage.

**Architecture:** Rust rasterizes the painted draft + climate precip to one equirect RGBA32F field; a TS orchestrator runs ~6 tiny fragment ping-pong passes (rain→flux→water/vel→erode/deposit→advect→evaporate, optional thermal) via the proven raw-WebGL2 runner `glPass.ts`; the eroded equirect drives the existing debug relief globe and downstream masks. No cube-sphere, no graph, no flow-accumulation, no CPU oracle, no parity harness.

**Tech Stack:** Rust (Tauri command), TypeScript, Three.js r0.169 (RTs/DataTextures only — never its renderer per-pass), raw WebGL2 (`glPass.ts`), GLSL ES 3.00.

**Spec:** `docs/superpowers/specs/2026-05-16-erosion-rework-hydraulic-design.md` (READ IT — all equations, constants, conventions, scope, success criteria are there and authoritative).

---

## Standing rules (ALL tasks)

- Worktree `D:\Hackathons\hayba\.claude\worktrees\baking-pipeline-fix`, branch `feat/baking-pipeline`. Bare `git commit` only. NEVER `-c`, `--no-verify`, `--no-gpg-sign`, no Claude/Co-Authored-By trailer. Stage only the exact files named in the task (never `git add -A`). No `git worktree/checkout/switch/branch/reset/restore`.
- TS tests: standalone, run via `cd apps/hayba-explorer && npx tsx <path>.test.ts`, first line `// Run: npx tsx <path>.test.ts`, `import { strict as assert } from "node:assert"`. NO vitest/jest. No headless WebGL — GPU correctness is validated VISUALLY by the user (Task 8), per the standing project rule.
- Rust tests: `cd apps/hayba-explorer/src-tauri && cargo test --lib`.
- GLSL lives in `*.glsl.ts` as arrays joined with `\n` — **ZERO backticks anywhere in a GLSL string**. Self-contained GLSL ES 3.00 (own `precision highp float; precision highp int;` + `out vec4 fragColor;`), matching `glPass.ts` program conventions (it prepends `#version 300 es` + a fullscreen-triangle VS; it parses `uniform <type> <name>;` from the frag itself — declare every uniform explicitly, one per line, no comments on the declaration line).
- Gate after every implementing task: `cd apps/hayba-explorer && npx tsc --noEmit` (zero errors) and `npm run build` (succeeds) before commit.
- Equirect convention (FIXED, used identically in Rust, GLSL, debugMaterial): texel `(rx,ry)`, `rx∈[0,W)`, `ry∈[0,H)`, **row 0 = North pole**. `lat = 90 - (ry+0.5)/H*180` (deg), `lon = (rx+0.5)/W*360 - 180` (deg). Longitude wraps (`x' = (x+dx+W)%W`); latitude clamps at poles.

---

## File structure

| File | Responsibility | Action |
|---|---|---|
| `src-tauri/src/bake_equirect.rs` | `bake_inputs_equirect` Tauri cmd: draft+climate → equirect height & precip arrays | Create |
| `src-tauri/src/lib.rs` | register `bake_inputs_equirect`; drop `erosion` mod + `bake_erode_v2`/`bake_h0_v2` | Modify |
| `src-tauri/src/wizard.rs` | remove `bake_erode_v2`/`bake_h0_v2`/`H0Atlas`; keep draft/cell helpers | Modify |
| `src-tauri/src/erosion/` | dead bespoke Rust erosion | Delete (Task 7) |
| `src/viewport/bake/equirectInput.ts` | upload a `Float32Array` → single-channel RGBA32F `THREE.DataTexture` | Create |
| `src/viewport/bake/hydraulic.glsl.ts` | the ≤7 fragment shaders (GLSL ES3, no backticks) | Create |
| `src/viewport/bake/hydraulic.ts` | sim orchestrator: alloc RTs, seed, step loop via `glPass.runRawPass`, return eroded RT | Create |
| `src/viewport/bake/pingpong.ts` | reduce to float-probe + RGBA32F RT alloc; delete bespoke/instrumentation | Modify (Task 7) |
| `src/App.tsx` | rewire `handleDebugBake` to new path; remove parity button | Modify |
| `src/viewport/bake/glPass.ts` | raw-WebGL2 runner | KEEP unchanged |
| `src/viewport/bake/debugMaterial.ts` | sphere→equirect relief + no-erosion toggle | KEEP unchanged |
| `erodePipeline.ts`,`passes.glsl.ts`,`parity.ts`,`cubesphere.ts`,`uploadH0.ts` | dead bespoke TS | Delete (Task 7) |

Sequencing keeps every commit building: add the new path first (Tasks 1–6), delete the dead pipeline last (Task 7), then user visual validation (Task 8).

---

### Task 1: Rust `bake_inputs_equirect` command

**Files:**
- Create: `apps/hayba-explorer/src-tauri/src/bake_equirect.rs`
- Modify: `apps/hayba-explorer/src-tauri/src/lib.rs` (add `mod bake_equirect;` + register the command in the `generate_handler!` list — ADDITIVE; do not remove anything yet)
- Test: in `bake_equirect.rs` `#[cfg(test)]`

**Orientation (READ before coding):** open `src-tauri/src/wizard.rs` and find the existing `painted_cells_from_draft` (or equivalent) that turns a `WizardDraft` into per-cell elevation, and how a cell maps to a unit-sphere position; open `src-tauri/src/climate.rs` (and `compute_climate`/`PlanetSnapshot`) for the per-cell **precipitation** value. Reuse those — do NOT reinvent draft parsing or climate.

- [ ] **Step 1: Write the failing test**

```rust
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn equirect_inputs_have_land_and_ocean_and_finite_precip() {
        // A draft with at least one painted continent (use the same
        // test-draft helper the wizard tests use; if none, construct a
        // minimal WizardDraft with one painted high-elevation region).
        let draft = super::test_support::one_continent_draft();
        let out = bake_inputs_equirect_impl(&draft, 64, 32);
        assert_eq!(out.w, 64);
        assert_eq!(out.h, 32);
        assert_eq!(out.height.len(), 64 * 32);
        assert_eq!(out.precip.len(), 64 * 32);
        // Some land (>0) and some ocean (<0) must exist.
        assert!(out.height.iter().any(|&v| v > 0.0), "expected some land");
        assert!(out.height.iter().any(|&v| v < 0.0), "expected some ocean");
        // Precip finite and within a sane normalized band.
        assert!(out.precip.iter().all(|&v| v.is_finite() && (0.0..=2.0).contains(&v)));
        // North-pole row (ry=0) exists and is finite.
        assert!(out.height[..64].iter().all(|v| v.is_finite()));
    }
}
```

- [ ] **Step 2: Run it — verify FAIL**

Run: `cd apps/hayba-explorer/src-tauri && cargo test --lib equirect_inputs_have_land`
Expected: FAIL (compile error — `bake_inputs_equirect_impl`/`test_support` not defined).

- [ ] **Step 3: Implement**

Define:
```rust
#[derive(serde::Serialize)]
pub struct EquirectInputs { pub w: u32, pub h: u32, pub height: Vec<f32>, pub precip: Vec<f32> }
```
`fn bake_inputs_equirect_impl(draft: &WizardDraft, w: u32, h: u32) -> EquirectInputs`:
1. Build per-cell elevation from the draft via the existing wizard helper; compute climate (existing `compute_climate`) to get per-cell precipitation.
2. For `ry in 0..h`, `rx in 0..w`: `lat = 90.0 - (ry as f32 + 0.5)/h as f32 * 180.0`; `lon = (rx as f32 + 0.5)/w as f32 * 360.0 - 180.0`; convert (lat,lon)→unit sphere `(x,y,z)`; find the **nearest painted cell** to that direction (reuse the cell→position mapping; nearest by max dot product, or the existing point-location helper if one exists); `height[ry*w+rx]` = that cell's elevation (continents `>0`, deep ocean `<0`; unpainted = the deep-ocean-floor baseline value the wizard uses, e.g. its `DEEP_OCEAN_FLOOR`); `precip[...]` = that cell's normalized precipitation (clamp to `[0,2]`).
3. Add the `#[tauri::command] pub fn bake_inputs_equirect(draft: WizardDraft, w: u32, h: u32) -> EquirectInputs { bake_inputs_equirect_impl(&draft, w, h) }`.
4. Add `mod test_support { pub fn one_continent_draft() -> super::WizardDraft { /* minimal draft: paint one elevated cap; reuse any existing test-draft constructor in wizard.rs tests */ } }` under `#[cfg(test)]`.
5. In `lib.rs`: `mod bake_equirect;` and add `bake_equirect::bake_inputs_equirect` to `tauri::generate_handler![ ... ]` (ADDITIVE — keep existing entries).

(Implementer: keep the nearest-cell lookup simple and O(cells) per texel at these small W·H; it runs once per bake. Mirror the exact elevation/ocean sign convention the wizard already uses so ocean is `<0`.)

- [ ] **Step 4: Run test — verify PASS**

Run: `cd apps/hayba-explorer/src-tauri && cargo test --lib equirect_inputs_have_land`
Expected: PASS. Also `cargo test --lib` (no regressions) and `cargo build`.

- [ ] **Step 5: Commit**

```
git add apps/hayba-explorer/src-tauri/src/bake_equirect.rs apps/hayba-explorer/src-tauri/src/lib.rs
git commit -m "feat(erosion): bake_inputs_equirect — draft+climate to equirect height/precip"
```

---

### Task 2: `equirectInput.ts` — upload helper

**Files:**
- Create: `apps/hayba-explorer/src/viewport/bake/equirectInput.ts`
- Test: `apps/hayba-explorer/src/viewport/bake/equirectInput.test.ts`

- [ ] **Step 1: Failing test**

```ts
// Run: npx tsx src/viewport/bake/equirectInput.test.ts
import { strict as assert } from "node:assert";
import * as THREE from "three";
import { uploadEquirect } from "./equirectInput";

const w = 4, h = 2;
const arr = new Float32Array([1,2,3,4,5,6,7,8]); // w*h
const tex = uploadEquirect(arr, w, h);
assert.ok(tex instanceof THREE.DataTexture);
assert.equal(tex.image.width, w);
assert.equal(tex.image.height, h);
assert.equal(tex.type, THREE.FloatType);
assert.equal(tex.format, THREE.RGBAFormat);
assert.equal(tex.magFilter, THREE.NearestFilter);
assert.equal(tex.minFilter, THREE.NearestFilter);
assert.equal(tex.flipY, false);
// channel-0 carries the value, others 0
const d = tex.image.data as Float32Array;
assert.equal(d.length, w*h*4);
assert.equal(d[0], 1); assert.equal(d[1], 0); assert.equal(d[4], 2);
console.log("ok");
```

- [ ] **Step 2: Run — verify FAIL**

Run: `cd apps/hayba-explorer && npx tsx src/viewport/bake/equirectInput.test.ts`
Expected: FAIL (`uploadEquirect` not found).

- [ ] **Step 3: Implement**

```ts
import * as THREE from "three";

/** Upload a length-(w*h) Float32Array as a single-channel (.r) RGBA32F
 *  DataTexture. Row 0 = North pole (no flipY). Nearest/clamp — the
 *  hydraulic shaders sample by explicit texel math. */
export function uploadEquirect(src: Float32Array, w: number, h: number): THREE.DataTexture {
  if (src.length !== w * h) throw new Error(`uploadEquirect: expected ${w*h}, got ${src.length}`);
  const data = new Float32Array(w * h * 4);
  for (let i = 0; i < w * h; i++) data[i * 4] = src[i];
  const tex = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, THREE.FloatType);
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.flipY = false;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}
```

- [ ] **Step 4: Run — verify PASS** (`npx tsx ... equirectInput.test.ts` → `ok`), then `npx tsc --noEmit`.

- [ ] **Step 5: Commit**

```
git add apps/hayba-explorer/src/viewport/bake/equirectInput.ts apps/hayba-explorer/src/viewport/bake/equirectInput.test.ts
git commit -m "feat(erosion): equirectInput uploadEquirect DataTexture helper"
```

---

### Task 3: `hydraulic.glsl.ts` — the simulation shaders

**Files:**
- Create: `apps/hayba-explorer/src/viewport/bake/hydraulic.glsl.ts`
- Test: `apps/hayba-explorer/src/viewport/bake/hydraulic.glsl.test.ts`

Implement, as `export const`-joined-by-`\n` GLSL ES3 strings (NO backticks; one `uniform <type> <name>;` per line; own `precision highp float; precision highp int;` + `out vec4 fragColor;`), exactly the §"The simulation step" equations from the spec, all neighbour sampling longitude-wrapped (`int xw(int x,int W){ return (x%W+W)%W; }`) and latitude clamped, with the `wLat` pole-damp. The passes (each a full-screen frag writing one ping-pong target):

- `RAIN_FRAG` — reads `uA` (b,d,s,ocean), `uPrecip`; writes A with `d += dt*rainScale*precip*wLat`.
- `FLUX_FRAG` — reads `uA`,`uF`; writes new flux per spec Flux eq incl. the conserving scale `K`.
- `WATER_FRAG` — reads `uA`,`uF`; writes A with updated `d` from flux divergence; packs velocity is recomputed in ERODE from `uF` (no separate V texture — keep minimal; ERODE reads `uF`).
- `ERODE_FRAG` — reads `uA`,`uF`; computes `sinα`,`v`,`C`; erode/deposit with `maxDeltaB` clamp; land uplift; ocean-skip; writes A (b,s updated).
- `ADVECT_FRAG` — reads `uA`,`uF`; semi-Lagrangian 4-tap bilinear advect of `s` along `v` (x wrapped, y clamped); writes A (s updated).
- `EVAP_FRAG` — reads `uA`; `d *= (1-Ke*dt)`; clamp `d>=0`; writes A.
- `THERMAL_FRAG` — reads `uA`; talus slump per spec; writes A (b updated, mass-conserving, ocean-skip).

Each frag declares exactly the uniforms it uses from this set (declare only what it reads): `uniform sampler2D uA; uniform sampler2D uF; uniform sampler2D uPrecip; uniform vec2 uTexel; uniform vec2 uGrid; uniform float uDt; uniform float uRainScale; uniform float uGravity; uniform float uPipeArea; uniform float uCellL; uniform float uKc; uniform float uKs; uniform float uKd; uniform float uKe; uniform float uSinMin; uniform float uUplift; uniform float uMaxDeltaB; uniform float uKt; uniform float uTanTalus; uniform float uPoleBand;` (`uGrid` = vec2(W,H); `uTexel` = vec2(1/W,1/H)). Use a shared GLSL header string `H` (precision + `out vec4 fragColor;` + helpers `xw`, `texelOf`, `wLatOf(ry)`, `loadA`, `loadF`) concatenated before each pass body. Helpers derive `ry` from `gl_FragCoord.y` and `W,H` from `uGrid`. All bodies are the literal spec equations — no approximations beyond the spec.

- [ ] **Step 1: Failing test**

```ts
// Run: npx tsx src/viewport/bake/hydraulic.glsl.test.ts
import { strict as assert } from "node:assert";
import * as G from "./hydraulic.glsl";
const frags = [G.RAIN_FRAG,G.FLUX_FRAG,G.WATER_FRAG,G.ERODE_FRAG,G.ADVECT_FRAG,G.EVAP_FRAG,G.THERMAL_FRAG];
for (const f of frags) {
  assert.equal(typeof f, "string");
  assert.ok(f.length > 50, "frag non-trivial");
  assert.ok(!f.includes("`"), "NO backticks in GLSL");
  assert.ok(f.includes("out vec4 fragColor"), "declares fragColor out");
  assert.ok(f.includes("void main"), "has main");
  assert.ok(/precision\s+highp\s+float/.test(f), "has precision");
}
// every declared uniform is one-per-line, no trailing comment on decl line
for (const f of frags)
  for (const line of f.split("\n"))
    if (line.trim().startsWith("uniform "))
      assert.ok(!line.includes("//"), "no comment on uniform decl line: " + line);
console.log("ok");
```

- [ ] **Step 2: Run — verify FAIL** (`npx tsx ... hydraulic.glsl.test.ts` → module not found).
- [ ] **Step 3: Implement** the GLSL per the spec equations (full bodies; the shared header `H`; each `export const *_FRAG = [H, "...body lines..."].join("\n")`).
- [ ] **Step 4: Run — verify PASS**, then `npx tsc --noEmit`.
- [ ] **Step 5: Commit**

```
git add apps/hayba-explorer/src/viewport/bake/hydraulic.glsl.ts apps/hayba-explorer/src/viewport/bake/hydraulic.glsl.test.ts
git commit -m "feat(erosion): hydraulic GLSL passes (Mei-2007 virtual pipes, equirect, lon-wrap)"
```

---

### Task 4: `hydraulic.ts` — orchestrator

**Files:**
- Create: `apps/hayba-explorer/src/viewport/bake/hydraulic.ts`
- Test: `apps/hayba-explorer/src/viewport/bake/hydraulic.test.ts`

Exports:
- `export interface HydraulicConfig { steps:number; chunk:number; dt:number; rainScale:number; gravity:number; pipeArea:number; cellL:number; kc:number; ks:number; kd:number; ke:number; sinMin:number; uplift:number; maxDeltaB:number; kt:number; tanTalus:number; thermalEvery:number; poleBand:number; }`
- `export const DEFAULT_HYDRAULIC: HydraulicConfig` with pinned numeric defaults: `{ steps:200, chunk:16, dt:0.02, rainScale:0.012, gravity:9.81, pipeArea:1.0, cellL:1.0, kc:0.18, ks:0.30, kd:0.20, ke:0.015, sinMin:0.02, uplift:0.0008, maxDeltaB:0.01, kt:0.30, tanTalus:0.6, thermalEvery:8, poleBand:0.04 }`
- `export function planSteps(cfg: HydraulicConfig): { totalSteps:number; chunks:number[] }` — pure: returns the per-chunk step counts (sum == steps; each ≤ chunk).
- `export async function runHydraulicBake(renderer: THREE.WebGLRenderer, base: THREE.DataTexture, precip: THREE.DataTexture, w:number, h:number, cfg: HydraulicConfig, onProgress?:(done:number,total:number)=>void): Promise<THREE.WebGLRenderTarget>` — allocates A/F ping-pong RGBA32F RTs (via the pingpong float-probe+alloc helper), seeds A (`b=base.r`, `d=0`, `s=0`, `ocean = base.r<0?1:0`) and F=0 with a seed pass, runs `cfg.steps` steps (RAIN→FLUX→WATER→ERODE→ADVECT→EVAP, THERMAL every `thermalEvery`) via `glPass.runRawPass` ping-ponging A and F, `await` a macrotask yield between chunks (reuse `() => new Promise(r=>setTimeout(r,0))`), calls `onProgress`, then `renderer.resetState()` ONCE at the end, returns the RT currently holding A. Each pass's uniforms object provides exactly the uniforms that frag declares (numbers/Vector2/textures — `glPass` parses types from the frag).

- [ ] **Step 1: Failing test** (pure logic only — no GL):

```ts
// Run: npx tsx src/viewport/bake/hydraulic.test.ts
import { strict as assert } from "node:assert";
import { DEFAULT_HYDRAULIC, planSteps } from "./hydraulic";
assert.equal(DEFAULT_HYDRAULIC.steps, 200);
assert.ok(DEFAULT_HYDRAULIC.kc > 0 && DEFAULT_HYDRAULIC.maxDeltaB > 0);
const p = planSteps({ ...DEFAULT_HYDRAULIC, steps: 50, chunk: 16 });
assert.equal(p.totalSteps, 50);
assert.equal(p.chunks.reduce((a,b)=>a+b,0), 50);
assert.ok(p.chunks.every(c => c <= 16 && c > 0));
assert.equal(p.chunks.length, 4); // 16+16+16+2
console.log("ok");
```

- [ ] **Step 2: Run — verify FAIL.**
- [ ] **Step 3: Implement** `hydraulic.ts` (the RT alloc uses the reduced `pingpong.ts` helper — for now, since Task 7 reduces pingpong, in this task import the existing float-probe + a local `makeRGBA32F(renderer,w,h)` helper if `pingpong.ts` not yet reduced; keep `runHydraulicBake` correct; the GL path is exercised only at runtime / by the user, not in this unit test).
- [ ] **Step 4: Run — verify PASS** (`hydraulic.test.ts` → `ok`), `npx tsc --noEmit`, `npm run build`.
- [ ] **Step 5: Commit**

```
git add apps/hayba-explorer/src/viewport/bake/hydraulic.ts apps/hayba-explorer/src/viewport/bake/hydraulic.test.ts
git commit -m "feat(erosion): hydraulic.ts orchestrator (ping-pong via glPass, chunked, resetState-once)"
```

---

### Task 5: Rewire `App.tsx` `handleDebugBake`

**Files:** Modify `apps/hayba-explorer/src/App.tsx` (ONLY `handleDebugBake` + its imports/state + remove the parity button & its handler/state). Additive elsewhere; do not touch unrelated handlers.

- [ ] **Step 1:** Read the current `handleDebugBake`, the `debugMaterial` wiring, the parity button JSX/handler.
- [ ] **Step 2:** Replace the bake body with: `invoke<EquirectInputs>("bake_inputs_equirect",{draft:finalDraft,w,h})` (w,h from a debug const, e.g. 1024×512) → `uploadEquirect(height,w,h)` (base) + `uploadEquirect(precip,w,h)` → `scene.runBake(async r => runHydraulicBake(r, base, precip, w, h, DEFAULT_HYDRAULIC, onProgress))` → build the debug relief `THREE.Mesh` with `makeDebugReliefMaterial()`, `setDebugTexture(mat, hFinalRT.texture, base)` (base = the no-erosion toggle view) → `scene.setGlobe(mesh)`. Dispose previous RT/textures on re-bake (same prev-ref pattern already in the file). Remove the "Run parity" button, its onClick handler, and parity-only state. Keep the eroded/no-erosion checkbox (now: eroded `A.r` vs `base`).
- [ ] **Step 3:** `npx tsc --noEmit` (zero) — note: `erodePipeline`/`parity`/`uploadH0` imports may still exist elsewhere; they are removed in Task 7. If App.tsx still imports any removed-in-T7 symbol, leave the import only if still referenced; otherwise remove it here. `npm run build` succeeds.
- [ ] **Step 4:** No unit test (App wiring; GL path is user-validated Task 8). Confirm tsc+build green.
- [ ] **Step 5: Commit**

```
git add apps/hayba-explorer/src/App.tsx
git commit -m "feat(erosion): wire debug bake to hydraulic equirect pipeline; drop parity button"
```

---

### Task 6: Reduce `pingpong.ts` to float-probe + RT alloc

**Files:** Modify `apps/hayba-explorer/src/viewport/bake/pingpong.ts`; update `hydraulic.ts` import if needed; Test: existing `pingpong.test.ts` must still pass (trim it to the kept surface).

- [ ] **Step 1:** Identify the kept surface: `decideFloatSupport` + the RGBA32F render-target allocation (`createPingPong`/`makeRT` style). Delete `runPass`, `PingPongBook`, `physicallyIsolateUnits`, `_bakeDebug`, `_bakeUnitHygiene`, all SELF/GL/STALE-ALIAS + bake-summary instrumentation.
- [ ] **Step 2:** Trim `pingpong.test.ts` to only the kept exports (float-probe with a fake `getExtension` ctx; RT-alloc shape). Remove tests for deleted symbols.
- [ ] **Step 3:** Point `hydraulic.ts` at the kept RT-alloc helper (replace any local `makeRGBA32F` with it for DRY).
- [ ] **Step 4:** `npx tsx src/viewport/bake/pingpong.test.ts` → ok; `hydraulic.test.ts` → ok; `npx tsc --noEmit`; `npm run build`.
- [ ] **Step 5: Commit**

```
git add apps/hayba-explorer/src/viewport/bake/pingpong.ts apps/hayba-explorer/src/viewport/bake/pingpong.test.ts apps/hayba-explorer/src/viewport/bake/hydraulic.ts
git commit -m "refactor(erosion): reduce pingpong.ts to float-probe + RT alloc"
```

---

### Task 7: Delete the dead bespoke pipeline

**Files:** Delete `src-tauri/src/erosion/` (whole dir) + its `mod erosion;` in `lib.rs`; remove `bake_erode_v2`/`bake_h0_v2`/`H0Atlas` from `wizard.rs` + their `generate_handler!` entries in `lib.rs`; delete `src/viewport/bake/{erodePipeline.ts,passes.glsl.ts,parity.ts,cubesphere.ts,uploadH0.ts}` and their `*.test.ts`. Modify any remaining importers (should be none after Task 5; grep to confirm).

- [ ] **Step 1:** `cd apps/hayba-explorer && grep -rl "erodePipeline\|passes.glsl\|parity\|cubesphere\|uploadH0\|bake_erode_v2\|bake_h0_v2" src src-tauri/src` — every hit must be a file being deleted, else fix the importer first.
- [ ] **Step 2:** Delete the files/dir; remove the Rust `mod`/command registrations and `H0Atlas`/`bake_*_v2` fns.
- [ ] **Step 3:** `cargo test --lib` + `cargo build` (Rust green); `cd apps/hayba-explorer && npx tsc --noEmit` (zero) + `npm run build` (succeeds) + run remaining bake tests (`equirectInput`,`hydraulic.glsl`,`hydraulic`,`pingpong`,`debugMaterial`) → all ok.
- [ ] **Step 4:** Confirm no dangling refs (`grep` clean).
- [ ] **Step 5: Commit**

```
git add -u apps/hayba-explorer/src apps/hayba-explorer/src-tauri/src
git commit -m "chore(erosion): delete dead bespoke cube-sphere/graph pipeline + parity harness"
```
(`git add -u` here is scoped to the two listed dirs and only stages tracked deletions/mods — acceptable for a pure-deletion task; verify `git status` shows only intended removals before commit.)

---

### Task 8: Visual validation (USER-RUN — the real gate)

**Files:** none (validation; may append results to the spec).

Per the standing rule (validate visually, not metrics; no parity harness). The user does a FULL `npm run tauri dev` restart (HMR does not swap these modules), then for (a) the Earth-DEM template and (b) a hand-painted continent, bakes and eyeballs with the eroded/no-erosion toggle:

- [ ] dendritic incised valleys + sharp ridgelines + deposition fans present in eroded, absent in no-erosion;
- [ ] painted continents / macro silhouette still recognizable (macro preserved);
- [ ] ocean renders blue (`b<0` preserved on ocean cells);
- [ ] ±180° longitude seam continuous (no visible meridian);
- [ ] poles clean (no blow-up / NaN ring);
- [ ] wetter regions (per precip) visibly erode more than arid;
- [ ] zero WebGL errors in console.

If any fails, file a fix task with the screenshot/symptom and iterate (tune `DEFAULT_HYDRAULIC` or the offending pass) before sign-off. On all-pass: append a short "validation results + sign-off" note to the spec and commit it.

---

## Self-Review

**Spec coverage:** scrap/keep → Tasks 1–7; equirect inputs+precip coupling → T1; upload → T2; the 6+1 passes & equations & lon-wrap & pole-damp & macro-preserve(clamp+uplift) → T3; orchestration/bake-then-watch/resetState-once/chunk-yield → T4; debug globe + no-erosion toggle wiring → T5; pingpong reduction → T6; deletions (incl. parity harness, CPU oracle) → T5/T7; visual-only validation & success criteria → T8. No spec section unmapped.

**Placeholder scan:** GLSL bodies are specified as "the literal spec equations" with the full uniform set, shared header, and per-pass responsibilities enumerated — the spec (committed) contains the exact equations the engineer transcribes; this is a reference-to-authoritative-doc, not a TODO. Rust Task 1 gives exact I/O struct, algorithm steps, the named existing helpers to reuse, and a correctness test — concrete, not a placeholder. No "TBD/handle edge cases/similar to Task N".

**Type consistency:** `EquirectInputs{w,h,height,precip}` (Rust serialize → TS `invoke<EquirectInputs>`), `uploadEquirect(arr,w,h)`, `HydraulicConfig`/`DEFAULT_HYDRAULIC`/`planSteps`/`runHydraulicBake`, `glPass.runRawPass(renderer,frag,uniforms,dstRT)`, `makeDebugReliefMaterial`/`setDebugTexture` — names used identically across T1–T7. Uniform names in T3 (`uA,uF,uPrecip,uTexel,uGrid,uDt,...`) are the set T4 supplies. Consistent.
