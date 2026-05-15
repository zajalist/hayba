export const VERTEX_SHADER = /* glsl */ `
  attribute float elevation;
  attribute float slope;
  attribute float plateId;
  attribute float continental;
  attribute float isBoundary;
  attribute float collisionKind;
  attribute float subductionProgress;
  attribute float orogenicUplift;
  attribute float volcanicIntensity;
  attribute float morAgeSteps;
  attribute float crustAge;

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
  varying vec3  vWorldNormal;
  varying vec3  vWorldPos;

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
    float hJitter  = elevation + n_coast * 0.18 + n_micro * 0.06;
    float h = max(hJitter, 0.0);
    vec3  displaced = position * (1.0 + h * 0.02 * uExaggeration);

    vElevation = elevation;
    vSlope = slope;
    vPlateId = plateId;
    vContinental = continental;
    vIsBoundary = isBoundary;
    vCollisionKind = collisionKind;
    vSubductionProgress = subductionProgress;
    vOrogenicUplift = orogenicUplift;
    vVolcanicIntensity = volcanicIntensity;
    vMorAgeSteps = morAgeSteps;
    vCrustAge = crustAge;
    vWorldNormal = normalize(position);
    vWorldPos    = displaced;

    gl_Position = projectionMatrix * modelViewMatrix * vec4(displaced, 1.0);
  }
`;

export const FRAGMENT_SHADER = /* glsl */ `
  // Five SatMap slots: 4 climate zones blended by per-fragment latitude +
  // elevation + noise, plus a rock layer driven by slope.
  uniform sampler2D uSatMap;          // user-selected override (Settings)
  uniform sampler2D uSatTropical;
  uniform sampler2D uSatArid;
  uniform sampler2D uSatTemperate;
  uniform sampler2D uSatPolar;
  uniform sampler2D uSatMapRock;
  uniform float     uClimateBlend;    // 1.0 = climate-driven, 0.0 = single uSatMap
  uniform vec3      uSunDir;
  uniform float     uAmbient;
  uniform vec3      uRimColor;
  uniform vec3      uOceanColor;
  uniform float     uShowPlateOutlines;
  uniform float     uShowBoundaryGlow;
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
  varying vec3  vWorldNormal;
  varying vec3  vWorldPos;

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

    // elevField is kept ONLY for downstream elevation-legitimate masks
    // (beach band, coastline). It must NOT drive base albedo — that is the
    // bullseye bug (smooth radial elevation → concentric colour contours).
    float elevField = vElevation
                    + (fbmCoarse - 0.5) * 0.55
                    + (fbmFine   - 0.5) * 0.15;

    // ── G.7 step 2: biome-keyed albedo (kills the bullseye) ───────────────
    // Base colour is keyed on a DOMAIN-WARPED MOISTURE field — horizontally
    // varying, fully decoupled from radial elevation. Climate class is
    // selected by a TEMPERATURE field (latitude lapse + elevation lapse +
    // noise). Whittaker-style on the hot side: hot+wet→tropical,
    // hot+dry→arid; temperature ramp on the cold side (temperate→polar).
    vec3 warp = vec3(
      fbm(vWorldNormal * 2.5 + vec3(5.2, 1.3, 2.8)),
      fbm(vWorldNormal * 2.5 + vec3(1.1, 8.4, 3.5)),
      fbm(vWorldNormal * 2.5 + vec3(7.4, 2.1, 9.6))
    );
    // Multi-frequency moisture: a low-freq continental field + mid-freq
    // detail so biomes aren't two giant blobs.
    float moisture = clamp(
        fbm(vWorldNormal * 3.0 + warp * 1.5) * 0.65
      + fbm(vWorldNormal * 9.0)              * 0.35, 0.0, 1.0);

    // More latitude cooling so mid-latitudes actually reach the temperate
    // band (olive/brown), not just equatorial tropical+arid.
    float latCooling = abs(vWorldNormal.y);
    float equivElev  = max(vElevation, 0.0) * 0.7 + latCooling * 1.4;
    float temperature = 1.0 - clamp(
        equivElev + (fbm(vWorldNormal * 12.0) - 0.5) * 0.15, 0.0, 1.0);

    // The 1D row: NOT pure moisture (that inverted the SatMap's authored
    // elevation-ramp semantics and lost detail). A noise-dominated blend
    // of a gentle within-biome elevation trend + moisture + multi-octave
    // breakup. Noise dominates so no contour rings re-form.
    float elevH  = clamp(max(vElevation, 0.0) * 1.1, 0.0, 1.0);
    float detail = fbm(vWorldNormal * 11.0) * 0.55
                 + fbm(vWorldNormal * 26.0) * 0.45;
    float h = clamp(0.28 * elevH + 0.30 * moisture + 0.42 * detail,
                    0.02, 0.98);

    float cold     = 1.0 - smoothstep(0.20, 0.34, temperature);
    float hot      = smoothstep(0.56, 0.74, temperature);
    float midTemp  = clamp(1.0 - cold - hot, 0.0, 1.0);
    float wet      = smoothstep(0.42, 0.60, moisture);

    float wPolar = cold;
    float wTemp  = midTemp;
    float wTrop  = hot * wet;
    float wArid  = hot * (1.0 - wet);
    float wTotal = wTrop + wArid + wTemp + wPolar + 1e-4;
    wTrop /= wTotal; wArid /= wTotal; wTemp /= wTotal; wPolar /= wTotal;

    vec3 climateBase =
        sampleGradient(uSatTropical,  h) * wTrop
      + sampleGradient(uSatArid,      h) * wArid
      + sampleGradient(uSatTemperate, h) * wTemp
      + sampleGradient(uSatPolar,     h) * wPolar;

    // The user can disable climate diversity to lock the whole planet to a
    // single Settings-chosen SatMap.
    vec3 base = mix(sampleGradient(uSatMap, h), climateBase, uClimateBlend);
    vec3 rock = sampleGradient(uSatMapRock, h * 1.1);

    // Slope rock mask — smoothstep + fwidth anti-aliasing per Gemini.
    // Threshold around ~0.55 (≈ 33° incline); biome-dependent in a future v3.
    float slopeWithNoise = vSlope + (fbmHigh - 0.5) * 0.18;
    float sw = max(fwidth(slopeWithNoise), 0.001);
    float rockMask = smoothstep(0.55 - sw, 0.70 + sw, slopeWithNoise);
    vec3  albedo   = mix(base, rock, rockMask);

    // ── Beach mask: low elevation × gentle slope, tight band near 0 ─────
    // (Note: 'flat' is a reserved GLSL keyword — variable named flatness.)
    // Beach: a thin, MUTED sand band (linear-space tone, gated by the
    // same organic coordinate the coast uses so it doesn't dither).
    float beachH   = 1.0 - smoothstep(0.0, 0.05, elevField);
    float flatness = 1.0 - smoothstep(0.0, 0.12, vSlope);
    float beach    = clamp(beachH * flatness * step(0.0, vElevation), 0.0, 1.0);
    albedo = mix(albedo, vec3(0.34, 0.27, 0.16), beach * 0.45);

    // ── G.7 steps 4+5: Beer-Lambert ocean + fwidth-AA organic coast ──────
    // Coastline: domain-warp the INPUT coordinate (organic fingers), then
    // size the mask transition to fwidth() so it is exactly one-pixel-wide
    // at any zoom (no dither — the old failure was noise amplitude ≈ the
    // fixed smoothstep window). Noise amplitude is kept ≪ the window.
    vec3 coastWarp = vWorldNormal + (vec3(
        fbm(vWorldNormal * 14.0),
        fbm(vWorldNormal * 14.0 + 31.7),
        fbm(vWorldNormal * 14.0 + 67.1)) - 0.5) * 0.05;
    float seaCoord = vElevation + (fbm(coastWarp * 9.0) - 0.5) * 0.03;
    float coastWidth = max(fwidth(seaCoord), 0.0025);
    float oceanMask  = 1.0 - smoothstep(-coastWidth, coastWidth, seaCoord);

    if (oceanMask > 0.001) {
      // All colours LINEAR (output is linear→sRGB encoded). Per-channel
      // Beer-Lambert extinction (red dies first). CRITICAL: unpainted
      // oceans have a NARROW shallow vElevation band (~-0.05..-0.35), not
      // full -1..0 bathymetry, so the depth scale must be small (~6) or
      // extinction saturates and the whole ocean collapses to black.
      vec3  deepAbyss   = vec3(0.012, 0.035, 0.085);  // believable deep ocean blue, not black
      vec3  shallowBed  = vec3(0.05,  0.16,  0.21);   // muted shallow
      vec3  extinction  = vec3(0.65, 0.15, 0.05);
      float depth       = max(-seaCoord, 0.0) * 6.0;
      vec3  transmit    = exp(-extinction * depth);
      vec3  water       = mix(deepAbyss, shallowBed, transmit);

      // Subtle large-scale tonal variation so the ocean isn't dead-flat
      // even when bathymetry is uniform (no painted depth).
      water *= 0.82 + 0.30 * fbm(vWorldNormal * 4.0);

      // Schlick fresnel — sky-reflective at grazing angles.
      vec3  Vo   = normalize(cameraPosition - vWorldPos);
      float NoV  = max(dot(vWorldNormal, Vo), 0.0);
      float fres = 0.02 + 0.98 * pow(1.0 - NoV, 5.0);
      vec3  skyT = vec3(0.16, 0.32, 0.55);     // linear sky tint
      water = mix(water, skyT, fres * 0.45);

      // Tight orbital sun glint.
      vec3  Lo  = normalize(uSunDir);
      vec3  Ho  = normalize(Lo + Vo);
      float spec = pow(max(dot(vWorldNormal, Ho), 0.0), 400.0) * fres;
      water += vec3(1.0, 0.97, 0.88) * spec * 1.3;

      albedo = mix(albedo, water, oceanMask);
    }

    // ── Snow line: tight, decoupled from the SatMap noise field ─────────
    // Earth-realistic: base 30°C equator, ~6°C/km lapse, ~32°C cooling
    // equator-to-pole. The noise band on temperature is small so the
    // snow line stays a clear latitudinal feature; the SatMap noise stays
    // out of this calc to prevent random snow patches in temperate zones.
    // (step 2: latNoisy removed; reuse the climate temperature field.
    //  Full physically-based snow mask is step 6.)
    // LOW-freq edge perturbation only (was high-freq fbmFine → fine grey
    // blotch). The snow LINE stays organic; the cap INTERIOR is solid.
    float tempLand = 30.0
                   - max(vElevation, 0.0) * 6.0
                   - abs(vWorldNormal.y) * 32.0
                   + (fbmCoarse - 0.5) * 4.0;

    // Polarness: 1 deep-cold .. 0 warm. Before laying snow, gently
    // desaturate + cool-lift the underlying polar SatMap so any sub-full
    // coverage reads as a SUBTLE cool grey, not harsh dark-grey blotches
    // (matches real Earth ice: smooth white + faint cool shadow).
    float polarness = (1.0 - smoothstep(-2.0, 14.0, tempLand)) * (1.0 - oceanMask);
    float bl = dot(albedo, vec3(0.299, 0.587, 0.114));
    vec3  gentleIce = vec3(bl) * 1.18 + vec3(0.015, 0.025, 0.045);
    albedo = mix(albedo, mix(albedo, gentleIce, 0.65), polarness);

    // Snow: solid interior (no 0.95 cap), organic low-freq edge. Slightly
    // cool near-white.
    float snowMask = (1.0 - smoothstep(-1.0, 7.0, tempLand)) * (1.0 - oceanMask);
    albedo = mix(albedo, vec3(0.95, 0.96, 0.97), snowMask);

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

    // ── Lighting: relief Lambert + rim + atmospheric scatter ─────────────
    vec3 L = normalize(uSunDir);
    vec3 V = normalize(cameraPosition - vWorldPos);

    // Relief normal for diffuse only — flat plains stay smooth, steep
    // orogenic zones get rugged directional shading. Silhouette effects
    // (halo / rim / view) stay on the TRUE sphere normal.
    vec3 N = normalize(vWorldNormal);
    float bumpScale = (0.6 + smoothstep(0.1, 0.6, vSlope) * 5.0)
                    * (1.0 - oceanMask);   // no relief on water
    vec3 reliefNormal = computeReliefNormal(vWorldNormal * 30.0, fbmFine, bumpScale);

    float lambert = max(dot(reliefNormal, L), 0.0);
    float viewAngle = max(dot(N, V), 0.0);
    float halo = pow(1.0 - viewAngle, 4.0);

    vec3 atmosphere = vec3(0.40, 0.62, 1.00);

    vec3 lit = albedo * (uAmbient + (1.0 - uAmbient) * lambert);

    // Measured vibrance + exposure — real-Earth SatMap albedo is genuinely
    // low; lift midtones without going cartoony (user: green too dark).
    float luma = dot(lit, vec3(0.2126, 0.7152, 0.0722));
    lit = mix(vec3(luma), lit, 1.06) * 1.05;

    // Limb / Rayleigh — only the actual silhouette gets atmospheric tint;
    // the rest of the planet keeps its true SatMap colors.
    lit = mix(lit, atmosphere, halo * 0.18);
    lit += atmosphere * halo * 0.20 * lambert;

    // Warm rim from chrome design tokens
    float rim = pow(1.0 - viewAngle, 2.0);
    lit += uRimColor * rim * 0.15;

    // ── Output: linear → sRGB OETF (G.7 step 1) ──────────────────────────
    // No tone mapping: the SatMap content is display-referred satellite
    // imagery, not scene-referred HDR. Just encode linear → sRGB.
    gl_FragColor = vec4(linearToSrgb(lit), 1.0);
  }
`;
