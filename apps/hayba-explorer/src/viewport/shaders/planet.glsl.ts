export const VERTEX_SHADER = /* glsl */ `
  // ALL 20 per-cell scalars PACKED into 5 vec4 attributes. Three.js
  // ShaderMaterial auto-injects position/normal/uv builtins, so 20 raw
  // float attributes overflowed MAX_VERTEX_ATTRIBS (16). 5 vec4 + ~3
  // builtins ≈ 8 slots — well under the cap.
  //   aPack0 = (elevation, slope, plateId, continental)
  //   aPack1 = (isBoundary, collisionKind, subductionProgress, orogenicUplift)
  //   aPack2 = (volcanicIntensity, morAgeSteps, crustAge, biome)
  //   aPack3 = (temperature, precip, insolation, baseTemp)
  //   aPack4 = (distToOcean, currentDt, orographic, continentalDry)
  attribute vec4 aPack0;
  attribute vec4 aPack1;
  attribute vec4 aPack2;
  attribute vec4 aPack3;
  attribute vec4 aPack4;
  attribute vec4 aPack5;
  // Cell-stable texture seed (flaw A3): index-derived pseudo-random unit
  // vector, rides with the drifting crust (does NOT change as the cell
  // moves through world space).
  attribute vec3 aSeed;

  uniform float uExaggeration;

  varying float vElevation;
  varying float vSlope;
  varying float vPlateId;
  varying float vContinental;
  varying float vIsBoundary;
  varying float vCollisionKind;
  varying float vSubductionProgress;
  varying float vOrogenicUplift;
  varying float vVolcanicIntensity;
  varying float vMorAgeSteps;
  varying float vCrustAge;
  varying float vBiome;
  varying float vBiome2;
  varying float vBiomeBlend;
  varying float vTemperature;
  varying float vPrecip;
  varying float vInsolation;
  varying float vBaseTemp;
  varying float vDistToOcean;
  varying float vCurrentDt;
  varying float vOrographic;
  varying float vContinentalDry;
  varying vec3  vWorldNormal;
  varying vec3  vWorldPos;
  varying vec3  vSeed;

  // Cheap per-vertex hash noise — used to perturb the coastline silhouette
  // away from the underlying hexagonal mesh.
  float vhash(vec3 p) {
    p = fract(p * vec3(443.8975, 397.2973, 491.1871));
    p += dot(p, p.yzx + 19.19);
    return fract((p.x + p.y) * p.z);
  }

  void main() {
    // Gentle displacement — continents lift 2-3% of planet radius at 1×.
    // Per-vertex noise modulates the elevation so coastline silhouettes
    // don't read as straight hex tile edges.
    float n_coast  = vhash(position * 38.0) - 0.5;
    float n_micro  = vhash(position * 90.0) - 0.5;
    float hJitter  = aPack0.x + n_coast * 0.18 + n_micro * 0.06;
    float h = max(hJitter, 0.0);
    vec3  displaced = position * (1.0 + h * 0.02 * uExaggeration);

    vElevation = aPack0.x;
    vSlope = aPack0.y;
    vPlateId = aPack0.z;
    vContinental = aPack0.w;
    vIsBoundary = aPack1.x;
    vCollisionKind = aPack1.y;
    vSubductionProgress = aPack1.z;
    vOrogenicUplift = aPack1.w;
    vVolcanicIntensity = aPack2.x;
    vMorAgeSteps = aPack2.y;
    vCrustAge = aPack2.z;
    vBiome = aPack5.x;
    vBiome2 = aPack5.y;
    vBiomeBlend = aPack5.z;
    vTemperature = aPack3.x;
    vPrecip = aPack3.y;
    vInsolation = aPack3.z;
    vBaseTemp = aPack3.w;
    vDistToOcean = aPack4.x;
    vCurrentDt = aPack4.y;
    vOrographic = aPack4.z;
    vContinentalDry = aPack4.w;
    vWorldNormal = normalize(position);
    vWorldPos    = displaced;
    // Stable per-cell texture-space basis. The +1e-4 keeps it away from
    // exactly zero (normalize_or_zero on the Rust side can emit (0,0,0)).
    vSeed        = normalize(aSeed + vec3(1e-4));

    gl_Position = projectionMatrix * modelViewMatrix * vec4(displaced, 1.0);
  }
`;

export const FRAGMENT_SHADER = /* glsl */ `
  // Five SatMap slots: 4 climate zones blended by per-fragment latitude +
  // elevation + noise, plus a rock layer driven by slope.
  uniform sampler2D uSatMap;          // user-selected override (Settings)
  uniform sampler2D uBiome0; uniform sampler2D uBiome1; uniform sampler2D uBiome2;
  uniform sampler2D uBiome3; uniform sampler2D uBiome4; uniform sampler2D uBiome5;
  uniform sampler2D uBiome6; uniform sampler2D uBiome7; uniform sampler2D uBiome8;
  uniform sampler2D uBiome9;
  uniform sampler2D uSatMapRock;
  // Per-biome ramp remap: (min, max, bias, _). Default (0,1,0.5,0)=identity.
  uniform vec4 uBiomeRemap[10];
  uniform float     uClimateBlend;    // 1.0 = climate-driven, 0.0 = single uSatMap
  uniform vec3      uSunDir;
  uniform float     uAmbient;
  uniform vec3      uRimColor;
  uniform vec3      uOceanColor;
  uniform float     uShowPlateOutlines;
  uniform float     uShowBoundaryGlow;
  uniform float     uMapMode;           // 0 final · 1 temp · 2 moist · 3 biome · 4 elev · 5 slope · 6 ice · 7 ocean
  uniform float     uSurfaceBrightness; // land albedo gain (ocean excluded)
  uniform float     uTextureSmooth;     // 0 = crisp/dotty .. 1 = feathered
  // cameraPosition is auto-provided by Three.js for ShaderMaterial; we
  // don't redeclare it. It's in world space and updates every frame.

  varying float vElevation;
  varying float vSlope;
  varying float vPlateId;
  varying float vContinental;
  varying float vIsBoundary;
  varying float vCollisionKind;
  varying float vSubductionProgress;
  varying float vOrogenicUplift;
  varying float vVolcanicIntensity;
  varying float vMorAgeSteps;
  varying float vCrustAge;
  varying float vBiome;
  varying float vBiome2;
  varying float vBiomeBlend;
  varying float vTemperature;
  varying float vPrecip;
  varying float vInsolation;
  varying float vBaseTemp;
  varying float vDistToOcean;
  varying float vCurrentDt;
  varying float vOrographic;
  varying float vContinentalDry;
  varying vec3  vWorldNormal;
  varying vec3  vWorldPos;
  varying vec3  vSeed;

  // ── Noise primitives ─────────────────────────────────────────────────────
  // Deterministic hash → value noise → FBM. Gemini: 4-6 octaves, lacunarity
  // 2.0, persistence 0.45-0.5 is the sweet spot for color masking.

  float hash3(vec3 p) {
    p = fract(p * vec3(443.8975, 397.2973, 491.1871));
    p += dot(p, p.yzx + 19.19);
    return fract((p.x + p.y) * p.z);
  }

  float vnoise(vec3 p) {
    vec3 i = floor(p);
    vec3 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    float n000 = hash3(i + vec3(0,0,0));
    float n100 = hash3(i + vec3(1,0,0));
    float n010 = hash3(i + vec3(0,1,0));
    float n110 = hash3(i + vec3(1,1,0));
    float n001 = hash3(i + vec3(0,0,1));
    float n101 = hash3(i + vec3(1,0,1));
    float n011 = hash3(i + vec3(0,1,1));
    float n111 = hash3(i + vec3(1,1,1));
    float nx00 = mix(n000, n100, f.x);
    float nx10 = mix(n010, n110, f.x);
    float nx01 = mix(n001, n101, f.x);
    float nx11 = mix(n011, n111, f.x);
    return mix(mix(nx00, nx10, f.y), mix(nx01, nx11, f.y), f.z);
  }

  float fbm(vec3 p) {
    float v = 0.0;
    float a = 0.5;
    for (int i = 0; i < 5; i++) {     // 5 octaves
      v += vnoise(p) * a;
      p *= 2.0;                       // lacunarity 2.0
      a *= 0.48;                      // persistence ~0.5
    }
    return v;
  }

  // ── Colour management (G.7 step 1) ───────────────────────────────────────
  // THREE.ShaderMaterial does NOT auto-convert texture reads or output —
  // only built-in materials do. So we handle the full linear workflow
  // ourselves: sRGB-encoded SatMap PNGs are decoded to linear on sample,
  // all lighting/mixing happens in linear space, and the final composite
  // is encoded back to sRGB. ACES is deleted (it double-compressed already
  // display-referred Blue-Marble-derived imagery → the muddiness).
  vec3 srgbToLinear(vec3 c) {
    return mix(c / 12.92,
               pow((c + 0.055) / 1.055, vec3(2.4)),
               step(0.04045, c));
  }
  vec3 linearToSrgb(vec3 c) {
    c = clamp(c, 0.0, 1.0);
    return mix(c * 12.92,
               1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055,
               step(0.0031308, c));
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  // Sample a SatMap as a pure 1D gradient by normalized elevation h ∈ [0, 1].
  // uv.x fixed at 0.5 so we hit the centre column every time. The PNG is
  // sRGB-encoded; decode to linear here (the single texture chokepoint).
  vec3 sampleGradient(sampler2D tex, float h) {
    return srgbToLinear(texture2D(tex, vec2(0.5, 1.0 - clamp(h, 0.02, 0.98))).rgb);
  }

  // Gaea-style ramp remap: clamp h to [min,max] then Schlick bias.
  // rp = (min, max, bias, _). bias 0.5 = identity, <0.5 darker, >0.5 lighter.
  float remapH(float h, vec4 rp) {
    float t = clamp((h - rp.x) / max(rp.y - rp.x, 1e-3), 0.0, 1.0);
    float b = clamp(rp.z, 0.001, 0.999);
    return t / ((1.0 / b - 2.0) * (1.0 - t) + 1.0);
  }

  // Pick the right height ramp for a biome id (ice uses the ice height
  // field) and apply that biome's Schlick remap.
  float remapBiomeH(float id, float hl, float hi) {
    float h = (id > 8.5) ? hi : hl;
    return remapH(h, uBiomeRemap[int(id + 0.5)]);
  }

  vec3 sampleBiome(float id, float h) {
    int b = int(id + 0.5);
    if (b == 0) return sampleGradient(uBiome0, h);
    if (b == 1) return sampleGradient(uBiome1, h);
    if (b == 2) return sampleGradient(uBiome2, h);
    if (b == 3) return sampleGradient(uBiome3, h);
    if (b == 4) return sampleGradient(uBiome4, h);
    if (b == 5) return sampleGradient(uBiome5, h);
    if (b == 6) return sampleGradient(uBiome6, h);
    if (b == 7) return sampleGradient(uBiome7, h);
    if (b == 8) return sampleGradient(uBiome8, h);
    return sampleGradient(uBiome9, h);
  }
  vec3 biomeDebugColor(float id) {
    int b = int(id + 0.5);
    if (b == 0) return vec3(0.05,0.45,0.10);
    if (b == 1) return vec3(0.75,0.78,0.30);
    if (b == 2) return vec3(0.85,0.62,0.30);
    if (b == 3) return vec3(0.06,0.55,0.35);
    if (b == 4) return vec3(0.15,0.55,0.20);
    if (b == 5) return vec3(0.55,0.60,0.30);
    if (b == 6) return vec3(0.70,0.72,0.42);
    if (b == 7) return vec3(0.10,0.35,0.30);
    if (b == 8) return vec3(0.55,0.50,0.45);
    return vec3(0.95,0.97,1.00);
  }

  // Latitude approximation from a unit-sphere normal (Y-up). Returns 0 at
  // equator, ±1 at poles.
  float latitude(vec3 n) { return n.y; }

  // ── G.7 step 3: analytical relief normal ─────────────────────────────────
  // Perturb the SMOOTH interpolated sphere normal by the gradient of the
  // noise field (3-sample finite difference). NOT dFdx/dFdy — those are
  // per-face-constant on a low-poly icosphere and would facet the sphere.
  // This is what makes flat dark continents catch directional light.
  vec3 computeReliefNormal(vec3 p, float currentNoise, float bumpScale) {
    vec2 e = vec2(0.0015, 0.0);
    float dx = fbm(p + e.xyy) - currentNoise;
    float dy = fbm(p + e.yxy) - currentNoise;
    float dz = fbm(p + e.yyx) - currentNoise;
    return normalize(vWorldNormal - vec3(dx, dy, dz) * bumpScale);
  }

  void main() {
    // ── Per-fragment scalar fields ────────────────────────────────────────
    float fbmCoarse = fbm(vWorldNormal *   6.0);   // continent-scale
    float fbmFine   = fbm(vWorldNormal *  28.0);   // textural breakup
    float fbmHigh   = fbm(vWorldNormal *  90.0);   // edge-soft noise

    // Sub-cell spatial fractal: breaks the per-cell tessellation on every
    // mask edge. World-space (varies within a triangle) — interiors are
    // smoothstep-saturated so only transition bands move (no interior crawl).
    vec3  wpf   = normalize(vWorldPos);
    float warpA = fbm(wpf * 18.0);
    float warpB = fbm(wpf * 42.0 + 11.3);
    float edgeJ = (warpA - 0.5) * 0.65 + (warpB - 0.5) * 0.35; // ~[-0.5,0.5]
    vec3  wWarp = (vec3(fbm(wpf*9.0), fbm(wpf*9.0+7.1), fbm(wpf*9.0+19.7)) - 0.5);
    // The Smoothing slider also widens de-hexing: scale every perturbation
    // (and its matching smoothstep window) by this so they stay paired.
    float jScale = mix(1.0, 1.6, uTextureSmooth);

    // elevField is kept ONLY for downstream elevation-legitimate masks
    // (beach band, coastline). It must NOT drive base albedo — that is the
    // bullseye bug (smooth radial elevation → concentric colour contours).
    float elevField = vElevation
                    + (fbmCoarse - 0.5) * 0.55
                    + (fbmFine   - 0.5) * 0.15;

    // ── Colour = f(biome region, STOCHASTIC scatter) ────────────────────
    // A 1-D ramp sampled by ANY smooth coordinate forms colour contours.
    // Fix: a low-freq MACRO band picks only the *region* of the palette
    // (climate + gentle elevation), then a high-frequency per-fragment
    // hash SCATTER makes neighbouring pixels land on DIFFERENT but
    // plausible rows → a noisy, intermixed, contour-free pattern (how
    // real macro-scale satellite terrain actually reads).
    // flaw A3: key the within-biome texture noise on the cell-STABLE seed
    // (vSeed) instead of the world-space normal, so the texture rides with
    // the drifting crust instead of crawling through a world-locked field.
    vec3 cwarp = vec3(fbm(vSeed*2.0+5.2), fbm(vSeed*2.0+19.7),
                      fbm(vSeed*2.0+37.1));
    // Macro region: low-frequency only (never swept smoothly across the
    // whole ramp). Gentle within-biome elevation trend (flaw A3): valleys
    // sit lower in the palette, uplands higher.
    float elevTerm = clamp(max(vElevation, 0.0) * 1.4, 0.0, 1.0);
    float macro    = fbm(vSeed * 3.0 + cwarp * 1.2);
    // Fold a little SPATIAL edgeJ into the within-biome band: where a true
    // crossfade is impossible (neighbour cells differ in vBiome, blend≈0)
    // this organic variation keeps adjacent same-biome cells from reading
    // as flat polygons, visually burying the facet. Amplitude 0.05 ≪ the
    // band's [0.06,0.94] working range → only a gentle tonal wobble.
    float band     = clamp(0.42 * macro + 0.34 * elevTerm
                         + 0.24 * clamp(vPrecip, 0.0, 1.0)
                         + edgeJ * 0.05 * jScale, 0.06, 0.94);
    // Stochastic scatter: COHERENT mid-frequency FBM (no per-fragment hash —
    // that read as standout single-pixel static). Two octaves give larger
    // "pixel" blobs that still break the 1-D ramp into a contour-free
    // intermixed pattern, but at a believable macro feature size.
    float sMul = mix(1.0, 0.45, clamp(uTextureSmooth, 0.0, 1.0));
    float scatter  = (fbm(vSeed * 45.0)  - 0.5) * 0.26 * mix(1.0, 0.75, uTextureSmooth)
                   + (fbm(vSeed * 130.0) - 0.5) * 0.12 * sMul
    // Spatial component (varies within a cell) so same-biome neighbours are
    // not uniformly flat across the polygon seam. 0.06 ≪ the 0.26 cell term.
                   + edgeJ * 0.06 * jScale;
    float hLand = clamp(band + scatter, 0.02, 0.98);
    // Ice: tight bright band, still scattered so it isn't a flat sheet.
    float hIce  = clamp(0.34 + scatter * 0.5, 0.02, 0.98);

    // Biome is authoritative from Rust (classify_biome): a primary id, an
    // optional secondary id, and a blend weight. No shader-side thresholds.
    // The raw per-cell blend meets neighbours on a hard hex facet edge;
    // dissolve it with cell-stable fbm so the two biomes interleave across
    // a widened, organic transition band instead of a straight polygon line.
    // bdith is now SPATIAL (edgeJ, sub-cell) not vSeed (cell-constant), so
    // the blend boundary dissolves across the polygon edge instead of
    // snapping to it. Window is the full [0,1] smoothstep; amplitude is
    // |edgeJ|·0.95·1.6 ≈ 0.76 max < 1.0 window → widened, no clip-dither.
    float bmix   = clamp(vBiomeBlend * 2.0, 0.0, 1.0);
    float bdith  = edgeJ;
    bmix = smoothstep(0.0, 1.0, clamp(bmix + bdith * mix(0.55, 0.95, uTextureSmooth) * jScale, 0.0, 1.0));
    vec3 base = mix(
      sampleBiome(vBiome,  remapBiomeH(vBiome,  hLand, hIce)),
      sampleBiome(vBiome2, remapBiomeH(vBiome2, hLand, hIce)),
      bmix);

    vec3 rock = sampleGradient(uSatMapRock, clamp(band * 1.1 + scatter, 0.04, 0.96));

    // Slope rock mask — smoothstep + fwidth anti-aliasing per Gemini.
    // Threshold raised to ~0.60 (≈ 36° incline) so only genuinely steep
    // interior terrain gets rock; biome-dependent in a future v3.
    // Perturb with SPATIAL edgeJ (sub-cell) so the rock band dissolves the
    // hex facet; fwidth still drives the AA window so it never dithers.
    // window ≈ (0.74-0.60)=0.14 + 2·sw ; amplitude |edgeJ|·0.18·1.6 ≈ 0.14
    // max — paired to the window (no dither), softer than a hard band.
    float slopeWithNoise = vSlope + edgeJ * 0.18 * jScale;
    float sw = max(fwidth(slopeWithNoise), 0.001);
    float rockMask = smoothstep(0.60 - sw, 0.74 + sw, slopeWithNoise);
    // Suppress the thick coastal rock band: vSlope spikes at the land/sea
    // elevation step, so gate rock out where land is barely above sea level
    // (elevField is the organic, sub-cell-perturbed elevation coordinate).
    // window 0.06, no extra perturbation added (elevField already carries
    // fbm) → soft, no dither.
    rockMask *= smoothstep(0.0, 0.06, elevField);
    vec3  albedo   = mix(base, rock, rockMask);

    // ── Beach mask: low elevation × gentle slope, tight band near 0 ─────
    // (Note: 'flat' is a reserved GLSL keyword — variable named flatness.)
    // Beach: a thin, MUTED sand band (linear-space tone, gated by the
    // same organic coordinate the coast uses so it doesn't dither).
    // Sand is NOT a function of low elevation alone — it must pass the
    // climate filter. Only DRY (low-precip) coasts get sand; wet/temperate
    // lowlands keep their biome vegetation (mangrove/jungle/marsh come
    // from the biome SatMap, not bare sand).
    // Perturb the sand line with SPATIAL edgeJ so it is an organic shore
    // band, not a hex ring. window 0.05·jScale, amplitude |edgeJ|·0.022·
    // jScale ≈ 0.018·jScale < window → soft, no dither.
    float beachCoord = elevField + edgeJ * 0.022 * jScale;
    float beachH   = 1.0 - smoothstep(0.0, 0.05 * jScale, beachCoord);
    float flatness = 1.0 - smoothstep(0.0, 0.12, vSlope);
    float aridity  = 1.0 - smoothstep(0.16, 0.42, vPrecip);   // 1 = arid, 0 = wet
    float beach    = clamp(beachH * flatness * aridity * step(0.0, vElevation), 0.0, 1.0);
    albedo = mix(albedo, vec3(0.34, 0.27, 0.16), beach * 0.5);

    // ── Shared cold field (drives the 3-stage snow/rock/continent gradient
    //    AND gates the Tibet tone, so they are concentric — never a ring).
    // One temperature coordinate, SPATIALLY perturbed by edgeJ in °C so all
    // three boundaries are organic (no clean ring / hex). Replaces the old
    // per-mask world-normal fbm that double-patterned the cap edge.
    float coldC      = vTemperature + edgeJ * 5.0 * jScale;   // ~±8°C jitter
    // Stage 1 — exposed alpine substrate: as it gets cold, vegetation gives
    // way to bare rock. WIDE window (10°C ≫ ~8°C jitter → soft, no dither).
    float substrateA = 1.0 - smoothstep(-2.0, 8.0, coldC);
    // Stage 2 — snow on top of that substrate: a SEPARATE, colder, also-
    // perturbed threshold. WIDE window (10°C ≫ jitter → feathered).
    float snowA      = 1.0 - smoothstep(-12.0, -2.0, coldC);

    // Tibet-style high plateau: tall, non-polar ground reads as warm ochre
    // high-desert. (a) inputs jittered by edgeJ so it is not a hex/ring;
    // (b) gated OUT under the alpine substrate so it never forms a grey
    // halo between snow and continent; (c) lower max opacity + warmer tone
    // so it blends continuously into the surrounding continent.
    // tibetH window 0.32 ≫ amplitude |edgeJ|·0.05·jScale ≈ 0.05 → no dither.
    float tibetH    = smoothstep(0.42, 0.74, vElevation + edgeJ * 0.05 * jScale);
    // nonPolar window 12°C ≫ |edgeJ|·5·jScale ≈ 8°C jitter (shared coldC).
    float nonPolar  = smoothstep(-4.0, 8.0, coldC);
    float tibetMask = tibetH * nonPolar * (1.0 - substrateA);
    vec3  tibetCol  = vec3(0.44, 0.36, 0.24) * (0.92 + scatter * 0.5); // warmer
    albedo = mix(albedo, tibetCol, tibetMask * 0.5);                    // lower

    // ── G.7 steps 4+5: Beer-Lambert ocean + crisp fwidth-AA coast ────────
    // SCRATCHED: the domain-warped "organic coast" produced a cloud-like
    // blue haze the user disliked. Reverted to a plain land/sea boundary —
    // a clean fwidth-sized 1px edge straight off vElevation (so the coast
    // traces the cell tessellation for now). The real sub-cell coastline
    // approach is parked for a dedicated brainstorm.
    float seaCoord   = vElevation;
    float coastWidth = max(fwidth(seaCoord), 0.0025);
    float oceanMask  = 1.0 - smoothstep(-coastWidth, coastWidth, seaCoord);

    // Lift land albedo (SatMaps read very dark) — ocean excluded so the
    // dark-navy water (and its no-cyan invariant) is untouched.
    albedo *= mix(1.0, uSurfaceBrightness, 1.0 - oceanMask);

    if (oceanMask > 0.001) {
      // Earth-from-orbit ocean is a DARK, DESATURATED BLUE — never cyan.
      // The previous cyan was a BUG: a per-channel exp() transmittance
      // vec3 used as the mix() factor forces a teal partial-blend that
      // never reaches deep navy. Fix: a SCALAR depth lerp between two
      // dark blues. Both endpoints keep B > G > R with G well below B and
      // low overall, so the result stays on the blue line at every depth.
      // All colours LINEAR (output is linear→sRGB encoded).
      float dWater       = clamp(max(-seaCoord, 0.0) / 0.45, 0.0, 1.0);
      vec3  shallowWater = vec3(0.015, 0.050, 0.085);
      vec3  deepWater    = vec3(0.002, 0.010, 0.030);
      vec3  water        = mix(shallowWater, deepWater, dWater);

      // Faint large-scale tonal variation (subtle, never brightens cyan).
      water *= 0.90 + 0.16 * fbm(vWorldNormal * 4.0);

      // Schlick fresnel — only the planet limb picks up a sky sheen, and
      // the target is itself a darker blue (not a bright tint).
      vec3  Vo   = normalize(cameraPosition - vWorldPos);
      float NoV  = max(dot(vWorldNormal, Vo), 0.0);
      float fres = 0.02 + 0.98 * pow(1.0 - NoV, 5.0);
      water = mix(water, vec3(0.10, 0.20, 0.38), fres * 0.6);

      // Tight specular sun glint (small sharp white highlight only).
      vec3  Lo  = normalize(uSunDir);
      vec3  Ho  = normalize(Lo + Vo);
      float spec = pow(max(dot(vWorldNormal, Ho), 0.0), 500.0) * fres;
      water += vec3(1.0, 0.96, 0.86) * spec * 1.2;

      albedo = mix(albedo, water, oceanMask);
    }

    // ── 3-stage snow / rock / continent gradient ────────────────────────
    // The old code had ONE hard ice override (iceCap*0.92) that snapped to
    // a clean grey ring against the continent → fake-looking. Replace with
    // THREE soft, CONCENTRIC bands that share the SAME perturbed cold
    // coordinate (coldC / substrateA / snowA, computed once up top), so
    // there is no seam or gap between them:
    //   vegetation  →  exposed alpine rock  →  snow
    // Every boundary is jittered by edgeJ (folded into coldC) so none is a
    // clean ring or hex. Land-gated here (substrate/snow never on ocean).
    float land      = 1.0 - oceanMask;
    // Stage 1: blend the biome albedo toward desaturated alpine rock as the
    // ground gets cold-exposed. WIDE: substrateA already a 10°C smoothstep
    // (≫ ~8°C edgeJ jitter) → feathered, no dither. Capped < 1 so it never
    // fully erases the biome (keeps a continuous tonal handoff).
    vec3  alpineRock = vec3(0.22, 0.20, 0.18) * (0.95 + scatter * 0.4);
    float substrate  = substrateA * land;
    albedo = mix(albedo, alpineRock, substrate * 0.85);
    // Stage 2: snow feathers ON TOP of that substrate over the SEPARATE,
    // colder snowA threshold (also a 10°C window ≫ jitter → soft). Because
    // snowA shares coldC with substrateA the two bands are concentric:
    // snow → rock → vegetation with NO border. Gentle low-freq cool shade.
    float iceShade = 0.88 + 0.12 * fbm(vWorldNormal * 9.0);
    vec3  iceColor = vec3(0.92, 0.94, 0.97) * iceShade;
    float snow     = snowA * land;
    albedo = mix(albedo, iceColor, snow);

    // ── Pink seam highlight (unassigned boundaries) ──────────────────────
    if (vIsBoundary > 0.5 && vCollisionKind < 0.5) {
      albedo = mix(albedo, vec3(0.80, 0.20, 0.50), 0.45);
    }

    // ── Active-boundary tints ─────────────────────────────────────────────
    if (uShowBoundaryGlow > 0.5) {
      if (vCollisionKind > 0.5 && vCollisionKind < 1.5) {
        vec3 hot = vec3(0.95, 0.40, 0.15);
        albedo = mix(albedo, hot, (1.0 - vSubductionProgress) * 0.55);
      } else if (vCollisionKind > 1.5 && vCollisionKind < 2.5) {
        albedo = mix(albedo, vec3(0.78, 0.32, 0.20), vOrogenicUplift * 0.55);
      } else if (vCollisionKind > 2.5 && vCollisionKind < 3.5) {
        albedo = mix(albedo, vec3(0.15), 0.6);
      }
    }

    // ── Volcanic glow ─────────────────────────────────────────────────────
    if (vVolcanicIntensity > 0.01) {
      albedo += vec3(1.0, 0.55, 0.15) * vVolcanicIntensity * 0.35;
    }

    // ── Plate outline pass via fwidth ─────────────────────────────────────
    if (uShowPlateOutlines > 0.5) {
      float edge = step(0.001, fwidth(vPlateId));
      albedo *= mix(1.0, 0.82, edge);
    }

    // ── Cavity AO from elevation-field derivatives (Gemini point 7) ──────
    float cavity = length(vec2(dFdx(vElevation), dFdy(vElevation)));
    float fakeAO = 1.0 - smoothstep(0.0, 0.4, cavity);
    albedo *= mix(0.90, 1.0, fakeAO);   // softened (was 0.78 — dFdx AO is coarse on a low-poly icosphere)

    // ── Debug map modes (validate the science before trusting colour) ────
    if (uMapMode > 0.5) {
      vec3 d;
      if (uMapMode < 1.5) {
        // Temperature: geographic ramp purple→blue→cyan→green→yellow→red
        // over −30..+40 °C (reads like a real climate map, not washed grey).
        float tN = clamp((vTemperature + 30.0) / 70.0, 0.0, 1.0);
        vec3 c0 = vec3(0.28,0.0,0.42);   // < -30 frozen purple
        vec3 c1 = vec3(0.10,0.30,0.85);  // cold blue
        vec3 c2 = vec3(0.10,0.75,0.80);  // cool cyan
        vec3 c3 = vec3(0.30,0.75,0.20);  // mild green
        vec3 c4 = vec3(0.95,0.85,0.20);  // warm yellow
        vec3 c5 = vec3(0.85,0.15,0.10);  // hot red
        d =       mix(c0, c1, smoothstep(0.00,0.20,tN));
        d = mix(d, c2, smoothstep(0.20,0.40,tN));
        d = mix(d, c3, smoothstep(0.40,0.60,tN));
        d = mix(d, c4, smoothstep(0.60,0.80,tN));
        d = mix(d, c5, smoothstep(0.80,1.00,tN));
      }
      else if (uMapMode < 2.5) {
        // Precipitation: arid tan → savanna yellow → green → wet deep blue.
        float pN = clamp(vPrecip, 0.0, 1.0);
        vec3 a0 = vec3(0.78,0.66,0.40);  // arid tan
        vec3 a1 = vec3(0.80,0.78,0.30);  // semi-arid
        vec3 a2 = vec3(0.30,0.65,0.25);  // moist green
        vec3 a3 = vec3(0.05,0.30,0.75);  // very wet blue
        d =       mix(a0, a1, smoothstep(0.00,0.30,pN));
        d = mix(d, a2, smoothstep(0.30,0.62,pN));
        d = mix(d, a3, smoothstep(0.62,1.00,pN));
      }
      else if (uMapMode < 3.5)  d = biomeDebugColor(vBiome);
      else if (uMapMode < 4.5)  d = vec3(clamp(max(vElevation,0.0),0.0,1.0));
      else if (uMapMode < 5.5)  d = vec3(clamp(vSlope,0.0,1.0));
      else if (uMapMode < 6.5)  d = vec3(0.0,0.35,0.95) * oceanMask;
      else if (uMapMode < 7.5)  d = vec3(clamp(vInsolation,0.0,1.0));
      else if (uMapMode < 8.5)  d = vec3(clamp((vBaseTemp + 25.0)/60.0,0.0,1.0));
      else if (uMapMode < 9.5)  d = vec3(clamp(vDistToOcean / 4000.0,0.0,1.0));
      else if (uMapMode < 10.5) d = mix(vec3(0.1,0.1,0.9), vec3(0.95,0.3,0.1), clamp(vCurrentDt*0.05 + 0.5, 0.0, 1.0));
      else if (uMapMode < 11.5) d = mix(vec3(0.85,0.55,0.15), vec3(0.1,0.5,0.95), clamp(vOrographic*0.5 + 0.5, 0.0, 1.0));
      else                      d = vec3(clamp(vContinentalDry,0.0,1.0));
      gl_FragColor = vec4(linearToSrgb(d), 1.0);
      return;
    }

    // ── Lighting: relief Lambert + rim + atmospheric scatter ─────────────
    vec3 L = normalize(uSunDir);
    vec3 V = normalize(cameraPosition - vWorldPos);

    // Relief normal for diffuse only — flat plains stay smooth, steep
    // orogenic zones get rugged directional shading. Silhouette effects
    // (halo / rim / view) stay on the TRUE sphere normal.
    vec3 N = normalize(vWorldNormal);
    float landMask = 1.0 - oceanMask;
    // Moderated relief — orbital land is fairly smooth; aggressive bump
    // created harsh black speckle. Land only.
    float bumpScale = (0.4 + smoothstep(0.12, 0.6, vSlope) * 2.6) * landMask;
    vec3 reliefNormal = computeReliefNormal(vWorldNormal * 30.0, fbmFine, bumpScale);

    float viewAngle = max(dot(N, V), 0.0);
    float halo = pow(1.0 - viewAngle, 4.0);
    vec3 atmosphere = vec3(0.40, 0.62, 1.00);

    // (Gemini: the dark-lift + desaturate hacks were band-aids over the
    //  semantic-scramble bug. Removed. With strict-elevation h + sharpened
    //  biome blend the native linear SatMap colours behave correctly.)

    // Flat-lit-albedo model: real orbital imagery (Blue Marble) is shot
    // near local noon and reads as near-uniform albedo with only a gentle
    // terminator — NOT a dramatically shaded ball. A soft wrap keeps the
    // whole day side broadly bright and never crushes to black. (This is
    // also the soft-terminator look from the Bekk reference.)
    float ndl  = dot(reliefNormal, L);
    float wrap = clamp(ndl * 0.5 + 0.5, 0.0, 1.0);
    float lightTerm = 0.55 + 0.60 * pow(wrap, 1.2);   // ~0.55 night .. ~1.15 noon
    vec3 lit = albedo * lightTerm;

    // Limb tint — kept subtle so it doesn't wash the disc edge.
    lit = mix(lit, atmosphere, halo * 0.12);
    lit += atmosphere * halo * 0.12 * max(ndl, 0.0);
    float rim = pow(1.0 - viewAngle, 2.0);
    lit += uRimColor * rim * 0.10;

    // ── Output: linear → sRGB OETF (G.7 step 1) ──────────────────────────
    // No tone mapping: the SatMap content is display-referred satellite
    // imagery, not scene-referred HDR. Just encode linear → sRGB.
    gl_FragColor = vec4(linearToSrgb(lit), 1.0);
  }
`;
