# Baking Pipeline — Subsystem C: Live Multi-Layer SatMap Shading — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Render the planet every frame from Subsystem B's mask stack via the definitive multi-layer SatMap composite (spec §7.3) — strict single-tap, no cross-texel sampling — driven by an always-accessible Shading Settings panel.

**Architecture:** A `THREE.ShaderMaterial` on a sphere mesh maps each fragment → equirect uv → samples `sampleField()` mask textures + the SatMap registry, executing the spec §7.3 composite exactly (global wet/dry → biome → flow → curvature → mountain → snow, noise-masked Combine/Max, biome winner-take-all with `noisePerturbedFrontier` blend, baked micro-bleed tap, one live blue-noise jitter tap). All cohesion/noise is already baked (Subsystem B); C adds **zero** multi-octave math. Live UI knobs are cheap uniforms.

**Tech Stack:** TypeScript + Three.js r0.169 ShaderMaterial/GLSL ES; React panels (follow `src/components/panels/TexturingPanel.tsx` + `SettingsPanel.tsx` patterns). TS tests `npx tsx`. **Conventions: identical to Plan A** (test harness, commit rules, no `git add -A`, no co-author trailer). GLSL `.glsl.ts` rule: **no backticks in GLSL comments**.

**Spec:** `docs/superpowers/specs/2026-05-15-baking-pipeline-redesign-design.md` §7 (the §7.3 composite is normative — implement it verbatim), §6 (ALU enforcement: C is O(1) taps only).

**Depends on:** Plan B complete (provides `SampleField` + `MaskTextureSet` + uniform/texture-binding map). Reuses `src/viewport/satmap-loader.ts` (`loadSatMap`, `SATMAP_NAMES`, `SatMapName`).

---

## File Structure

**New — TS:** `src/viewport/bake/satmapRegistry.ts` (the fixed registry: `globalDry, globalWet, snow, flow, curvature, mountain, biome[10]`; loads via `satmap-loader`), `src/viewport/shaders/surface.glsl.ts` (the §7.3 composite vertex+fragment), `src/viewport/bake/surfaceMaterial.ts` (`buildSurfaceMaterial(sampleField, registry) -> {mesh, setKnob, dispose}`), `src/components/panels/ShadingPanel.tsx` (always-on settings).
**Modified — TS:** `App.tsx` (after B bake → `setGlobe(surfaceMaterial.mesh)`; mount `ShadingPanel` always-accessible), `src/components/RightPanel.tsx` (register the panel), `src/viewport/bake/sampleField.ts` (add the documented `bindToMaterial(mat)` helper).

---

## Phase C0 — SatMap registry & composite shader

### Task C1: SatMap registry

**Files:** Create `src/viewport/bake/satmapRegistry.ts` + `satmapRegistry.test.ts`.

- [ ] **Step 1: Failing test**

```ts
// Run: npx tsx src/viewport/bake/satmapRegistry.test.ts
import assert from "node:assert/strict";
import { REGISTRY_SLOTS, defaultRegistryMapping } from "./satmapRegistry";
assert.deepEqual(REGISTRY_SLOTS.slice(0,6),
  ["globalDry","globalWet","snow","flow","curvature","mountain"]);
assert.equal(REGISTRY_SLOTS.filter(s=>s.startsWith("biome")).length, 10);
const m = defaultRegistryMapping();
for (const s of REGISTRY_SLOTS) assert.ok(m[s], `${s} has a default SatMap name`);
console.log("ok");
```

- [ ] **Step 2:** `cd apps/hayba-explorer && npx tsx src/viewport/bake/satmapRegistry.test.ts` → FAIL.
- [ ] **Step 3:** Implement `REGISTRY_SLOTS` (6 fixed + `biome0..9`), `defaultRegistryMapping()` mapping each slot → a sensible `SatMapName` from `SATMAP_NAMES` (reuse the `pick()` fallback idea from `mesh.ts`), `loadRegistry(mapping) -> Record<slot, THREE.Texture>` via `loadSatMap` (bilinear, `ClampToEdgeWrapping`).
- [ ] **Step 4:** PASS.
- [ ] **Step 5: Commit** `git add apps/hayba-explorer/src/viewport/bake/satmapRegistry.ts apps/hayba-explorer/src/viewport/bake/satmapRegistry.test.ts` → `feat(shading): SatMap registry (6 fixed + 10 biome slots)`.

### Task C2: The §7.3 composite shader

**Files:** Create `src/viewport/shaders/surface.glsl.ts` + `surface.glsl.test.ts`.

- [ ] **Step 1: Failing test** (shape + ALU guard):

```ts
// Run: npx tsx src/viewport/shaders/surface.glsl.test.ts
import assert from "node:assert/strict";
import { SURFACE_VERT, SURFACE_FRAG } from "./surface.glsl";
for (const s of [SURFACE_VERT, SURFACE_FRAG]) {
  assert.ok(s.includes("void main"));
  assert.ok(!s.includes("`"), "no backtick in GLSL (template-literal footgun)");
}
// ALU Bake Enforcement: no multi-octave noise loops in the live shader
assert.ok(!/for\s*\(.*octave/i.test(SURFACE_FRAG), "no procedural fbm loop in live shader");
assert.ok(SURFACE_FRAG.includes("combineMax") && SURFACE_FRAG.includes("combineOverlay"),
  "uses noise-masked Combine/Max, not flat alpha");
console.log("ok");
```

- [ ] **Step 2:** FAIL.
- [ ] **Step 3:** Implement `SURFACE_VERT` (sphere pos → equirect uv: `u = atan2(z,x)/(2π)+0.5`, `v = asin(y)/π+0.5`; pass `vUv`, `vSpherePos`) and `SURFACE_FRAG` = the spec §7.3 composite **verbatim**: single-tap reads of every mask via the `sampleField` bindings, `mix` global dry/wet by `smoothstep(uWetLo,uWetHi,wet)`, biome winner-take-all blended only inside `noisePerturbedFrontier`, `combineMax` flow/curvature/mountain masked by `physicalDriver*(k+(1-k)*edgeBreak)`, per-biome brush, snow last, `macroVariation`/`microCohesion`/blue-noise jitter (the only live tap), `pow(AO,uAOStrength)`, `mountainStandout`, tonemap. Provide `combineOverlay`/`combineMax`/`tonemap` GLSL helpers (no flat alpha anywhere).
- [ ] **Step 4:** PASS.
- [ ] **Step 5: Commit** `git add apps/hayba-explorer/src/viewport/shaders/surface.glsl.ts apps/hayba-explorer/src/viewport/shaders/surface.glsl.test.ts` → `feat(shading): §7.3 multi-layer SatMap composite shader (single-tap, no flat alpha)`.

## Phase C1 — Material & live knobs

### Task C3: Surface material + uniform/knob plumbing

**Files:** Create `src/viewport/bake/surfaceMaterial.ts` + `surfaceMaterial.test.ts`; Modify `src/viewport/bake/sampleField.ts` (add `bindToMaterial`).

- [ ] **Step 1: Failing test**

```ts
// Run: npx tsx src/viewport/bake/surfaceMaterial.test.ts
import assert from "node:assert/strict";
import { SURFACE_KNOBS } from "./surfaceMaterial";
for (const k of ["wetLo","wetHi","varAmp","jitterAmp","cohesion","aoStrength",
                  "mountainContrast","layerOpacity"])
  assert.ok(k in SURFACE_KNOBS, `knob ${k} declared`);
console.log("ok");
```

- [ ] **Step 2:** FAIL.
- [ ] **Step 3:** Implement `SURFACE_KNOBS` (default values), `buildSurfaceMaterial(sampleField, registry)` → `THREE.ShaderMaterial` (binds all mask textures via `sampleField.bindToMaterial(mat)`, registry textures, knob uniforms) on a `THREE.SphereGeometry`; `setKnob(name, value)` updates the uniform live (no rebuild). `sampleField.bindToMaterial(mat)` sets `mat.uniforms` for every catalog channel per Plan B's documented binding map.
- [ ] **Step 4:** PASS; `npx tsc -b` clean.
- [ ] **Step 5: Commit** `git add apps/hayba-explorer/src/viewport/bake/surfaceMaterial.ts apps/hayba-explorer/src/viewport/bake/surfaceMaterial.test.ts apps/hayba-explorer/src/viewport/bake/sampleField.ts` → `feat(shading): surface material + live knob plumbing + sampleField binding`.

### Task C4: Always-accessible Shading Settings panel

**Files:** Create `src/components/panels/ShadingPanel.tsx`; Modify `src/components/RightPanel.tsx`.

- [ ] **Step 1: Failing test**

```ts
// Run: npx tsx src/components/panels/ShadingPanel.test.ts
import assert from "node:assert/strict";
import { SHADING_CONTROLS } from "./ShadingPanel";
assert.ok(SHADING_CONTROLS.some(c=>c.knob==="wetLo") &&
          SHADING_CONTROLS.some(c=>c.knob==="jitterAmp"));
for (const c of SHADING_CONTROLS) assert.ok(c.min<c.max && c.knob, "valid control");
console.log("ok");
```

- [ ] **Step 2:** FAIL.
- [ ] **Step 3:** Implement `SHADING_CONTROLS` (slider descriptors for every `SURFACE_KNOBS` entry + per-layer opacity + per-slot SatMap pickers using `SATMAP_NAMES`) and `ShadingPanel` (follows `TexturingPanel.tsx`/`PropertyRow` patterns; calls `surfaceMaterial.setKnob`). Register in `RightPanel.tsx` as an **always-available** category (not gated behind a "texturing step" — spec §7).
- [ ] **Step 4:** PASS; `npm run build` succeeds.
- [ ] **Step 5: Commit** `git add apps/hayba-explorer/src/components/panels/ShadingPanel.tsx apps/hayba-explorer/src/components/RightPanel.tsx apps/hayba-explorer/src/components/panels/ShadingPanel.test.ts` → `feat(shading): always-on Shading Settings panel`.

### Task C5: Wire bake chain → surface render; retire the per-cell mesh path

**Files:** Modify `src/App.tsx`.

- [ ] **Step 1:** (Integration — visual.) tsx test that `App` exports a `BAKE_CHAIN` order constant `["h0","erode","masks","sampleField","surface"]` (pins the wiring contract).
- [ ] **Step 2:** FAIL.
- [ ] **Step 3:** After Plan B's bake completes, build `registry` (C1) + `surfaceMaterial` (C3) and `scene.setGlobe(surfaceMaterial.mesh)`; mount `ShadingPanel` always. The legacy per-cell `buildGlobeMesh`/`planet.glsl` path is no longer the post-bake renderer (leave the wizard-time point-cloud `globe.ts` for painting). Export `BAKE_CHAIN`.
- [ ] **Step 4:** PASS; `npm run build` ok.
- [ ] **Step 5: Commit** `git add apps/hayba-explorer/src/App.tsx` → `feat(shading): bake chain → live SatMap surface render (replaces per-cell post-bake path)`.

## Phase C2 — Validation

### Task C6: Visual validation (the "onto Earth" spec §7.4 cases)

- [ ] **Step 1:** Bake the Earth template. Verify spec §7.4: **Sahara** = dry desert SatMap, dunes aligned by `dune·windExposure`, sand low / rock on mesas (localRelief axis working); **Amazon** = wet rainforest SatMap, mottled by `vegetationPatch`, rivers via `flow` SatMap widened by `flowSDF` (no 1-px lines); **Himalaya** = `mountain` rock windward + `snow` on top, ragged by `edgeBreak`.
- [ ] **Step 2:** Verify the no-flat-mush rule: biome interiors crisp, blending only in `noisePerturbedFrontier`; no visible ±180° seam; neighbour cohesion present but macro-invisible (baked micro-bleed) with live `jitterAmp` giving similar-not-identical variation.
- [ ] **Step 3:** Toggle every live knob; confirm instant response (no re-bake) and no perf regression (single-tap budget; check fps).
- [ ] **Step 4:** Validate **visually** per standing rule; file fix tasks for any failure before C sign-off.
- [ ] **Step 5: Commit** (notes) `git add docs/superpowers/specs/2026-05-15-baking-pipeline-redesign-design.md` → `docs(shading): Subsystem C visual-validation results + sign-off`.

---

## Self-Review

**Spec §7 coverage:** §7.1 LUT atom (localRelief,slope) → C2 shader sampling; §7.2 registry → C1; §7.3 composite verbatim → C2 (test asserts Combine/Max, no flat alpha, no procedural octave loop = ALU enforcement honored, spec §6); §7.4 onto-Earth → C6; §7.5 live vs baked → C3 knobs live / all noise baked in Plan B. Always-on (no texturing step) → C4/C5. **Placeholder scan:** SURFACE_FRAG specified as "spec §7.3 verbatim" with the spec block being concrete pseudo-GLSL + a shape/ALU test pinning it — not a TODO. **Type consistency:** `REGISTRY_SLOTS`, `loadRegistry`, `SURFACE_VERT/FRAG`, `SURFACE_KNOBS`, `buildSurfaceMaterial`, `setKnob`, `bindToMaterial`, `SHADING_CONTROLS`, `BAKE_CHAIN` consistent across tasks; consumes Plan B `SampleField`/`MaskTextureSet` names. **Scope:** Subsystem C only; D layers AO/mountain-standout polish + lighting on top of C's output and owns the Phase-2 CDLOD interface seam.
