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

  // ── Helpers ──────────────────────────────────────────────────────────────

  // Sample a SatMap as a pure 1D gradient by normalized elevation h ∈ [0, 1].
  // uv.x fixed at 0.5 so we hit the centre column every time.
  vec3 sampleGradient(sampler2D tex, float h) {
    return texture2D(tex, vec2(0.5, 1.0 - clamp(h, 0.02, 0.98))).rgb;
  }

  // Latitude approximation from a unit-sphere normal (Y-up). Returns 0 at
  // equator, ±1 at poles.
  float latitude(vec3 n) { return n.y; }

  // ── ACES filmic tone mapping (Narkowicz 2015 approximation). ────────────
  // Photographic shoulder — compresses highlights without clipping.
  vec3 aces(vec3 x) {
    const float a = 2.51;
    const float b = 0.03;
    const float c = 2.43;
    const float d = 0.59;
    const float e = 0.14;
    return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
  }

  void main() {
    // ── Per-fragment scalar fields ────────────────────────────────────────
    float fbmCoarse = fbm(vWorldNormal *   6.0);   // continent-scale
    float fbmFine   = fbm(vWorldNormal *  28.0);   // textural breakup
    float fbmHigh   = fbm(vWorldNormal *  90.0);   // edge-soft noise

    // Smooth elevation input for SatMap sampling — neighbouring fragments
    // see similar gradient rows, distant ones diverge.
    float elevField = vElevation
                    + (fbmCoarse - 0.5) * 0.55
                    + (fbmFine   - 0.5) * 0.15;
    float h = elevField / 1.6;   // normalize to ~0..1 for the gradient

    // ── Climate-zone blended base — Köppen-aligned latitude breakpoints ──
    // |sin(lat)| breakpoints map to real Köppen zones:
    //   ≈0.39 (23°) — tropical / subtropical edge
    //   ≈0.57 (35°) — subtropical / temperate edge
    //   ≈0.87 (60°) — temperate / polar edge
    // Arid is a narrow subtropical desert band (~23-35°). Temperate is the
    // wide mid-latitude band (~35-60°) — most of Europe, US, China sit here.
    float latRaw   = abs(vWorldNormal.y);
    float latNoisy = clamp(latRaw + (fbmCoarse - 0.5) * 0.10, 0.0, 1.0);

    float wTrop  = 1.0 - smoothstep(0.32, 0.45, latNoisy);
    float wArid  = smoothstep(0.36, 0.45, latNoisy) - smoothstep(0.52, 0.62, latNoisy);
    float wTemp  = smoothstep(0.52, 0.62, latNoisy) - smoothstep(0.82, 0.90, latNoisy);
    float wPolar = smoothstep(0.82, 0.92, latNoisy);
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
    float beachH   = 1.0 - smoothstep(0.0, 0.04, elevField + (fbmFine - 0.5) * 0.01);
    float flatness = 1.0 - smoothstep(0.0, 0.12, vSlope);
    float beach    = clamp(beachH * flatness * step(0.0, vElevation), 0.0, 1.0);
    albedo = mix(albedo, vec3(0.88, 0.82, 0.62), beach * 0.7);

    // ── Ocean: Beer-Lambert depth + noise-perturbed coastline ──────────
    // Coast mask uses high-freq FBM to break up the hex-mesh silhouette
    // into organic fingers. Depth gradient now spans further so abyss
    // reads as truly deep blue, not flat cyan.
    float coastNoise = (fbm(vWorldNormal * 55.0) - 0.5) * 0.12;
    float seaCoord   = vElevation + coastNoise;
    float oceanMask  = 1.0 - smoothstep(-0.02, 0.05, seaCoord);

    if (oceanMask > 0.001) {
      vec3 coast   = vec3(0.55, 0.82, 0.88);   // shallow reef turquoise
      vec3 shelf   = vec3(0.18, 0.50, 0.74);   // continental shelf blue
      vec3 abyss   = vec3(0.02, 0.08, 0.22);   // deep abyss
      float d      = max(-seaCoord, 0.0);

      // Two-stage depth blend so we see a real shallow→shelf→abyss gradient
      float t1 = smoothstep(0.00, 0.08, d);    // coast → shelf
      float t2 = smoothstep(0.10, 0.45, d);    // shelf → abyss
      vec3 water = mix(coast, shelf, t1);
      water = mix(water, abyss, t2);

      // Subtle surface ripple — fbm at two scales.
      float ripple = ((fbm(vWorldNormal * 90.0) - 0.5) +
                      (fbm(vWorldNormal * 35.0) - 0.5) * 0.5) * 0.06;
      water = water * (1.0 + ripple);

      albedo = mix(albedo, water, oceanMask);
    }

    // ── Snow line: tight, decoupled from the SatMap noise field ─────────
    // Earth-realistic: base 30°C equator, ~6°C/km lapse, ~32°C cooling
    // equator-to-pole. The noise band on temperature is small so the
    // snow line stays a clear latitudinal feature; the SatMap noise stays
    // out of this calc to prevent random snow patches in temperate zones.
    float tempLand = 30.0
                   - max(vElevation, 0.0) * 6.0
                   - latNoisy * 32.0
                   + (fbmFine - 0.5) * 2.5;
    // Threshold well below freezing — snow only at high lat or extreme
    // elevation. Smooth band so the snow line itself looks natural.
    float snowMask = 1.0 - smoothstep(-6.0, -1.0, tempLand);
    snowMask *= (1.0 - oceanMask);
    // Even at full cold, cap how much white is laid down so we don't
    // pave the poles a single flat color.
    snowMask = min(snowMask, 0.85);
    albedo = mix(albedo, vec3(0.94, 0.94, 0.95), snowMask);

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
    albedo *= mix(0.78, 1.0, fakeAO);

    // ── Lighting: Lambert + rim + atmospheric scatter (Gemini point 9) ───
    vec3 N = normalize(vWorldNormal);
    vec3 L = normalize(uSunDir);
    vec3 V = normalize(cameraPosition - vWorldPos);

    float lambert = max(dot(N, L), 0.0);
    float viewAngle = max(dot(N, V), 0.0);
    float halo = pow(1.0 - viewAngle, 4.0);

    vec3 atmosphere = vec3(0.40, 0.62, 1.00);

    vec3 lit = albedo * (uAmbient + (1.0 - uAmbient) * lambert);

    // Limb / Rayleigh — only the actual silhouette gets atmospheric tint;
    // the rest of the planet keeps its true SatMap colors.
    lit = mix(lit, atmosphere, halo * 0.18);
    lit += atmosphere * halo * 0.20 * lambert;

    // Warm rim from chrome design tokens
    float rim = pow(1.0 - viewAngle, 2.0);
    lit += uRimColor * rim * 0.15;

    // ── ACES tone mapping (mandatory per Gemini point 8) ─────────────────
    vec3 toneMapped = aces(lit * 1.05);

    gl_FragColor = vec4(toneMapped, 1.0);
  }
`;
