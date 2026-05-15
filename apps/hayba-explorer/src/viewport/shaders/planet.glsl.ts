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
  attribute float biome;
  attribute float temperature;
  attribute float precip;
  attribute float insolation;
  attribute float baseTemp;
  attribute float distToOcean;
  attribute float currentDt;
  attribute float orographic;
  attribute float continentalDry;

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
    vBiome = biome;
    vTemperature = temperature;
    vPrecip = precip;
    vInsolation = insolation;
    vBaseTemp = baseTemp;
    vDistToOcean = distToOcean;
    vCurrentDt = currentDt;
    vOrographic = orographic;
    vContinentalDry = continentalDry;
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
  uniform float     uMapMode;           // 0 final · 1 temp · 2 moist · 3 biome · 4 elev · 5 slope · 6 ice · 7 ocean
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

    // ── Climate model (worldbuildingpasta-grounded, not pure zonal) ──────
    float sinLat = vWorldNormal.y;
    float lat    = abs(sinLat);                          // 0 equator .. 1 pole
    float latDeg = degrees(asin(clamp(lat, 0.0, 1.0)));  // 0 .. 90
    float elevKm = max(vElevation, 0.0) * 8.0;           // vElevation 1.0 ≈ 8 km

    // Continentality proxy (no cheap ocean-distance SDF available): a
    // low-freq field read as "inlandness". Drives continental drying +
    // colder interiors — the visibly non-zonal effect.
    float inland = fbm(vWorldNormal * 1.6);

    // Temperature (°C): equator base, 4.46°C/km lapse (worldbuildingpasta),
    // continental cooling, organic variation.
    float tempC = 30.0 - 50.0 * lat * lat
                       - 4.46 * elevKm
                       - inland * 7.0
                       + (fbm(vWorldNormal * 3.0) - 0.5) * 5.0;

    // Prevailing wind by latitude band (worldbuildingpasta): trades (E→W,
    // 0–30°), westerlies (W→E, 30–60°), polar easterlies (E→W, 60–90°).
    vec3 east = normalize(cross(vec3(0.0, 1.0, 0.0), vWorldNormal) + 1e-5);
    float windSign = (latDeg < 30.0) ? -1.0 : (latDeg < 60.0 ? 1.0 : -1.0);
    vec3 wind = normalize(east * windSign);

    // Orographic rain shadow: a relief normal's horizontal tilt vs the
    // wind → windward (wet) / leeward (dry), scaled by actual slope.
    vec3  rN   = computeReliefNormal(vWorldNormal * 28.0, fbm(vWorldNormal * 28.0), 2.0);
    vec3  tilt = rN - vWorldNormal;
    float orographic = dot(normalize(tilt + 1e-5), wind)
                     * smoothstep(0.15, 0.65, vSlope);

    // Precipitation 0..1: Hadley/Ferrel bands + ITCZ + orographic +
    // continental drying + organic noise.
    vec3 pwarp = vec3(fbm(vWorldNormal*2.0+11.3), fbm(vWorldNormal*2.0+27.1),
                      fbm(vWorldNormal*2.0+41.7));
    float itcz    = 1.0 - smoothstep(0.0, 16.0, latDeg);          // wet equator
    float subtrop = 1.0 - smoothstep(0.0, 12.0, abs(latDeg - 30.0)); // dry ~30°
    float midlat  = 1.0 - smoothstep(0.0, 14.0, abs(latDeg - 58.0)); // wet ~55-60°
    float polarDry= smoothstep(62.0, 82.0, latDeg);
    float zonal   = 0.85*itcz - 0.6*subtrop + 0.55*midlat - 0.4*polarDry + 0.35;
    float continentalDry = smoothstep(0.35, 0.85, inland);
    float precip = clamp(zonal + orographic * 0.6 - continentalDry * 0.55
                       + (fbm(vWorldNormal * 3.5 + pwarp * 1.4) - 0.5) * 0.35,
                       0.0, 1.0);

    // ── Biome classification (Köppen-ish, soft) ──────────────────────────
    float warmth = smoothstep(-2.0, 4.0, tempC);
    float wPolar = 1.0 - warmth;
    float hot    = smoothstep(16.0, 22.0, tempC);
    float wTrop  = hot * warmth * smoothstep(0.45, 0.65, precip);
    float wArid  = warmth * (1.0 - wPolar) * (1.0 - smoothstep(0.18, 0.36, precip));
    float wTemp  = max(0.0, warmth * (1.0 - wPolar) - wTrop - wArid);

    // ── Colour: NOISE-DOMINANT sample coord (jsulpis-proven organic look).
    // NOT pure elevation (→ contour rings / bullseye) and NOT moisture
    // (→ semantic scramble). Strong domain-warped multi-octave noise with
    // only a gentle elevation bias → organic patches of each SatMap's
    // tonal range, mountains trending up-gradient, zero rings.
    vec3 cwarp = vec3(fbm(vWorldNormal*2.0+5.2), fbm(vWorldNormal*2.0+19.7),
                      fbm(vWorldNormal*2.0+37.1));
    float organic = fbm(vWorldNormal * 5.0 + cwarp * 1.6) * 0.6
                  + fbm(vWorldNormal * 13.0)              * 0.4;
    float h = clamp(0.70 * organic + 0.30 * max(vElevation, 0.0), 0.04, 0.96);

    // Soft, NOISY-boundary blend — user wants colours to blend & be noisy,
    // not hard argmax patches. Boundary noise breaks ties organically;
    // pow(3) keeps a dominant biome without 4-way grey-mud averaging.
    float bnz = (fbm(vWorldNormal * 8.0) - 0.5) * 0.18;
    vec4 bw = pow(max(vec4(wTrop, wArid, wTemp, wPolar) + bnz, 0.0), vec4(3.0));
    bw /= (bw.x + bw.y + bw.z + bw.w + 1e-5);

    vec3 climateBase =
        sampleGradient(uSatTropical,  h) * bw.x
      + sampleGradient(uSatArid,      h) * bw.y
      + sampleGradient(uSatTemperate, h) * bw.z
      + sampleGradient(uSatPolar,     h) * bw.w;

    vec3 base = mix(sampleGradient(uSatMap, h), climateBase, uClimateBlend);
    vec3 rock = sampleGradient(uSatMapRock, clamp(h * 1.1, 0.02, 0.98));
    float moisture = precip;   // debug-mode alias

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
                   + (fbmCoarse - 0.5) * 2.0;

    // Ice cap: OVERRIDE the marbled polar SatMap entirely with smooth
    // near-white ice. The previous attempt only desaturated the SatMap,
    // so its high-contrast rock/ice pattern (sampled via fine-detail h)
    // still showed → the 50/50 grey/white mottle. Real Earth ice is
    // smooth white with gentle LOW-FREQUENCY cool shadow, plus bare rock
    // only at the very fringe (handled by the soft edge of iceCap).
    float coldness = (1.0 - smoothstep(-1.0, 12.0, tempLand)) * (1.0 - oceanMask);
    float iceCap   = smoothstep(0.32, 0.72, coldness);   // solid core, soft fringe → terrain
    float iceShade = 0.90 + 0.10 * fbm(vWorldNormal * 5.0); // gentle, broad, low-contrast
    vec3  iceColor = vec3(0.90, 0.93, 0.97) * iceShade;     // slightly cool (B>G>R)
    albedo = mix(albedo, iceColor, iceCap);

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
    // 0 final · 1 temperature · 2 moisture · 3 biome argmax · 4 elevation
    // 5 slope · 6 ice mask · 7 ocean mask
    if (uMapMode > 0.5) {
      vec3 dbg;
      if (uMapMode < 1.5) {
        dbg = vec3(clamp(tempC / 40.0, 0.0, 1.0));                       // white hot → black cold
      } else if (uMapMode < 2.5) {
        dbg = mix(vec3(0.32, 0.22, 0.05), vec3(0.05, 0.25, 0.95), moisture); // dry tan → wet blue
      } else if (uMapMode < 3.5) {
        float mx = max(max(bw.x, bw.y), max(bw.z, bw.w));
        if      (mx == bw.x) dbg = vec3(0.10, 0.70, 0.16);              // tropical green
        else if (mx == bw.y) dbg = vec3(0.88, 0.45, 0.10);              // arid orange
        else if (mx == bw.z) dbg = vec3(0.55, 0.55, 0.20);              // temperate olive
        else                 dbg = vec3(0.93, 0.96, 1.00);              // polar white
      } else if (uMapMode < 4.5) {
        dbg = vec3(clamp(max(vElevation, 0.0), 0.0, 1.0));
      } else if (uMapMode < 5.5) {
        dbg = vec3(clamp(vSlope, 0.0, 1.0));
      } else if (uMapMode < 6.5) {
        dbg = vec3(iceCap);
      } else {
        dbg = vec3(0.0, 0.35, 0.95) * oceanMask;
      }
      gl_FragColor = vec4(linearToSrgb(dbg), 1.0);
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
