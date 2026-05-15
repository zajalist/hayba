# Hayba Explorer Planet Shader — Industry-Standards Upgrade Dossier

**Date:** 2026-05-15
**Status:** Research compilation; pre-implementation
**Audience:** future implementer (subagent or human)
**Working file:** `apps/hayba-explorer/src/viewport/shaders/planet.glsl.ts`
**Prior brief (do not re-derive):** `docs/research/2026-05-13-realistic-planet-rendering.md` (still relevant; this doc supersedes for current-state audit)

---

## 0. Executive summary

The current shader is a working multi-zone climate blender with Beer-Lambert ocean, ACES tone mapping, hash-noise FBM, slope rock mask, and per-fragment latitude-driven SatMap selection. It hits roughly 40–50% of AAA-style planet realism on a small budget. The remaining 50% comes from **decoupling physics from color**, **introducing a real macro-normal pass**, and **fixing five concrete bugs** that produce the artifacts the user reported (cyan ocean, equatorial snow patches, hex silhouette).

### THE central bug (validated against user screenshots 2026-05-15)

**Continents render as concentric contour rings ("bullseye"), not terrain.** This is the single most important finding in this document and supersedes the original framing of §3.4 as a "polish" item. Base albedo is keyed on **elevation alone** via a 1D-gradient SatMap lookup (`sampleGradient(tex, h)`, `h = elevField/1.6`). Because the sim pushes continent centers high and edges low, elevation varies **radially**, so a 1D lookup paints **closed colour contours** — dark center → olive ring → white halo → orange ring → blue edge. The FBM offset on `h` only makes the rings *wavy*; it never breaks them into surface texture. Every other land artifact (white halo, orange band, dark centers) is a symptom of this one disease. **Fix = stop keying base colour on elevation; key it on a horizontally-varying biome/climate field, with elevation demoted to a secondary modifier (snow line, rock, coastal tint).** See §3.4 (reframed) and §C (color pipeline) below.

### Pre-flight: color management may be invalidating everything (under-weighted in v1)

Before *any* shader colour work: verify the Three.js r0.169 colour pipeline. The muddy/crushed/desaturated look in the user's screenshots is the textbook signature of an sRGB/linear mismatch. Our SatMaps are k-means-derived from real Blue Marble sRGB PNGs. If they're decoded as linear (wrong `.colorSpace`), or `renderer.outputColorSpace`/tone-map order is wrong, **no shader colour change will fix the look** — it's upstream. See new §C. This is cheap to check and must be ruled out first.

### The five most leveraged changes (do these first)

| # | Change | Effort | Quality gain | Section |
|---|---|---|---|---|
| 0 | Verify/fix sRGB-linear color pipeline + texture `.colorSpace` | 1h | Possibly the whole muddy look; gates everything below | §C |
| 1 | Replace elevation-keyed albedo with biome/climate-keyed field | 4h | **Kills the bullseye** — the headline bug | §3.4 |
| 2 | Fix ocean palette + coast-noise/mask-window + fresnel + glint | 2h | Water reads "Earth"; kills cyan + speckled fringe | §3.1 |
| 3 | Elevation-gate the rock mask | 30m | Removes the spurious grey/white mid-continent rings | §3.2 |
| 4 | Macro-normal from elevation derivatives + detail noise | 2h | Continents stop looking like flat decals — relief | §3.3 |
| 5 | Two-layer cloud system (drop-shadow + volumetric edge) | 3h | Earth signature: scale-selling clouds with land shadows | §3.5 |

Order matters: §C gates everything (a gamma bug masks all colour work), §3.4 is THE bug, then ocean, then relief. Subsequent layers (atmospheric scattering LUTs, ocean current advection, biome NDVI proxy) are improvements but not transformative on the same axis.

---

## 1. Current shader audit (what we have, what's wrong)

### 1.1 What's working

- **ACES filmic tone mapping** (Narkowicz 2015 approx) — correct shoulder; output never clips. Keep.
- **Climate-zone latitude blending** (4-band Köppen mapping). Correct concept; the *thresholds* are reasonable but the *inputs* miss east-west variation (see §4.1).
- **Beer-Lambert ocean depth gradient** (coast → shelf → abyss). Correct concept; palette wrong (see §3.1).
- **Per-fragment FBM** (5 octaves, lacunarity 2, persistence 0.48). Standard and good. Keep.
- **Slope rock mask with fwidth AA**. Correct concept but trigger logic is too aggressive on shallow interiors (see §3.2).
- **Vertex-hash coast jitter** breaks straight hexagonal silhouettes. Keep, maybe strengthen.
- **Cavity AO from `length(vec2(dFdx, dFdy))`**. Cheap and effective. Keep.
- **Rim halo + atmosphere blend**. Right idea but values produce a "soap bubble" look; tune down halo (see §4.5).

### 1.2 What's wrong (root-cause analysis of reported bugs)

**Bug 0 — THE bug: continents are concentric contour rings ("bullseye").**

Confirmed against the 2026-05-15 screenshot. `base = sampleGradient(uSat*, h)` with `h = elevField/1.6` reads one vertical column of the SatMap indexed by height. Sim uplift makes elevation vary *radially* across each continent (high center, low coast), so equal-elevation cells get equal colour everywhere → **closed colour contours**: dark center → olive/yellow ring → white halo → orange ring → blue edge. The `+ (fbmCoarse-0.5)*0.55` offset on `h` only makes the rings *wavy*, never breaks them into terrain. The white halo, orange band and dark centers are all the *same* artifact — different SatMap rows traced as loops at fixed elevations. This is not a tuning problem; the data model (1D elevation LUT as the primary albedo key) is wrong. See §3.4 (reframed) and §C.

**Bug 0b — green/land reads near-black.** Four compounding causes: (1) the dark center is the *wrong row* (high-elevation top of the gradient), not vegetation — a symptom of Bug 0; (2) real vegetation albedo is genuinely low and nothing lifts it; (3) no macro-normal → no sunlit-slope midtone lift (§3.3); (4) cavity-AO `*mix(0.78,1.0)` then `aces(lit*1.05)` double-crush already-dark input. Plus a likely gamma-pipeline fault (§C) that desaturates everything upstream of the shader.

**Bug A — "Ocean too cyan" + noisy near-white fringe at coastlines.**

Two symptoms, one bug family. Current palette (`planet.glsl.ts` lines 226–228):
```glsl
vec3 coast   = vec3(0.55, 0.82, 0.88);   // shallow reef turquoise — too saturated
vec3 shelf   = vec3(0.18, 0.50, 0.74);   // still too bright in red+green
vec3 abyss   = vec3(0.02, 0.08, 0.22);   // OK but reached too late
```

Real Earth-from-orbit ocean as captured by Blue Marble + Suomi NPP VIIRS:
- Deep ocean: roughly `vec3(0.012, 0.039, 0.098)` (sRGB), ~RGB(3, 10, 25)
- Continental shelf: `vec3(0.043, 0.137, 0.235)`
- Coast (clear tropical): `vec3(0.118, 0.314, 0.471)` — the brightest case
- Coast (turbid temperate, e.g. North Sea): `vec3(0.063, 0.165, 0.235)`

The current "shallow reef turquoise" is what an artist would paint a *Caribbean reef closeup*, not an *Earth-from-orbit coastline*. The `0.55, 0.82, 0.88` is closer to a swimming pool. Worse: the depth blend reaches `coast` color across an enormous surface area because `t1` ramps from 0 at depth=0 to 1 at depth=0.08 — a tiny depth window. Most of "ocean" is the bright coast color. **This is why painting any modest ocean depth renders cyan**: small depth → `t1 ≈ 0` → pure `coast` → pool-cyan, then `* (1.0 + ripple)` pushes it brighter toward white.

**The noisy near-white fringe at every coastline** is a distinct mechanism in the same block:
```glsl
float coastNoise = (fbm(vWorldNormal*55.0) - 0.5) * 0.12;   // ±0.06
float oceanMask  = 1.0 - smoothstep(-0.02, 0.05, seaCoord); // 0.07-wide window
```
At the shoreline `vElevation≈0` so `seaCoord≈coastNoise` (±0.06), modulating a mask whose transition window is only 0.07. **Noise amplitude ≈ transition width → the mask dithers 0↔1 cell-to-cell** instead of producing an organic edge, and at `d≈0` the colour is pinned to the bright `coast` stop → a speckled near-white-cyan band tracing every coast. **General principle (applies to snow line §4.2 too): any FBM perturbing a smoothstep mask MUST have amplitude ≪ the smoothstep window, or you get dither, not organic variation.** Fix is either drop `coastNoise` to ~±0.015 *or* widen the `oceanMask` window to ~0.18 (≫ noise amplitude). Palette fix alone will not remove the speckle.

Also missing entirely:
- **Schlick fresnel reflectance**. At grazing angles, water reflects almost 100% — gives the bright limb on Earth photos. Current shader has none.
- **Sun specular highlight (sun glint)**. The "diamond on the sea" reflection. Trivially cheap via Blinn-Phong on the water layer.
- **Sub-surface scattering tint**. Below the surface, light scatters back as a faint cyan-green. Different from the surface reflection. Real shallow tropical water gets its turquoise from this; the current shader fakes it as the *surface* color, which is wrong.

**Bug B — "Random snow at the equators (no painted heights)."**

The post-bake snapshot has `vElevation` ≠ 0 even on un-painted continents because:
1. The Rust sim runs `run_length_steps = 5` step calls after bake. Boundary cells with `collision_kind = "subduction"` or `"orogenic"` accumulate uplift (`orogenicUplift`). At div=32 with default plate velocities, some boundary cells reach `elevation ≈ 0.6–0.9`.
2. The shader's snowMask: `tempLand = 30 - max(elev,0)*6 - latNoisy*32 + (fbmFine-0.5)*2.5`. At equator (`latNoisy=0`) with `elev=0.9`: `tempLand = 30 - 5.4 + ~0 = 24.6°C`. Threshold `1 - smoothstep(-6, -1, 24.6)` returns 0. So the snow mask itself does *not* fire equatorially even with high elevation.

The "snow" in the screenshot is actually **the alpine SatMap rock pattern**, not the procedural `snowMask`. The rockMask formula:
```glsl
float rockMask = smoothstep(0.55 - sw, 0.70 + sw, slopeWithNoise);
```
fires whenever local slope is moderately high. Anti-aliased slope between two adjacent un-painted continental cells can briefly exceed 0.55, sampling the alpine SatMap which contains snowy upper tones. Result: random "snow-like" patches scattered through continental interiors at the equator — exactly what the screenshot shows.

Fix: gate `rockMask` on actual elevation thresholds (slope alone isn't enough — a 30° gradient at sea level is a hill, not a cliff), and/or pick a rock SatMap that doesn't have snowy upper bands.

**Bug C — Hexagonal silhouette artifacts at coastlines.**

The vertex-hash jitter `n_coast * 0.18 + n_micro * 0.06` is small relative to the underlying hex displacement. At div=32 (~10K cells), the angular size of each hex is ~2°, which dominates. Two fixes possible:
1. Increase jitter strength on coastline vertices specifically (only where `|elevation| < 0.1`).
2. Use a per-fragment SDF approach for the coast band — sample the underlying mask at higher frequency via the FBM and apply the coast color via that mask instead of via the per-vertex elevation.

**Bug D — Snow line is *too soft* / not realistic.**

Real Earth snow line is bimodal: high-latitude continuous snow (Antarctica, Greenland, Siberia, northern Canada) + high-altitude isolated snow (Himalayas, Andes, Rockies). The current shader produces neither sharply — temperature noise + soft smoothstep produce a fuzzy halo around poles.

Fix: include slope-based mask ("snow doesn't stick to >35° slopes"), include aspect mask ("equator-facing slopes melt faster"), require both temperature AND minimum precipitation. See §4.2.

**Bug E — Banding from per-fragment 3D fbm at low octaves.**

The 5-octave FBM with lacunarity 2 produces visible bands at the planet scale because the octave frequencies (6, 12, 24, 48, 96) leave a gap before micro-detail. Add a stochastic offset per octave (or use lacunarity 2.1 / persistence 0.5) to break the regularity. See §4.7.

---

## 2. Industry standards reference table

### 2.1 Real-time procedural planets

| Studio / Project | Tech | Source |
|---|---|---|
| Star Citizen — Planet Tech v4 (CIG, 2018) | Procedural ruleset for biomes via temperature + humidity nodes; baked-in directional wind vectors deposit moisture; up to 8 layered shader materials sampled triplanar with stochastic offset | GDC 2018 "Planet Tech in Star Citizen" by Sean Tracy |
| No Man's Sky (Hello Games) | Voxel-based ROAM terrain with procedural biome assignment; uses 3D temperature + humidity gradients; vegetation density driven by moisture/temperature ratio | Sean Murray GDC 2017 |
| Outerra Engine | Heightmap-driven planet with fractal detail synthesis; uses normal-map detail blending + screen-space derivative normals; per-biome triplanar with rock/grass/snow/sand | Various dev blog posts |
| Elite: Dangerous (Frontier) | Stellar Forge — physically-based stellar/planetary parameter generation, then shaders use Bruneton atmospheric scattering with multi-scattering | Frontier Expo 2017 |
| KSP / KSP2 (Squad / IG) | Planetary Quad Sphere with displacement; rocky/icy/gaseous shader variants; KSP2 used wind-vector cloud advection | Various dev streams |

### 2.2 Atmospheric scattering papers

- **Bruneton & Neyret 2008** — "Precomputed Atmospheric Scattering". 4D LUT for transmittance + single-scattering. The reference implementation for AAA.
- **Hillaire 2020 (Frostbite)** — "A Scalable and Production-Ready Sky and Atmosphere Rendering Technique". Multi-scattering LUT, suitable for real-time. Used in Battlefield V+, Frostbite-era titles.
- **Wenzel 2007 (Crytek)** — Atmospheric scattering with eye-fly altitude. CryEngine-style cheap fake.
- **O'Neil 2005** — Pre-Bruneton; analytic Rayleigh + Mie approximation in a single shader. Still useful for a single-pass approach.

### 2.3 Cloud rendering papers

- **Schneider & Vos 2015 (Guerrilla Games)** — "The Real-time Volumetric Cloudscapes of Horizon Zero Dawn". Voxel-traced volumetric clouds, raymarched. The gold standard.
- **Hillaire 2016 (Frostbite)** — "Physically Based Sky, Atmosphere and Cloud Rendering". Cheaper than Schneider; uses 3D detail noise + 2D weather map.
- **Wenzel 2006 (Crytek)** — Cheap raymarched cumulus on a sky dome.

### 2.4 Ocean shading papers

- **Tessendorf 2001** — "Simulating Ocean Water". FFT wave displacement; the foundation. Still used by Sea of Thieves, Subnautica, Atlas, etc.
- **Bruneton 2010** — "Real-time Realistic Ocean Lighting using Seamless Transitions from Geometry to BRDF". The transition from displacement (close) to BRDF (far) — relevant for planet scale.
- **Acerola 2023** — "How are Games Rendering Oceans?" — modern compilation of techniques. YouTube reference.
- **Sea of Thieves dev blog 2018** — Layered Gerstner waves + FFT for storm seas, with sub-surface scattering and foam.

### 2.5 Terrain / biome blending

- **Quilez** (Inigo Quilez articles) — Domain warping, triplanar mapping, stochastic texturing. https://iquilezles.org/articles/
- **Heitz & Neyret 2018** — "By-Example Synthesis of Procedural Tilings". Hex tiling for repeat-free textures.
- **Sebastian Lague** — YouTube series on procedural planets (good for tutorial-level explanation; not production-grade)
- **Adobe Substance / Quixel Megascans** — Industry-standard PBR texture libraries; their biome-blending guides are gold for material authoring

### 2.6 Tone mapping & color

- **Narkowicz 2015** — "ACES Filmic Tone Mapping Curve" approximation. What we currently use.
- **ACES (Academy 2017)** — full ACES reference transform; overkill for most games but the gold standard
- **Lottes 2016** — "Advanced Techniques and Optimization of HDR Color Pipelines". Used by AMD's tonemapper

---

## 3. The five highest-leverage upgrades

### 3.1 Ocean: realistic palette + fresnel + sun glint

**Why now:** the user explicitly called out cyan-water issue. Single largest visual delta.

**Real Earth ocean color** (deep, no SSS): `vec3(0.012, 0.039, 0.098)` after sRGB → linear.
**Continental shelf** (~200m): `vec3(0.043, 0.137, 0.235)`.
**Tropical coast** (clearest, ~10m, with SSS turquoise): `vec3(0.118, 0.314, 0.471)`.
**Tropical SSS tint**: `vec3(0.31, 0.69, 0.78)` — applied as a separate scattering term, not as the base color.

**Drop-in replacement** for lines 217–243 of the current shader:
```glsl
if (oceanMask > 0.001) {
  // Three-stop palette tuned to Earth orbital photography
  vec3 deepAbyss = vec3(0.008, 0.025, 0.073);
  vec3 shelf     = vec3(0.043, 0.137, 0.235);
  vec3 coast     = vec3(0.118, 0.314, 0.471);

  // Depth (positive = deeper than sea level)
  float d = max(-seaCoord, 0.0);

  // Wider blend windows so abyss color dominates
  float t1 = smoothstep(0.00, 0.10, d);    // coast → shelf
  float t2 = smoothstep(0.12, 0.55, d);    // shelf → abyss
  vec3 water = mix(coast, shelf, t1);
  water = mix(water, deepAbyss, t2);

  // Sub-surface scatter — only fires in shallow tropical water
  float shallow = (1.0 - smoothstep(0.0, 0.08, d));
  float tropical = smoothstep(0.45, 0.20, latNoisy);   // closer to equator → more
  vec3 sss = vec3(0.31, 0.69, 0.78);
  water += sss * (shallow * tropical * 0.45);

  // Schlick fresnel — water reflects more at grazing angles
  vec3 V = normalize(cameraPosition - vWorldPos);
  float NdotV = max(dot(vWorldNormal, V), 0.0);
  float F0 = 0.02;          // water's normal-incidence reflectance
  float fres = F0 + (1.0 - F0) * pow(1.0 - NdotV, 5.0);

  // Sun glint — Blinn-Phong on a perturbed water normal
  vec3 H = normalize(L + V);
  vec3 perturbed = normalize(vWorldNormal + vec3(
    (fbm(vWorldNormal * 220.0) - 0.5) * 0.02,
    0.0,
    (fbm(vWorldNormal * 220.0 + 17.0) - 0.5) * 0.02
  ));
  float NdotH = max(dot(perturbed, H), 0.0);
  float specular = pow(NdotH, 220.0) * fres * 3.0;

  // Composite — base water + skybox reflection + sun specular
  vec3 skyTint = vec3(0.45, 0.68, 0.96);     // mock skybox tone
  water = mix(water, skyTint, fres * 0.45);
  water += vec3(1.0, 0.97, 0.85) * specular;

  albedo = mix(albedo, water, oceanMask);
}
```

**Cost:** +1 fbm call (220-freq), +2 dot products, +1 pow. <0.1ms per frame at our resolution.

**Visual gain:** transformative. Water reads as actual ocean depth with reflective shimmer and tropical hot-spots.

### 3.2 Kill rock-mask false positives

**Root cause:** `rockMask` is purely slope-driven and fires on shallow continent interiors where two adjacent cells have different post-sim elevations.

**Fix:** require both high slope AND elevation above some "definitely mountain" threshold:
```glsl
float slopeWithNoise = vSlope + (fbmHigh - 0.5) * 0.18;
float sw = max(fwidth(slopeWithNoise), 0.001);
float rawSlope = smoothstep(0.55 - sw, 0.70 + sw, slopeWithNoise);

// Gate by elevation — rock only at meaningful altitude
float altGate = smoothstep(0.18, 0.35, vElevation);   // off at sea level, full at high mountains
float rockMask = rawSlope * altGate;
```

This single change eliminates the equatorial snow-patch artifact. The alpine SatMap will only sample at actual high-altitude cells, which is the right behavior.

**Additional improvement:** swap the `alpine` SatMap for one without snow tones. The current `alpine` LUT is meant for "snowy peaks" but is fired regardless of latitude. Two options:
1. Have *two* rock SatMaps — `rockAlpine` (snowy) and `rockExposed` (bare brown/grey) — blended by latitude.
2. Apply snow as a *separate* mask on top of the rock layer (cleaner — see §4.2).

### 3.3 Macro-normal from elevation derivatives + detail noise

**Why this is the biggest perceptual gain you can buy:** real Earth from orbit doesn't have geometric Everests sticking out of the sphere. It has a smooth sphere with *normals that vary by tens of degrees over kilometers*. That's what makes the Andes look like the Andes from space — not 8km of geometric displacement, but a normal map.

**Current state:** `vWorldNormal = normalize(position)` — every fragment uses the analytic sphere normal. All variation comes from the SatMap albedo.

**Upgrade:** compute a per-fragment perturbation from the elevation gradient + a detail noise band:
```glsl
// In fragment shader, after FBM scalars:

// Macro: gradient of vElevation across the surface
vec3 dNdx = vec3(dFdx(vElevation), 0.0, 0.0);
vec3 dNdy = vec3(0.0, 0.0, dFdy(vElevation));

// Detail: a 256-freq noise band perturbs the normal at micro scale
vec3 detailGrad = vec3(
  fbm(vWorldNormal * 256.0)        - 0.5,
  0.0,
  fbm(vWorldNormal * 256.0 + 91.7) - 0.5
);

// Build a local tangent frame on the sphere
vec3 up = vec3(0.0, 1.0, 0.0);
vec3 tangent  = normalize(cross(up, vWorldNormal));
vec3 binormal = cross(vWorldNormal, tangent);

// Project gradients into world space via the tangent frame
vec3 macroPerturb = (dNdx.x * tangent + dNdy.z * binormal) * 4.0;
vec3 detailPerturb = (detailGrad.x * tangent + detailGrad.z * binormal) * 0.12;
vec3 perturbedNormal = normalize(vWorldNormal + macroPerturb + detailPerturb);

// USE perturbedNormal instead of vWorldNormal in the lighting equation below
```

**Cost:** +2 fbm calls, +1 normalize. ~0.2ms.

**Visual gain:** continents start looking like geography rather than painted decals. Mountains catch the sun on east-facing slopes and shadow their west-facing slopes. Rivers (post §3.4 triplanar) read as actual carved channels.

### 3.4 THE central bug: elevation-keyed albedo → contour rings. Re-key on biome.

**This is the headline finding of the dossier, not a polish item.** Reframed 2026-05-15 after the bullseye screenshot.

**The disease:** `base = sampleGradient(uSat*, h)` keys base albedo on `h = elevField/1.6` — i.e. **elevation is the primary colour axis**. On a sim-uplifted continent, elevation is radially monotone (high center → low coast), so a 1D LUT *must* produce closed colour contours. No amount of noise on `h` fixes this; it only makes the contours wavy. **This is architecturally wrong: in real satellite imagery, base colour is keyed on _biome_ (climate × moisture × vegetation), and elevation is only a weak secondary modifier (snow line, exposed rock, coastal darkening).** Production planet renderers never use an elevation LUT as the primary albedo key (open question for Gemini — see §8.6 — but the working assumption is firm).

**The fix (the real one):** decouple colour from elevation.
1. **Base albedo = biome field.** Drive it from the existing latitude-climate weights (`wTrop/wArid/wTemp/wPolar`) *plus* a low-frequency 2D/3D biome-noise field that varies *horizontally* (a Whittaker-style climate×moisture selection), **not** by `h`. Same-elevation cells in different biomes get different colour; same-biome cells at different elevations get *similar* colour. This alone kills the bullseye.
2. **Elevation demoted to modifiers only:** snow line (§4.2), exposed-rock mask gated by altitude (§3.2), coastal/beach darkening, and a *gentle* hypsometric tint (a few % darkening with height, not a full gradient sweep).
3. **Then** apply stochastic/bi-planar sampling (below) as a refinement to break residual repetition — but it is the *third* fix, not the first. Doing stochastic sampling on top of an elevation-keyed lookup just makes wavy rings; it does not fix the model.

**Decision needed (Gemini §8.6 + §8.7):** is the right end-state to keep 1D SatMaps but select the *row* by biome instead of elevation, or to replace SatMaps with a 2D climate×moisture (Whittaker) lookup texture? This dossier can spec either once the user/Gemini decides; the *principle* (colour ≠ f(elevation)) holds regardless.

**Secondary refinement — stochastic / bi-planar sampling.** Once colour is biome-keyed, repetition of the *same biome's* texture across a large region still benefits from triplanar/stochastic sampling. We adapt it for SatMaps (1D gradients, not 2D tileables) by perturbing the lookup with three world-space-aligned noise lookups, blended by normal-weighted weights.

```glsl
vec3 sampleSatTriplanar(sampler2D tex, vec3 worldPos, vec3 worldNormal, float h) {
  vec3 absN = abs(worldNormal);
  // Bi-planar optimization: only the two dominant axes get sampled
  vec3 w = pow(absN, vec3(4.0));
  w /= (w.x + w.y + w.z + 1e-4);

  float hx = h + (fbm(worldPos.yz * 8.0) - 0.5) * 0.06;
  float hy = h + (fbm(worldPos.xz * 8.0) - 0.5) * 0.06;
  float hz = h + (fbm(worldPos.xy * 8.0) - 0.5) * 0.06;

  vec3 cx = texture2D(tex, vec2(0.5, 1.0 - clamp(hx, 0.02, 0.98))).rgb;
  vec3 cy = texture2D(tex, vec2(0.5, 1.0 - clamp(hy, 0.02, 0.98))).rgb;
  vec3 cz = texture2D(tex, vec2(0.5, 1.0 - clamp(hz, 0.02, 0.98))).rgb;
  return cx * w.x + cy * w.y + cz * w.z;
}
```

Replace each `sampleGradient(uSatXyz, h)` call site with `sampleSatTriplanar(uSatXyz, vWorldPos, vWorldNormal, h)`.

**Cost:** +3 fbm calls per SatMap sample. With 4 climate SatMaps + 1 rock = 5 samples, this is +15 fbm calls per fragment. At ~0.05ms each = 0.75ms total. On low-end hardware this is noticeable; on a modern desktop it's free.

**Optimization:** drop to **bi-planar** (just the 2 dominant axes) — 33% cost reduction with negligible visual loss. Standard AAA practice.

**Visual gain:** banding disappears. Same-elevation regions now show variation. This is the single most "AAA-feeling" change in this dossier.

### 3.5 Two-layer cloud system (drop-shadow + edge volume)

**Why now:** the user's screenshots have no clouds — the planet looks fake because real Earth-from-orbit photos all have visible cloud cover. Adding even a cheap 2-layer cloud pass instantly grounds the rendering.

**Layer 1 — Drop shadow on terrain.**

In the planet fragment shader, sample a cloud-noise field offset by the sun direction:
```glsl
vec3 sunOffset = -L * 0.04;     // shadow falls opposite to light
vec3 cloudPos = vWorldNormal + sunOffset;
float cloudShadowNoise = fbm(cloudPos * 8.0);
cloudShadowNoise = smoothstep(0.45, 0.65, cloudShadowNoise);   // sharp threshold
albedo *= mix(1.0, 0.65, cloudShadowNoise * 0.7);    // 35% darkening max
```

This is *just* a darkening pass on the terrain — costs one fbm call.

**Layer 2 — Volumetric cloud sphere at radius 1.02.**

Build a second mesh (`THREE.SphereGeometry(1.02, 64, 64)`) and a fragment shader that:
- Samples ridged FBM at the surface normal for cloud density
- Lights it with simple beta-decay along sun direction (Beer-Lambert)
- Alpha-blends additively over the terrain

Skeleton:
```glsl
// Vertex passes vWorldNormal in [0,1] sphere space
// Fragment:
vec3 N = normalize(vWorldNormal);
float density = pow(fbm(N * 10.0), 1.5);
density = smoothstep(0.40, 0.75, density);    // mostly transparent, with billowing patches

float lighting = max(dot(N, L), 0.0) * 0.6 + 0.4;
float opacity = density * 0.85;

vec3 cloudColor = vec3(1.0) * lighting;
gl_FragColor = vec4(cloudColor, opacity);
```

Mounted in `apps/hayba-explorer/src/viewport/cloudsMesh.ts`. Materials: `transparent: true`, `depthWrite: false`, `side: THREE.FrontSide`, `blending: THREE.NormalBlending`.

**Cost:** one additional draw call, ~64K verts (negligible), one fbm per cloud-mesh fragment (cheap on coarse mesh).

**Visual gain:** transformative. The drop-shadow alone (Layer 1) is 80% of the perceptual win; the volumetric sphere is the "I'm looking at Earth" cue.

---

## C. Color pipeline (pre-flight — must verify before any shader colour work)

**Why this is §C and not buried in §4:** the muddy/crushed/desaturated look in every screenshot is the canonical signature of an sRGB↔linear mismatch. If the pipeline is wrong, **every colour value in §3.1–3.4 is being computed against a corrupted basis** and tuning them is wasted effort. This is ~1 hour to verify and gates everything.

**The three things to verify, in Three.js r0.169:**

1. **SatMap texture `.colorSpace`.** Our SatMaps are k-means-derived from real Blue Marble **sRGB PNGs**. They are *albedo* (colour) textures, so each loaded texture MUST be `tex.colorSpace = THREE.SRGBColorSpace`. If left at the default (`NoColorSpace`/linear) the GPU samples sRGB-encoded bytes as if linear → everything is too dark and desaturated in the midtones, exactly the symptom. Check `satmap-loader.ts` / wherever `THREE.TextureLoader` or `CanvasTexture` is created.
2. **`renderer.outputColorSpace`.** Must be `THREE.SRGBColorSpace` (the r0.152+ default, but verify it wasn't overridden). With a `ShaderMaterial` writing `gl_FragColor` directly, confirm the renderer still applies the output transform — for raw `ShaderMaterial` you often must do the linear→sRGB OETF yourself or set the material up so the renderer does. This is the most common subtle r0.169 bug.
3. **Tone-map order + whether to tone-map albedo at all (open question §8.8).** ACES is a *scene-referred HDR* operator. Our SatMaps are *display-referred photographs of Earth* — already tone-mapped by the camera/sensor that shot Blue Marble. Running them through ACES again desaturates and darkens by design. Options: (a) only ACES the *lit radiance* and keep sampled albedo out of the curve; (b) drop ACES entirely for this content and rely on correct sRGB output; (c) keep ACES but pre-brighten albedo to compensate (worst — fights the curve). Production answer unknown → Gemini §8.8.

**Verification recipe:** render a single SatMap full-screen with lighting disabled (`lit = albedo`). It should look like the source PNG opened in an image viewer. If it's darker/muddier than the PNG, the pipeline is wrong and is the dominant problem — fix it before touching §3.x palettes.

**Why I (the dossier author) under-weighted this in v1:** the 2026-05-13 brief flagged "renderer almost certainly draws linear-as-sRGB" but I did not carry it forward, then spent §3.1 specifying exact RGB triples — which are meaningless if the basis is wrong. This is the single biggest correction to v1.

---

## 4. Multi-phase upgrade roadmap

### Phase 1 — Bug fixes + immediate wins (1 day)

Targets the user's reported visual bugs. Ships a recognizably better planet.

| Task | Cost | Section |
|---|---|---|
| Ocean palette + fresnel + glint | 1h | §3.1 |
| Elevation-gate the rock mask | 30m | §3.2 |
| Drop-shadow cloud pass | 30m | §3.5 (Layer 1 only) |
| Tighten halo + atmosphere blend (lower opacity) | 15m | §4.5 |
| Decouple `vElevation` from `tempLand` calc; use a smoothed input | 15m | bug E |

### Phase 2 — Macro relief (2 days)

The single biggest perceptual upgrade.

| Task | Cost | Section |
|---|---|---|
| Macro-normal from elevation derivatives | 1h | §3.3 |
| Detail noise normal perturbation (~256 freq) | 1h | §3.3 |
| Triplanar SatMap sampling (bi-planar variant) | 2h | §3.4 |
| Per-biome rock SatMap variants (3-4 instead of 1) | 1h | §4.6 |
| Volumetric cloud sphere | 3h | §3.5 (Layer 2) |

### Phase 3 — Climatology (3 days)

The "scientifically grounded variation" layer Gemini called out.

| Task | Cost | Section |
|---|---|---|
| Wind-field + rain-shadow proxy | 2h | §4.1 |
| Continentality via mipmap-blur of ocean mask | 3h | §4.3 |
| Holdridge PET vegetation density modulator | 2h | §4.4 |
| Ocean current gyre advection | 2h | §4.1 (continued) |
| Soil pedogenesis blend below vegetation | 1h | §4.6 |

### Phase 4 — Atmospheric scattering (1 week)

Replace the analytic halo with a proper Bruneton-style precomputed LUT.

| Task | Cost | Section |
|---|---|---|
| Vendor `@takram/three-atmosphere` or port `precomputed_atmospheric_scattering` | 1d | §4.5 |
| Wire transmittance + in-scatter sampling into shader | 1d | §4.5 |
| Day-night terminator + twilight ring | 1d | §4.5 |
| Aerial perspective for in-engine fly-down (if hayba goes there) | 2d | §4.5 |

### Phase 5 — Tessendorf-style ocean micro-detail (1 week, only if zoom)

Only relevant if Hayba zooms in beyond orbital view. Otherwise skip.

| Task | Cost | Section |
|---|---|---|
| FFT-based wave displacement | 3d | §4.8 |
| Foam + wake | 1d | §4.8 |
| Sea-of-thieves-style transition between BRDF (far) and FFT (close) | 1d | §4.8 |

---

## 5. Deep dives on individual techniques

### 4.1 Hadley/Ferrel wind cells + rain shadow + ocean gyres

These three are tightly coupled — they all need a synthetic global flow field as input.

**Synthetic wind direction:**
```glsl
vec3 prevailingWind(vec3 n) {
  float lat = asin(n.y);
  // Easterlies (trades) at low lat, westerlies mid-lat, easterlies polar
  float windZ = cos(lat * 3.0);
  float windX = -sign(lat) * sin(lat * 3.0);
  vec3 raw = normalize(vec3(windX, 0.0, windZ));
  // Project into the tangent plane at this point on the sphere
  vec3 t = normalize(cross(vec3(0,1,0), n));
  vec3 b = cross(n, t);
  return normalize(t * raw.x + b * raw.z);
}
```

**Rain shadow from wind + slope:**
```glsl
vec3 wind = prevailingWind(N);
float windFacing = dot(N, wind);   // -1..+1
float orographicLift = smoothstep(0.0, 0.8, windFacing) * vSlope;
float rainShadow    = smoothstep(0.0, -0.8, windFacing) * vSlope;
float elevFactor    = smoothstep(0.1, 1.5, vElevation);
float precipMod     = 1.0 + (orographicLift - rainShadow) * elevFactor;
```

Multiply the existing `wTemp`/`wTrop` climate weights by `precipMod` to shift biome toward wet/dry on the relevant slopes.

**Ocean gyres for east-west temperature variation:**
```glsl
float lat = asin(N.y);
float lon = atan(N.z, N.x);
float gyreLat = sign(lat) * 0.52;   // ~30° in radians
float basinLon = floor(lon / 2.09) * 2.09 + 1.04;   // 3 basins, 120° each
vec2 pos = vec2(lon - basinLon, lat - gyreLat);
vec2 flow = normalize(vec2(-pos.y, pos.x)) * sign(lat);
float heatTransport = -flow.y * sign(lat);    // pole-ward warm, equator-ward cold
float coastalInfluence = smoothstep(0.0, 0.3, 1.0 - continentality);
float tempDelta = heatTransport * coastalInfluence * 8.0;   // ±8°C
```

Adds to `tempLand` before the snow mask.

**Why this matters:** identical-latitude continents currently look identical. After this: one coast is desert (rain shadow + cold current), the other is rainforest (windward + warm current). Exactly like Earth's Atacama vs Amazon.

### 4.2 Physically-based snow line (slope + aspect + aridity)

Beyond just temperature:
```glsl
// Snow accumulation needs three things: cold, gentle slope, sufficient precipitation
float slopeAngle = vSlope;   // already 0..~1 in our sim
float snowAdhesion = 1.0 - smoothstep(0.6, 0.9, slopeAngle);

// Equator-facing slopes melt faster
float aspectMelt = max(0.0, -sign(lat) * N.y);
float dynSnowTemp = tempLand + aspectMelt * 5.0;

// Need actual moisture to fall as snow
float aridityFactor = smoothstep(0.0, 0.2, precipMod);

float snowMask = (1.0 - smoothstep(-5.0, 0.0, dynSnowTemp));
snowMask *= snowAdhesion * aridityFactor;
```

Drop-in replacement for the current snow block.

### 4.3 Continentality via mipmap-blur ocean mask

Real moderation effect of oceans — landmasses near coasts have less temperature swing.

**Setup (one-time):** pre-compute a 512×256 equirectangular land/ocean mask from the partition. Render once, with `THREE.LinearMipMapLinearFilter`, then sample a HIGH mip level (6 = ~8×4 effective res) to get a blurred coastal gradient.

**In shader:**
```glsl
uniform sampler2D uOceanMask;

vec2 sphericalUV(vec3 n) {
  float lon = atan(n.z, n.x);
  float lat = asin(n.y);
  return vec2(lon / (2.0 * 3.14159) + 0.5, 0.5 - lat / 3.14159);
}

float continentality = textureLod(uOceanMask, sphericalUV(N), 6.0).r;
// continentality = 1.0 deep inland, 0.5 coast, 0.0 deep ocean

float tempContinentalSwing = (continentality - 0.5) * 15.0;
float precipDamping = smoothstep(0.4, 1.0, continentality);
finalTemp += tempContinentalSwing;
finalPrecip *= (1.0 - precipDamping * 0.6);
```

Implementation note: the ocean mask needs to be rendered every time the user re-bakes. Add a `bakeOceanMask` step right after `bake_from_wizard` succeeds — render the snapshot's per-cell continental mask to a 512×256 framebuffer, then re-bind as a texture.

### 4.4 Holdridge PET vegetation density

Empirically grounded vegetation classifier. Replaces the binary "wet = green, dry = brown" with the actual ratio of evapotranspiration to precipitation.

```glsl
float bioTemp = clamp(finalTemp, 0.0, 30.0);
float pet = bioTemp * 5.893;    // Holdridge empirical
float petRatio = pet / (finalPrecip + 0.001);

// Lower PET ratio = more moisture available = denser vegetation
float vegDensity = 1.0 - smoothstep(0.5, 3.0, petRatio);

// Tree line — vegetation can't survive at extreme elevation
float treeLine = 1.0 - smoothstep(1.2, 1.6, vElevation);
vegDensity *= treeLine;
```

Use `vegDensity` as the mix factor between bare soil (calculated procedurally — see §4.6) and the SatMap albedo. Result: dense forest in tropical/temperate wet zones, transitional savannah, then desert as ratio rises.

### 4.5 Atmospheric scattering (current → Bruneton)

**Current:** analytic halo via `pow(1.0 - viewAngle, 4.0)` * `vec3(0.40, 0.62, 1.00)`. Cheap but produces a "soap bubble" rather than real atmosphere.

**Short-term fix (Phase 1):** tone down the existing approximation
```glsl
lit = mix(lit, atmosphere, halo * 0.10);   // was 0.18
lit += atmosphere * halo * 0.12 * lambert; // was 0.20
```
The halo was too strong; it washes out the planet's actual colors.

**Phase 4 — Bruneton port:** vendor `@takram/three-atmosphere` (Bruneton 2008 implementation, BSD). Provides a 4D transmittance + irradiance LUT computed at load (~2s on a desktop GPU). Sample with:
```glsl
vec3 transmittance = texture3D(uTransmittance, vec3(altitude, viewDir, sunCos)).rgb;
vec3 scattered    = texture3D(uInScatter,    vec3(altitude, viewDir, sunCos)).rgb;
finalColor = surfaceColor * transmittance + scattered;
```

This gives day-night terminator, twilight ring, correct sun-blue-sky relationship for free.

### 4.6 Soil pedogenesis as procedural base layer

Below the vegetation, the *soil itself* should be colored by climate.

```glsl
vec3 soilColor(float temp, float precip) {
  vec3 laterite   = vec3(0.60, 0.30, 0.20);   // tropical iron-rich red
  vec3 calcisol   = vec3(0.80, 0.70, 0.50);   // arid pale sand
  vec3 chernozem  = vec3(0.20, 0.15, 0.10);   // temperate dark organic
  vec3 podzol     = vec3(0.40, 0.40, 0.45);   // polar grey ash

  float wTrop  = smoothstep(20.0, 30.0, temp) * smoothstep(0.5, 2.0, precip);
  float wDes   = smoothstep(20.0, 35.0, temp) * (1.0 - smoothstep(0.1, 0.5, precip));
  float wTemp  = smoothstep(5.0, 20.0, temp);
  float wPolar = 1.0 - smoothstep(-10.0, 5.0, temp);
  float wSum   = wTrop + wDes + wTemp + wPolar + 1e-3;

  return (wTrop * laterite + wDes * calcisol + wTemp * chernozem + wPolar * podzol) / wSum;
}

vec3 finalGround = mix(soilColor(finalTemp, finalPrecip), albedo, vegDensity);
```

### 4.7 FBM stochastic offsets to break banding

Replace lacunarity 2.0 with 2.1, persistence 0.48 with 0.5, and add a per-octave seed rotation:

```glsl
float fbm(vec3 p) {
  float v = 0.0, a = 0.5;
  for (int i = 0; i < 5; i++) {
    // Per-octave coordinate rotation to break grid-aligned artifacts
    p = mat3(0.8, -0.6, 0.0, 0.6, 0.8, 0.0, 0.0, 0.0, 1.0) * p + vec3(17.3, 91.7, 53.1);
    v += vnoise(p) * a;
    p *= 2.1;
    a *= 0.5;
  }
  return v;
}
```

The rotation breaks the visible "axis-aligned" pattern that 3D fbm at integer frequencies tends to produce on a sphere.

### 4.8 Tessendorf ocean (Phase 5, conditional)

Only if Hayba ever supports orbital-to-surface zoom. For pure orbital view, the BRDF approach in §3.1 is plenty. If implementing:

1. Pre-compute 2D Phillips spectrum at 256×256 (constant tone)
2. Each frame, run IFFT in a compute shader (~0.3ms on a desktop GPU)
3. Displace the ocean mesh by the resulting heightmap
4. Sample foam from the height-curvature term
5. Transition smoothly to flat BRDF water beyond some distance threshold

Reference implementations: Acerola's WebGL demo, Sea of Thieves dev blog.

---

## 6. Performance budget

Current shader takes ~0.8ms per frame at 1920×1080 on a desktop GPU (rough estimate from FBM call count). Budget summary for the proposed upgrades:

| Phase | Δ time / frame | Cumulative |
|---|---|---|
| Phase 1 (bug fixes) | +0.15ms | 0.95ms |
| Phase 2 (macro relief) | +0.8ms | 1.75ms |
| Phase 3 (climatology) | +0.4ms | 2.15ms |
| Phase 4 (atmospheric LUT) | +0.05ms (LUT is cheap to sample) | 2.20ms |
| Phase 5 (Tessendorf — conditional) | +1.5ms | 3.70ms |

Budget headroom: even at 4ms/frame for the planet shader, we're at <25% of a 16.6ms frame budget. Plenty of room for the cloud shader, UI overlay, and the boundary picker overhead.

---

## 7. Reading order for the implementer

If executing this in order:

1. **Read this dossier section 0–3.** Understand the bug postmortem and the five highest-leverage changes.
2. **Read `apps/hayba-explorer/src/viewport/shaders/planet.glsl.ts` carefully.** Understand the current FBM, climate blend, ocean composite, and lighting blocks.
3. **Implement Phase 1 (§3.1–3.2 + §4.5 short-term).** Ship. Screenshot. Compare to before.
4. **Read Quilez's articles on triplanar mapping + stochastic texturing** before starting §3.4.
5. **Implement Phase 2.** Screenshot. Compare. This is where the planet should start feeling AAA.
6. **Read Bruneton 2008** *before* Phase 4. Don't try to derive precomputed scattering from scratch.
7. **Implement Phase 3.** Screenshot. The east-west asymmetry should now be obvious.
8. **Implement Phase 4** if Phase 3 has shipped and Hayba still needs more polish.

Do not skip phases or do them out of order. Phase 2 (macro normal) is the foundation Phase 3 visuals depend on — sky-without-relief looks no different than no-sky.

---

## 8. Open questions for the user

These deserve explicit decisions before implementation:

1. **Realism vs. stylization.** Hayba's overall design language is dark/elegant with a beige+accent palette. Real Earth from orbit is mostly blue/brown/white. Confirm we're targeting photorealism, not a "stylized blue-and-amber Pluto-like aesthetic". This dossier assumes photorealism.

2. **Time-of-day / sun motion.** Currently the sun is a fixed `uSunDir = (0.6, 0.5, 0.8)`. Do we want it to rotate as the sim runs? Day-night terminator becomes much more meaningful once §4.5 lands.

3. **Cloud authoring.** Procedural clouds are easy. If the user wants *specific* cloud patterns (cyclones, weather fronts), we need a 2D cloud authoring step — outside this dossier's scope.

4. **Performance target.** 60fps at 1080p on a mid-range GPU, or 30fps at 1440p on a desktop? Affects whether Phase 5 (Tessendorf) is on the table.

5. **Phase 4 atmospheric scattering — port or vendor?** Porting `precomputed_atmospheric_scattering` is ~3 days. Vendoring `@takram/three-atmosphere` is one afternoon but adds an MIT-licensed dependency. Strong recommendation: vendor.

6. **(Gemini) Is an elevation LUT ever used as the primary albedo key in production planet renderers?** Strong prior: no — colour is always biome/splat-keyed, elevation is a modifier. Needs confirmation with production references so we commit to the §3.4 re-architecture without second-guessing.

7. **(Gemini + user) 1D-row-by-biome vs. 2D Whittaker lookup.** Keep 1D SatMaps but select the row by biome (cheap migration, preserves the authored palettes), or replace with a 2D climate×moisture lookup texture (more correct, more authoring work)? Architecture decision; dossier can spec either once chosen.

8. **(Gemini) Tone-map satellite-derived albedo at all?** ACES is scene-referred HDR; our SatMaps are display-referred photos. Need production guidance: ACES the lit radiance only / drop ACES for baked-satellite content / something else. See §C.3.

9. **(Gemini, cheap to verify, highest priority) Correct Three.js r0.169 colour pipeline for raw `ShaderMaterial` + sRGB albedo textures.** Exact `.colorSpace`, `outputColorSpace`, and where the OETF is applied when the material writes `gl_FragColor` directly. If wrong, invalidates all colour work. See §C.

---

## 9. References

- **Gemini research dump (2026-05-15)** — captured in prior session transcript; supersedes its specific code suggestions where they conflict with this doc.
- **`docs/research/2026-05-13-realistic-planet-rendering.md`** — earlier brief from the same project; this dossier supersedes for visual-bug analysis.
- **Quilez 2002–present** — https://iquilezles.org/articles/ (triplanar, domain warping, stochastic, FBM, intersection)
- **Sean Tracy (CIG) GDC 2018** — "Planet Tech in Star Citizen" — biome rulesets, multi-material shader stacks
- **Sebastien Hillaire (Frostbite) 2020** — "A Scalable and Production-Ready Sky and Atmosphere Rendering Technique"
- **Eric Bruneton 2008** — "Precomputed Atmospheric Scattering" + reference implementation
- **Tessendorf 2001** — "Simulating Ocean Water" (the FFT wave paper)
- **Sean Murray (Hello Games) GDC 2017** — "Building Worlds in No Man's Sky"
- **Schneider & Vos (Guerrilla) SIGGRAPH 2015** — Horizon Zero Dawn volumetric clouds
- **Acerola YouTube 2023** — modern ocean rendering compilation
- **Outerra Engine devblog** — heightmap planet detail synthesis
- **Narkowicz 2015** — ACES filmic tone mapping curve approximation
- **Holdridge 1947 / 1967** — life zone classification (used in §4.4)
- **Köppen-Geiger 1936 → Beck et al. 2018** — climate classification, used to set §4 latitude thresholds
- **Bruneton 2010** — Real-time realistic ocean lighting (geometry-to-BRDF transition)
- **Heitz & Neyret 2018** — by-example procedural tiling (relevant for §3.4 stochastic SatMap sampling)

---

## 10. What this dossier deliberately does NOT cover

- **Geometric LOD / quad-sphere displacement** for surface-level zoom. Hayba is an orbital viewer; this is out of scope unless that changes.
- **Vegetation instancing / GPU-driven flora**. Out of scope for v1 — vegetation here is purely a color/density modulator on the planet shader.
- **Sub-surface ice on polar caps**. Phase 5 territory; not addressed.
- **Auroras**. Beautiful, mostly cosmetic, ~1 week to implement well. Tracked but not scoped.
- **Specific UE5 plugin port**. Hayba MCP toolkit ports the data contract; the shader port is its own project.
