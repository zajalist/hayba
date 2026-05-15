# Gemini Research Prompt — Hayba Planet Renderer

> Copy everything below the line into Gemini (Deep Research mode). It is fully self-contained — Gemini has no access to our codebase, so the current shader and all symptoms are included inline.

---

## ROLE

You are a senior real-time rendering engineer with shipped experience on procedural-planet renderers (think Star Citizen Planet Tech, Outerra, No Man's Sky, Elite Dangerous). I need a rigorous, citation-backed research report that diagnoses why our planet shader looks wrong and prescribes the production-correct architecture. Challenge my hypotheses — do not just agree. Where production studios disagree on an approach, say so and explain the tradeoff. Prefer primary sources (GDC/SIGGRAPH talks, dev blogs, papers) over tutorials.

## THE SYSTEM

**Hayba Explorer** is a desktop app (Tauri + React + Three.js **r0.169**, WebGL2 / GLSL ES 3.0) that visualizes a tectonic-plate simulation as an Earth-like planet viewed **from orbit** (no surface-level zoom; the planet is always a sphere on screen filling roughly half the viewport).

**Geometry:** a single triangulated icosphere, 10k–370k cells depending on user-chosen resolution (typically 10k–40k). One `THREE.Mesh` with a custom `ShaderMaterial`. Per-vertex attributes come from the Rust simulation snapshot: `elevation` (normalized, roughly −1 ocean floor … +1 mountain peak, but in practice post-sim continents are mostly 0.0–0.9), `slope`, `plateId`, `continental` (0/1), `isBoundary`, `collisionKind`, `subductionProgress`, `orogenicUplift`, `volcanicIntensity`, `crustAge`. No UVs — the only natural surface parameterization is the unit-sphere position / normal.

**"SatMaps":** our authored color source. Each SatMap is a **256×1024 vertical 1-D gradient PNG** (we treat it as a lookup keyed by a single scalar — currently elevation). We have 25 of them, k-means-derived from real NASA Blue Marble imagery paired with ETOPO1 DEM, grouped by Köppen climate class (tropical/arid/temperate/polar) and a geology axis. The shader currently blends 4 climate SatMaps by latitude, plus a 5th "rock" SatMap by slope. These PNGs are sRGB photographs of real Earth terrain.

**Constraints:**
- Single-pass fragment shader preferred (we have a second pass available for clouds/atmosphere if justified). No compute shaders (WebGL2).
- Must stay **authorable**: artists swap SatMaps; the look must derive from them, not be hardcoded.
- Output must be portable: the same per-cell data contract feeds a future Unreal Engine 5 plugin, so prefer techniques expressible as "function of per-cell scalars + position", not engine-specific.
- Performance budget: ≤ ~4 ms/frame for the planet on a mid-range desktop GPU at 1080p.
- The planet must read as **photoreal Earth-from-orbit** (NASA Blue Marble / Suomi-NPP aesthetic), not stylized.

## THE CURRENT FRAGMENT SHADER (ground truth — reason against this exact code)

```glsl
// ---- noise ----
float hash3(vec3 p){ p=fract(p*vec3(443.8975,397.2973,491.1871)); p+=dot(p,p.yzx+19.19); return fract((p.x+p.y)*p.z); }
float vnoise(vec3 p){ /* trilinear value noise of hash3, standard */ }
float fbm(vec3 p){ float v=0.,a=.5; for(int i=0;i<5;i++){ v+=vnoise(p)*a; p*=2.0; a*=0.48; } return v; }   // 5 oct, lac 2, pers .48

// sample a SatMap as a 1-D gradient by scalar h in [0,1]; uv.x pinned to 0.5
vec3 sampleGradient(sampler2D tex, float h){ return texture2D(tex, vec2(0.5, 1.0 - clamp(h,0.02,0.98))).rgb; }

void main(){
  float fbmCoarse = fbm(vWorldNormal*6.0);
  float fbmFine   = fbm(vWorldNormal*28.0);
  float fbmHigh   = fbm(vWorldNormal*90.0);

  // elevation field used for BOTH displacement-look and color
  float elevField = vElevation + (fbmCoarse-0.5)*0.55 + (fbmFine-0.5)*0.15;
  float h = elevField / 1.6;                                  // <-- color is keyed on elevation

  // climate weights by |latitude| (Köppen-ish breakpoints on |sin lat|)
  float latRaw   = abs(vWorldNormal.y);
  float latNoisy = clamp(latRaw + (fbmCoarse-0.5)*0.10, 0.0, 1.0);
  float wTrop  = 1.0 - smoothstep(0.32,0.45,latNoisy);
  float wArid  = smoothstep(0.36,0.45,latNoisy) - smoothstep(0.52,0.62,latNoisy);
  float wTemp  = smoothstep(0.52,0.62,latNoisy) - smoothstep(0.82,0.90,latNoisy);
  float wPolar = smoothstep(0.82,0.92,latNoisy);
  // (weights normalized to sum 1)

  vec3 climateBase = sampleGradient(uSatTropical,h)*wTrop
                   + sampleGradient(uSatArid,    h)*wArid
                   + sampleGradient(uSatTemperate,h)*wTemp
                   + sampleGradient(uSatPolar,   h)*wPolar;
  vec3 base = mix(sampleGradient(uSatMap,h), climateBase, uClimateBlend);
  vec3 rock = sampleGradient(uSatMapRock, h*1.1);

  // slope rock mask (fwidth AA)
  float slopeWithNoise = vSlope + (fbmHigh-0.5)*0.18;
  float sw = max(fwidth(slopeWithNoise),0.001);
  float rockMask = smoothstep(0.55-sw, 0.70+sw, slopeWithNoise);
  vec3 albedo = mix(base, rock, rockMask);

  // beach band
  float beachH = 1.0 - smoothstep(0.0,0.04, elevField+(fbmFine-0.5)*0.01);
  float flatness = 1.0 - smoothstep(0.0,0.12, vSlope);
  albedo = mix(albedo, vec3(0.88,0.82,0.62), clamp(beachH*flatness*step(0.0,vElevation),0.,1.)*0.7);

  // ocean (Beer-Lambert-ish)
  float coastNoise = (fbm(vWorldNormal*55.0)-0.5)*0.12;        // ±0.06
  float seaCoord   = vElevation + coastNoise;
  float oceanMask  = 1.0 - smoothstep(-0.02, 0.05, seaCoord);  // 0.07-wide transition
  if(oceanMask>0.001){
    vec3 coast=vec3(0.55,0.82,0.88), shelf=vec3(0.18,0.50,0.74), abyss=vec3(0.02,0.08,0.22);
    float d=max(-seaCoord,0.0);
    float t1=smoothstep(0.00,0.08,d), t2=smoothstep(0.10,0.45,d);
    vec3 water=mix(mix(coast,shelf,t1),abyss,t2);
    float ripple=((fbm(vWorldNormal*90.0)-0.5)+(fbm(vWorldNormal*35.0)-0.5)*0.5)*0.06;
    water*=(1.0+ripple);
    albedo=mix(albedo,water,oceanMask);
  }

  // snow line (temperature proxy)
  float tempLand = 30.0 - max(vElevation,0.0)*6.0 - latNoisy*32.0 + (fbmFine-0.5)*2.5;
  float snowMask = (1.0 - smoothstep(-6.0,-1.0,tempLand)) * (1.0-oceanMask);
  snowMask = min(snowMask, 0.85);
  albedo = mix(albedo, vec3(0.94,0.94,0.95), snowMask);

  // lighting: Lambert + rim + analytic atmosphere halo
  vec3 N=normalize(vWorldNormal), L=normalize(uSunDir), V=normalize(cameraPosition-vWorldPos);
  float lambert=max(dot(N,L),0.0), viewAngle=max(dot(N,V),0.0), halo=pow(1.0-viewAngle,4.0);
  vec3 atmosphere=vec3(0.40,0.62,1.00);
  vec3 lit = albedo*(uAmbient+(1.0-uAmbient)*lambert);
  lit = mix(lit, atmosphere, halo*0.18);
  lit += atmosphere*halo*0.20*lambert;
  lit += uRimColor*pow(1.0-viewAngle,2.0)*0.15;

  // cavity AO from elevation derivatives
  float cavity=length(vec2(dFdx(vElevation),dFdy(vElevation)));
  lit *= mix(0.78,1.0, 1.0-smoothstep(0.0,0.4,cavity));

  gl_FragColor = vec4(aces(lit*1.05), 1.0);   // Narkowicz ACES approximation
}
```

`cameraPosition` is Three.js's built-in. `vWorldNormal = normalize(position)` (the bare sphere normal — no relief). The renderer uses a raw `ShaderMaterial` (we write `gl_FragColor` directly).

## OBSERVED FAILURES (from real screenshots, described precisely)

1. **Continents render as concentric color contour rings ("bullseye").** Each landmass: near-black center → olive/yellow ring → bright white halo ring → grey ring → orange ring → blue coast. It looks like a topographic contour map / oil slick, not terrain. Our diagnosis: because `h` (color key) = elevation, and sim-uplift makes elevation radially monotone per continent (high center, low coast), the 1-D LUT paints closed iso-elevation color loops. The FBM offset on `h` only makes the rings wavy.

2. **Land reads near-black / "green too dark."** The dark continent centers are muddy and crushed.

3. **Noisy near-white-cyan speckled fringe at every coastline.** A dithered band of bright pixels exactly where land meets sea. Our diagnosis: `coastNoise` amplitude (±0.06) ≈ `oceanMask` smoothstep window (0.07), so the mask dithers 0↔1 per-cell instead of producing an organic edge; and at the edge the color is pinned to the very bright `coast` constant.

4. **Any modest ocean depth renders bright cyan.** Shallow water is swimming-pool turquoise, not believable ocean. Our diagnosis: `coast = (0.55,0.82,0.88)` is a reef-closeup color, and `t1` completes the coast→shelf blend by depth 0.08, so most of the ocean's surface area is the bright stop.

5. **General muddiness / desaturation across the whole image.** Plasticky, low-contrast. Our suspicion: an sRGB↔linear color-management fault in the Three.js r0.169 pipeline (SatMap textures are sRGB PNGs; the `ShaderMaterial` writes `gl_FragColor` directly; ACES is applied to already-display-referred satellite albedo).

6. **No relief.** Continents are flat decals — no sense of mountains catching light.

## OUR HYPOTHESES (challenge or confirm each with sources)

- **H1 (highest confidence):** Keying base albedo on elevation via a 1-D LUT is architecturally wrong. Production renderers key base color on **biome (climate × moisture × vegetation)** and use elevation only as a weak secondary modifier (snow line, exposed rock, coastal darkening). The fix is to re-key color on a horizontally-varying biome field, not `h`.
- **H2:** The muddiness is substantially a color-management bug (sRGB textures sampled as linear, and/or ACES applied to display-referred albedo, and/or missing linear→sRGB OETF for a raw `ShaderMaterial` in Three.js r0.169). This may be upstream of all color tuning.
- **H3:** ACES filmic tone mapping is the wrong operator for baked-satellite albedo (it's a scene-referred HDR curve; our content is already display-referred).
- **H4:** The "no relief" problem should be solved with a screen-space/derivative macro-normal + detail-noise normal, NOT geometric displacement (Everest is 0.14% of Earth radius — geometric relief is invisible from orbit; the apparent ruggedness of Blue Marble is almost entirely normal-driven).
- **H5:** Coastline fringe is a generic "noise amplitude must be ≪ smoothstep window" failure, recurring wherever we perturb a mask with FBM (also affects the snow line).

## RESEARCH QUESTIONS (prioritized — answer in this order)

### Tier 1 — blocking; we cannot proceed correctly without these

1. **Color pipeline (verify H2/H3).** For **Three.js r0.169** specifically, with a **raw `ShaderMaterial` writing `gl_FragColor` directly** and **sRGB albedo PNG textures**: what is the exact correct setup? Cover: per-texture `.colorSpace`, `renderer.outputColorSpace`, whether the renderer applies the output OETF for raw ShaderMaterial or whether we must encode linear→sRGB ourselves, and where tone mapping sits relative to that. Give the canonical correct code. Then: **should display-referred satellite-photo albedo be run through ACES at all?** What do production planet renderers do with baked-satellite color vs. computed radiance — tone-map only the lit result, skip filmic entirely, or something else? Cite the Three.js color-management migration docs and any production guidance.

2. **Albedo keying architecture (verify/refute H1).** In shipped procedural-planet renderers (Star Citizen Planet Tech v3/v4, Outerra, No Man's Sky, Elite Dangerous, Spore, Kerbal/KSP2, Google Earth), **what scalar(s) key the base surface albedo?** Is an elevation→color LUT ever the primary key, or is it always biome / climate / splat / material-ID with elevation as a modifier? Give the actual model each uses. Then prescribe the correct model for our constraints (1-D authored SatMaps, per-cell climate/moisture-proxy scalars, no UVs, orbital-only). Specifically advise on **§8.7**: keep our 1-D SatMaps but select the lookup row by a *biome* scalar instead of elevation, vs. replace them with a 2-D climate×moisture (Whittaker-diagram) lookup texture. Give the tradeoff and a recommendation.

3. **Biome field synthesis without a climate sim.** Given only per-cell `latitude`, `elevation`, `slope`, `continental`, and cheap in-shader FBM, what is the production-standard way to synthesize a believable, horizontally-varying biome/moisture field (so same-elevation cells in different regions differ, and Earth-like macro-patterns emerge)? Cover the moisture/temperature → biome selection used by No Man's Sky and Star Citizen, the Whittaker biome model, and how to get continental-scale variation (deserts, forests, steppe) from noise without latitudinal banding. Include the role of a domain-warped low-frequency noise field as the moisture proxy.

### Tier 2 — needed for the "looks like Earth" jump

4. **Macro relief from normals (verify H4).** Best practice for deriving a surface normal that conveys mountain relief on a smooth orbital sphere from a per-vertex elevation scalar with no UVs: derivative-based (`dFdx/dFdy`) macro-normal + procedural detail-normal, blended how? How do Outerra / Star Citizen fake orbital relief? Pitfalls of derivative normals on a tessellated icosphere (faceting, AA). Give the prescribed construction.

5. **Ocean from orbit.** Production-correct Earth-from-orbit ocean (NOT close-up water): exact reference albedo values (deep / shelf / clear-tropical-shallow / turbid-shallow) in linear and sRGB; correct depth-extinction curve shape (Beer-Lambert parameters that make abyss dominate and shallow be a *muted dark blue*, not cyan); Schlick fresnel + sky reflection + sun-glint specular at orbital scale; sub-surface scatter as a *separate additive shallow-water term* rather than the base color. Cite Blue Marble color science / Bruneton 2010 ocean.

6. **Coastline & mask-edge organics (verify H5).** The general rule for FBM-perturbing a smoothstep mask so it produces organic fingers, not dither (amplitude vs. window relationship). Plus: production techniques for organic coastlines on a low-res icosphere where the underlying cell grid is ~2° (domain warping, multi-octave edge noise, signed-distance coast band). How to break the hex silhouette.

### Tier 3 — climatology realism (we have a prior research dump on this; only add what's new or corrects it)

7. **East-west asymmetry without a GCM:** the cheapest production-credible proxies for prevailing-wind rain shadow, continentality (ocean-proximity thermal buffering) **without a render-to-texture pass or GPU readback** (is there an analytic or Rust-precomputed per-cell `coastDistance` approach that beats the mipmap-blur trick?), and ocean-gyre thermal advection. Confirm or correct the standard Hadley/Ferrel-cell synthetic wind-vector approach.

8. **Snow line realism:** physically-grounded snow mask combining temperature lapse, slope (snow won't hold on cliffs), aspect (equator-facing melts faster), and minimum precipitation — the production formula.

9. **Clouds that read as weather, not noise:** how Star Citizen / Elite / Outerra get structured cloud systems (cyclones, fronts, banding) without a fluid sim — weather-map textures, curl-noise advection, baked cyclone stamps? Cheapest path to a 2-layer (terrain drop-shadow + volumetric shell) system that looks like Earth.

### Tier 4 — atmosphere (longer horizon)

10. For an **orbital** Three.js viewport: Bruneton 2008 precomputed scattering vs. Hillaire 2020 single-pass vs. vendoring `@takram/three-atmosphere`. Compare LUT memory, load time, terminator/twilight quality at planet scale, and integration cost with a raw ShaderMaterial. Recommend one.

## DELIVERABLE FORMAT

For each Tier-1 and Tier-2 question: (a) the production-correct answer with primary-source citations, (b) explicit verdict on our hypothesis (confirmed / refuted / partially), (c) concrete prescription expressed as GLSL-pseudocode or a precise algorithm against the data contract above, (d) cost estimate. For Tiers 3–4: shorter — answer + citation + one-paragraph prescription. End with a single prioritized punch-list of changes in dependency order. Flag anywhere production studios disagree and why. Be willing to tell me the whole SatMap concept is wrong if it is.
