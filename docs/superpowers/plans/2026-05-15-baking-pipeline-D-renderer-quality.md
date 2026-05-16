# Baking Pipeline — Subsystem D: Renderer Quality — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Lift Subsystem C's surface to the photoreal-Earth-from-orbit target — proper AO integration, mountains that read with real relief (slope/curvature contrast + normal-mapped lighting), and atmosphere/sun/terminator — and lock the Phase-2 CDLOD seam behind `sampleField()` without building CDLOD.

**Architecture:** D extends C's surface fragment shader (no new render pass where avoidable — stays single-tap/VT-safe) with a lighting + relief stage: baked-AO compositing, slope/curvature-driven mountain standout, normal-mapped sun/terminator shading, and an atmosphere/rim term. Phase-2 detail is **not** implemented; D only verifies the `sampleField()` interface is CDLOD-ready (returns global level when `vtEnabled=false`) so a future Subsystem E can swap the backing without touching D.

**Tech Stack:** TypeScript + Three.js r0.169 ShaderMaterial/GLSL ES. **Conventions: identical to Plan A.** GLSL `.glsl.ts`: no backticks in comments. Single-tap discipline preserved (spec §6/§7).

**Spec:** `docs/superpowers/specs/2026-05-15-baking-pipeline-redesign-design.md` §8 (renderer quality), §9 (Phase-2 CDLOD seam). **Project north star:** photoreal Earth-from-orbit — see memory `project_planet_shader_photoreal` (authoritative roadmap: shader-upgrade-dossier §G.7); align AO/atmosphere/tonemap choices to it.

**Depends on:** Plan C complete (provides `surfaceMaterial`, `SURFACE_FRAG`, `SURFACE_KNOBS`, `ShadingPanel`) and Plan B (`AO`, `normalXYZ`, `curvature`, `slope`, `localRelief` masks via `sampleField`).

---

## File Structure

**Modified — TS:**
- `src/viewport/shaders/surface.glsl.ts` — add `lighting()`, `mountainStandout()`, `atmosphere()` GLSL stages (referenced as stubs by Plan C; D implements them for real).
- `src/viewport/bake/surfaceMaterial.ts` — add `uSunDir`, `uAtmoStrength`, `uReliefStrength`, `uExposure` uniforms + knobs.
- `src/components/panels/ShadingPanel.tsx` — add the lighting/atmosphere/relief controls.
- `src/viewport/bake/sampleField.ts` — add `assertCdlodReady()` (interface conformance check; no CDLOD impl).
- `src/viewport/scene.ts` — sun direction follows a configurable light (keep existing lights for the wizard point-cloud).

**New — TS:** `src/viewport/shaders/lighting.test.ts` (GLSL shape/ALU guards for the new stages).

---

## Phase D0 — Lighting & relief

### Task D1: Normal-mapped sun/terminator lighting

**Files:** Modify `src/viewport/shaders/surface.glsl.ts`, `src/viewport/bake/surfaceMaterial.ts`; Create `src/viewport/shaders/lighting.test.ts`.

- [ ] **Step 1: Failing test**

```ts
// Run: npx tsx src/viewport/shaders/lighting.test.ts
import assert from "node:assert/strict";
import { SURFACE_FRAG } from "./surface.glsl";
assert.ok(/vec3\s+lighting\s*\(/.test(SURFACE_FRAG), "lighting() defined");
assert.ok(SURFACE_FRAG.includes("uSunDir"), "sun direction uniform used");
assert.ok(!SURFACE_FRAG.includes("`"), "no backtick in GLSL");
assert.ok(!/for\s*\(.*octave/i.test(SURFACE_FRAG), "still no procedural octave loop (ALU)");
// Review D2/D3: macro shadow uses the SMOOTH geometric normal; micro lighting
// uses the perturbed normal — terminator must not be driven by perturbed N.
assert.ok(SURFACE_FRAG.includes("vGeomNormal"), "smooth geometric normal carried");
assert.ok(/macroTerm\s*=\s*smoothstep\([^)]*vGeomNormal/.test(SURFACE_FRAG),
  "terminator from geometric normal, not perturbed N (no banding on bumps)");
// Review D1: a TBN matrix is built before applying the relief gradient
assert.ok(/mat3\s+TBN|tbn/i.test(SURFACE_FRAG), "TBN constructed for relief perturbation");
console.log("ok");
```

- [ ] **Step 2:** `cd apps/hayba-explorer && npx tsx src/viewport/shaders/lighting.test.ts` → FAIL.
- [ ] **Step 3:** Implement, with these **NORMATIVE review fixes**:
  - **D3 (TBN, object/tangent space):** the baked `normalXYZ` mask + the `localRelief`-gradient relief bump must be combined through a correct **TBN matrix built in-shader from the sphere derivatives** (`T = dFdx(vSpherePos)`-ish orthonormalized against `vGeomNormal`, `B = cross`), so relief lights correctly as the planet rotates (no object/world-space mismatch). Output `vec3 perturbedN`.
  - **D2 (terminator banding):** decouple macro-shadow from micro-light. `float macroTerm = smoothstep(-0.1, 0.15, dot(vGeomNormal, sunDir));` (the **smooth geometric** normal — `vGeomNormal` from `SURFACE_VERT`), then `finalLight = macroTerm * max(0.0, dot(perturbedN, sunDir))` + gentle ambient (no pitch-black night). Mountains near the terminator can't strobe lit/black.
  - `vec3 lighting(vec3 albedo, vec3 perturbedN, vec3 geomN, vec3 sunDir)`. Add `uSunDir`/`uReliefStrength`/`uExposure` to `surfaceMaterial` + `SURFACE_KNOBS`. `SURFACE_VERT` already passes `vGeomNormal` (Plan C C2 fix). Call `lighting()` where C's shader had the `mountainStandout`/`sunLight` placeholder.
- [ ] **Step 4:** PASS; `npx tsc -b` clean.
- [ ] **Step 5: Commit** `git add apps/hayba-explorer/src/viewport/shaders/surface.glsl.ts apps/hayba-explorer/src/viewport/bake/surfaceMaterial.ts apps/hayba-explorer/src/viewport/shaders/lighting.test.ts` → `feat(render): normal-mapped sun/terminator lighting`.

### Task D2: AO integration + mountain standout

**Files:** Modify `src/viewport/shaders/surface.glsl.ts`, `surfaceMaterial.ts`.

- [ ] **Step 1: Failing test** — extend `lighting.test.ts`:

```ts
import { SURFACE_FRAG as F } from "./surface.glsl";
assert.ok(/vec3\s+mountainStandout\s*\(/.test(F), "mountainStandout() defined");
assert.ok(F.includes("pow(") && F.includes("aoStrength"), "AO composited with strength");
```

- [ ] **Step 2:** FAIL.
- [ ] **Step 3:** Implement `vec3 mountainStandout(vec3 c, float slope, float curv, vec3 N, float k)` — increase local contrast + cool/warm shift on high slope·curvature so erosion ridgelines pop (keyed off baked `curvature`/`slope`, not procedural noise); composite baked `AO` as `c *= pow(AO, uAOStrength)` *before* lighting (ambient occlusion is a visibility term, not a post tint). Wire `uMountainContrast` (already a C knob) into it.
- [ ] **Step 4:** PASS.
- [ ] **Step 5: Commit** `git add apps/hayba-explorer/src/viewport/shaders/surface.glsl.ts apps/hayba-explorer/src/viewport/bake/surfaceMaterial.ts` → `feat(render): baked-AO compositing + slope/curvature mountain standout`.

### Task D3: Atmosphere / rim / tonemap

**Files:** Modify `src/viewport/shaders/surface.glsl.ts`, `surfaceMaterial.ts`.

- [ ] **Step 1: Failing test**

```ts
import { SURFACE_FRAG as F } from "./surface.glsl";
assert.ok(/vec3\s+atmosphere\s*\(/.test(F) && F.includes("uAtmoStrength"));
assert.ok(/tonemap|aces|filmic/i.test(F), "HDR tonemap present");
// Review D1: atmosphere is a macro volumetric effect — it must use the SMOOTH
// geometric normal, never the perturbed relief normal (else jagged sparkly rim).
assert.ok(/atmosphere\([^)]*vGeomNormal/.test(F) && !/atmosphere\([^)]*perturbed/.test(F),
  "atmosphere() uses geometric normal, not perturbed N");
```

- [ ] **Step 2:** FAIL.
- [ ] **Step 3:** Implement a cheap analytic `atmosphere(vec3 lit, vec3 vGeomNormal, vec3 viewDir, vec3 sunDir)` — Fresnel-ish rim glow keyed to `dot(vGeomNormal, viewDir)` + sun-side scatter tint, additive over the lit surface. **NORMATIVE (review D1):** atmosphere is a macro volumetric effect — it MUST use the **smooth geometric normal `vGeomNormal`**, never `perturbedN` (the relief-perturbed normal makes the limb halo jagged/sparkly/broken over mountains). Final ACES/filmic `tonemap()` with `uExposure`. Align palette to the photoreal target (memory `project_planet_shader_photoreal`).
- [ ] **Step 4:** PASS; `npm run build` ok.
- [ ] **Step 5: Commit** `git add apps/hayba-explorer/src/viewport/shaders/surface.glsl.ts apps/hayba-explorer/src/viewport/bake/surfaceMaterial.ts` → `feat(render): limb atmosphere + ACES tonemap (photoreal target)`.

### Task D4: Lighting/atmosphere controls in Shading panel

**Files:** Modify `src/components/panels/ShadingPanel.tsx`, `src/viewport/scene.ts`.

- [ ] **Step 1: Failing test** — extend `ShadingPanel.test.ts`:

```ts
import { SHADING_CONTROLS as S } from "./ShadingPanel";
for (const k of ["reliefStrength","aoStrength","atmoStrength","exposure","sunAzimuth","sunElevation"])
  assert.ok(S.some(c=>c.knob===k), `control ${k}`);
```

- [ ] **Step 2:** FAIL.
- [ ] **Step 3:** Add the controls (sun azimuth/elevation → `uSunDir`, relief/AO/atmo/exposure). `scene.ts`: expose a settable sun vector used by the surface material (independent of the wizard point-cloud lights).
- [ ] **Step 4:** PASS; `npm run build` ok.
- [ ] **Step 5: Commit** `git add apps/hayba-explorer/src/components/panels/ShadingPanel.tsx apps/hayba-explorer/src/viewport/scene.ts apps/hayba-explorer/src/components/panels/ShadingPanel.test.ts` → `feat(render): sun/relief/atmosphere/exposure live controls`.

## Phase D1 — Phase-2 seam conformance (no CDLOD build)

### Task D5: `sampleField()` CDLOD-readiness assertion

**Files:** Modify `src/viewport/bake/sampleField.ts`; Create `src/viewport/bake/sampleField.cdlod.test.ts`.

- [ ] **Step 1: Failing test**

```ts
// Run: npx tsx src/viewport/bake/sampleField.cdlod.test.ts
import assert from "node:assert/strict";
import { assertCdlodReady } from "./sampleField";
// Phase 1: vtEnabled=false MUST return the global level and the interface
// MUST expose the documented seam (lod, tileOrigin) so a future CDLOD
// backing swaps in without touching Subsystems C/D (spec §9).
const r = assertCdlodReady({ vtEnabled:false });
assert.equal(r.backing, "global");
assert.ok(r.seam.includes("lod") && r.seam.includes("tileOrigin"));
console.log("ok");
```

- [ ] **Step 2:** FAIL.
- [ ] **Step 3:** Implement `assertCdlodReady(opts)` — a conformance check (no CDLOD logic) verifying: `vtEnabled=false` ⇒ `backing:"global"`; the sampler signature carries the documented `{lod, tileOrigin}` seam params (defaulted/ignored in Phase 1). Document `// Phase 2 (separate Subsystem E spec): CDLOD/clipmap quadtree replaces the backing here — spec §9. NOT GPU-feedback VT.`
- [ ] **Step 4:** PASS.
- [ ] **Step 5: Commit** `git add apps/hayba-explorer/src/viewport/bake/sampleField.ts apps/hayba-explorer/src/viewport/bake/sampleField.cdlod.test.ts` → `feat(render): assert sampleField() CDLOD-ready seam (Phase-2 deferred)`.

## Phase D2 — Validation & program close-out

### Task D6: Photoreal visual validation
- [ ] **Step 1:** Bake Earth template; assess against the photoreal-Earth-from-orbit target (memory `project_planet_shader_photoreal` / dossier §G.7): believable limb atmosphere, soft terminator (no hard black night), mountains with real relief and AO, oceans not flat, no ±180° seam, no flat-color mush.
- [ ] **Step 2:** Sweep all live knobs (sun, exposure, relief, AO, atmo) — instant, no re-bake, no fps regression (still single-tap, VT-safe).
- [ ] **Step 3:** Paint a synthetic world; confirm the full A→B→C→D chain produces a coherent photoreal planet from paint.
- [ ] **Step 4:** Validate **visually** per standing rule; file fixes before D sign-off.
- [ ] **Step 5: Commit** (notes) `git add docs/superpowers/specs/2026-05-15-baking-pipeline-redesign-design.md` → `docs(render): Subsystem D visual-validation + full A→B→C→D sign-off`.

### Task D7: Program close-out
- [ ] **Step 1:** Confirm A, B, C, D all visually signed off; update task tracker (#188/#194 done; #193 closed by B5 continentality).
- [ ] **Step 2:** Per `superpowers:finishing-a-development-branch`: ensure the working tree is committed, the umbrella spec + 4 plans are committed, summarize the delivered pipeline vs the old Plan-A erosion (now superseded).
- [ ] **Step 3:** Note the explicit deferral: **Subsystem E (Phase-2 CDLOD)** is a future separate spec/plan; the `sampleField()` seam is ready (D5).
- [ ] **Step 4: Commit** any tracker/doc updates → `chore(bake): A→B→C→D program close-out; Phase-2 CDLOD deferred to Subsystem E`.

---

## Self-Review

**Spec §8 coverage:** AO multiply → D2; mountain standout → D1/D2; atmosphere/lighting photoreal → D1/D3. §9 Phase-2 seam → D5 (conformance only; CDLOD deferred to Subsystem E).

**Architecture-review fixes folded in:** **(D1, jagged atmosphere)** `atmosphere()` uses the smooth `vGeomNormal`, never the perturbed normal — test forbids `atmosphere(...perturbed...)`. **(D2, terminator banding)** macro-shadow `macroTerm = smoothstep(...,dot(vGeomNormal,sunDir))` decoupled from micro Lambert `dot(perturbedN,sunDir)`; test pins `macroTerm` to `vGeomNormal`. **(D3, object/tangent space)** the baked `normalXYZ` + relief gradient combine through an in-shader **TBN** built from sphere derivatives so relief lights correctly under planet rotation; test asserts a TBN/`mat3` is constructed. `SURFACE_VERT` carries `vGeomNormal` (Plan C C2).

**Placeholder scan:** `lighting()/mountainStandout()/atmosphere()` are concrete stages pinned by shape/ALU/normal-source/TBN assertions — no TODOs. **Type consistency:** `lighting(albedo,perturbedN,geomN,sunDir)`, `mountainStandout`, `atmosphere(lit,vGeomNormal,viewDir,sunDir)`, `tonemap`, `vGeomNormal`, `perturbedN`, `uSunDir/uReliefStrength/uAtmoStrength/uExposure`, `assertCdlodReady` consistent with Plan C (`SURFACE_FRAG/VERT`, `SURFACE_KNOBS`, `vGeomNormal`) and Plan B (`AO/normalXYZ/curvature`). **Scope:** Subsystem D only; Phase-2 CDLOD = future Subsystem E (deferred per spec §9), seam verified not implemented.
