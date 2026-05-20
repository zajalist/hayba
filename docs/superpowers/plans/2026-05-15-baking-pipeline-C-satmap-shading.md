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

> **Review C1/C2 (NORMATIVE):** binding 16 SatMaps + ~4–8 mask textures + blue
> noise as individual `sampler2D` exceeds the WebGL2-guaranteed
> `MAX_TEXTURE_IMAGE_UNITS = 16` (silent fail on Apple/mobile/Intel). And
> dynamic `sampler2D[]` indexing by a mask-read id is **illegal** in GLSL ES
> 3.0. Both are solved by packing every SatMap into ONE
> `THREE.DataArrayTexture` (`sampler2DArray`): all SatMaps share the LUT
> coordinate space, so `texture(uSatArray, vec3(localRelief, slope01, layer))`
> with a *dynamic* `layer` is legal and is a single binding.

```ts
// Run: npx tsx src/viewport/bake/satmapRegistry.test.ts
import assert from "node:assert/strict";
import { REGISTRY_LAYERS, defaultRegistryMapping, LAYER_INDEX } from "./satmapRegistry";
assert.deepEqual(REGISTRY_LAYERS.slice(0,6),
  ["globalDry","globalWet","snow","flow","curvature","mountain"]);
assert.equal(REGISTRY_LAYERS.filter(s=>s.startsWith("biome")).length, 10);
assert.equal(REGISTRY_LAYERS.length, 16, "16 array layers");
assert.equal(LAYER_INDEX.mountain, 5, "stable layer index for GLSL");
const m = defaultRegistryMapping();
for (const s of REGISTRY_LAYERS) assert.ok(m[s], `${s} has a default SatMap name`);
console.log("ok");
```

- [ ] **Step 2:** `cd apps/hayba-explorer && npx tsx src/viewport/bake/satmapRegistry.test.ts` → FAIL.
- [ ] **Step 3:** Implement `REGISTRY_LAYERS` (the 16 ordered layer names: 6 fixed + `biome0..9`), `LAYER_INDEX` (name→integer layer, the stable index GLSL uses), `defaultRegistryMapping()` (each layer → a `SatMapName`, reuse `mesh.ts` `pick()` fallback), and `loadRegistryArray(mapping) -> THREE.DataArrayTexture` — load every SatMap via `loadSatMap`, assert a common WxH, copy each into array layer `LAYER_INDEX[name]`, `LinearFilter`, `ClampToEdgeWrapping`. **One texture binding, dynamic layer index legal.**
- [ ] **Step 4:** PASS.
- [ ] **Step 5: Commit** `git add apps/hayba-explorer/src/viewport/bake/satmapRegistry.ts apps/hayba-explorer/src/viewport/bake/satmapRegistry.test.ts` → `feat(shading): SatMap registry as a single DataArrayTexture (1 binding, dynamic layer)`.

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
// Review C1/C2: one sampler2DArray, no sampler2D[] (illegal dynamic index)
assert.ok(SURFACE_FRAG.includes("sampler2DArray") && !/sampler2D\s+uBiome\d/.test(SURFACE_FRAG),
  "SatMaps via sampler2DArray, not a sampler array");
assert.ok(!/for\s*\([^)]*biome/i.test(SURFACE_FRAG), "no 10-biome loop (2-tap primary/secondary)");
// Review C5: equirect seam — no auto-mip LOD on mask sampling
assert.ok(SURFACE_FRAG.includes("textureLod(") && !/[^L]texture\(\s*u(Mask|Height)/.test(SURFACE_FRAG),
  "mask reads use textureLod(...,0.0) not auto-mip texture()");
// Review C4: layer fetches are branch-culled
assert.ok(/if\s*\(\s*(snow|river|mountain)/i.test(SURFACE_FRAG), "layer fetches are branch-culled");
console.log("ok");
```

- [ ] **Step 2:** FAIL.
- [ ] **Step 3:** Implement `SURFACE_VERT` (sphere pos → equirect uv: `u = atan2(z,x)/(2π)+0.5`, `v = asin(y)/π+0.5`; pass `vUv`, `vSpherePos`, smooth `vGeomNormal`) and `SURFACE_FRAG` = the spec §7.3 composite with these **NORMATIVE review fixes**:
  - **C1/C2:** SatMaps sampled from one `uniform sampler2DArray uSatArray` — `satTap(layer, lr, sl) = textureLod(uSatArray, vec3(lr, sl, float(layer)), 0.0)`. `layer` may be dynamic (legal for array layers).
  - **C3:** biome = exactly **two** taps: `mix(satTap(LAYER.biome0+biomePrimary,…), satTap(LAYER.biome0+biomeSecondary,…), blendWeight)` (B emits primary/secondary/blendWeight — no 10-loop).
  - **C4 (dependent-read stall):** wrap optional layers in spatially-coherent branches — `if (riverMask>0.0){…flow tap…}`, `if (snowMask>0.0){…snow tap…}`, `if (rockExposure*highAlt>0.0){…mountain tap…}` — so unfetched layers cost nothing off-feature. Keep total *unconditional* SatMap taps minimal (global base + 2 biome).
  - **C5 (equirect seam):** every mask/`hFinal`/SatMap read uses `textureLod(s, uv, 0.0)` (never auto-mip `texture()`), so the exploding dFdx/dFdy at the ±180° seam and poles cannot trigger LOD blur that re-exposes the seam.
  - Rest = spec §7.3 verbatim (global dry/wet `mix` by `smoothstep(uWetLo,uWetHi,wet)`; `combineMax` flow/curv/mountain masked `physicalDriver*(k+(1-k)*edgeBreak)`; per-biome brush; snow last; `macroVariation`/`microCohesion`/one blue-noise jitter tap; AO; `mountainStandout`; tonemap). `combineOverlay`/`combineMax`/`tonemap` helpers; no flat alpha.
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
import { samplerBindingCount } from "./surfaceMaterial";
// Review C1: must stay under WebGL2-guaranteed MAX_TEXTURE_IMAGE_UNITS=16.
// 1 sampler2DArray (all SatMaps) + mask MRT textures + 1 blue-noise.
assert.ok(samplerBindingCount() <= 12, `sampler bindings ${samplerBindingCount()} <= 12 (<<16)`);
console.log("ok");
```

- [ ] **Step 2:** FAIL.
- [ ] **Step 3:** Implement `SURFACE_KNOBS` (default values), `samplerBindingCount()` (returns the total bound samplers: **1** `uSatArray` `sampler2DArray` + the small set of packed mask MRT textures from Plan B's per-target layout + 1 `uBlueNoise` — must be ≤12), `buildSurfaceMaterial(sampleField, registryArray)` → `THREE.ShaderMaterial` (binds the single `DataArrayTexture`, the packed mask textures via `sampleField.bindToMaterial(mat)`, knob uniforms) on a `THREE.SphereGeometry`; `setKnob(name,value)` updates a uniform live (no rebuild). `bindToMaterial` binds the **packed** mask textures (Plan B `MaskTextureSet`, ~2 RGBA8 + ~2 RGBA16F, not 1-per-channel) — keeping the unit count low.
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

**Spec §7 coverage:** §7.1 LUT atom (localRelief,slope) → C2; §7.2 registry → C1; §7.3 composite → C2; §7.4 onto-Earth → C6; §7.5 live/baked → C3. Always-on → C4/C5.

**Architecture-review fixes folded in:** **(C1, MAX_TEXTURE_IMAGE_UNITS)** all 16 SatMaps → ONE `THREE.DataArrayTexture`/`sampler2DArray` (C1); `samplerBindingCount()≤12` asserted (C3) — well under the guaranteed 16. **(C2, illegal dynamic sampler index)** dissolved by the array texture: `textureLod(uSatArray, vec3(lr,sl,layer),0.0)` with dynamic `layer` is legal; test forbids `sampler2D uBiomeN`. **(C3, 10-biome ALU)** B emits `biomePrimary/biomeSecondary/blendWeight`; C does exactly 2 biome taps + `mix`; test forbids a biome loop. **(C4, dependent-read stall)** optional layers (flow/snow/mountain) wrapped in spatially-coherent `if(mask>0.0)` branches; unconditional taps minimized; test asserts branch-culling. **(C5, equirect mip tear)** every mask/height/SatMap read uses `textureLod(...,0.0)` — no auto-mip LOD, so seam/pole dFdx explosion can't blur-expose the seam; test asserts it.

**Placeholder scan:** SURFACE_FRAG = spec §7.3 + the 5 enumerated review fixes, pinned by concrete shape/ALU/array/branch/LOD assertions — not a TODO. **Type consistency:** `REGISTRY_LAYERS`, `LAYER_INDEX`, `loadRegistryArray`, `uSatArray`, `SURFACE_VERT/FRAG`, `vGeomNormal`, `SURFACE_KNOBS`, `samplerBindingCount`, `buildSurfaceMaterial`, `setKnob`, `bindToMaterial`, `SHADING_CONTROLS`, `BAKE_CHAIN` consistent; consumes Plan B `SampleField`/`MaskTextureSet` + `biomePrimary/biomeSecondary/blendWeight`. **Scope:** Subsystem C only; D adds lighting/AO/atmosphere on C's output + owns the Phase-2 CDLOD seam.
