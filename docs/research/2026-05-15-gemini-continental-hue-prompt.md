# Gemini Prompt — Continental Hue Diagnosis (Hayba Planet Shader)

> Copy everything below the line into Gemini (Deep Research / reasoning mode). Self-contained; the current shader is inlined as ground truth.

---

## ROLE

You are a senior real-time rendering + procedural-terrain engineer. Diagnose a specific, narrow failure — **continental surface HUE** — and prescribe a production-correct fix. Be decisive; challenge our hypotheses; tell us if our whole approach is wrong.

## CONTEXT (what changed since your last report)

We implemented your previous punch-list partially:
- **Color pipeline FIXED (confirmed working):** raw `THREE.ShaderMaterial` does not auto-convert color space, so we now `srgbToLinear()` every SatMap texture read at the single sample chokepoint, do all lighting/mixing in linear, and `linearToSrgb()` at output. **ACES deleted.** This part is correct and not in question.
- **Bullseye FIXED (confirmed):** base albedo no longer keyed on radial elevation; the contour rings are gone.
- **Lighting:** switched to a flat-lit soft-wrap term (Blue-Marble-style near-noon look): `lightTerm = 0.55 + 0.60*pow(clamp(dot(N,L)*0.5+0.5,0,1),1.2)`.

## THE REMAINING FAILURE (the only thing to solve here)

**Continents render as near-black charcoal with rust-orange coastal fringes and a grey mottle.** There is no Earth-like gradation — no tan, olive, sage, ochre, mid-green, brown. Real Blue-Marble continents (Africa, central Asia, North America) are *mid-brightness, low-saturation*, smoothly graded tan→yellow-green→green→brown. Ours looks like burnt charcoal with lava streaks. Desaturating/dark-lifting/exposure hacks only muddied it further (grey mud).

## THE SATMAP DATA MODEL (critical — likely the crux)

"SatMaps" are **256×1024 vertical 1-D gradient PNGs**, k-means-derived from NASA Blue Marble imagery paired with ETOPO1 DEM. **They were authored as ELEVATION RAMPS**: the bottom of the gradient ≈ low-elevation cover for that climate, the top ≈ high-elevation rock/snow. We sample one vertical column: `texture2D(tex, vec2(0.5, 1.0 - h))`. There are 25 of them, grouped by Köppen climate class:
`tropical_wet_*`, `tropical_dry_*`, `arid_hot_*`, `arid_cold_*`, `temperate_humid_*`, `temperate_med`, `continental_*`, `polar_tundra`, `polar_icecap`, plus oceanic ones. The shader currently uses only 4 (uSatTropical/uSatArid/uSatTemperate/uSatPolar) + a rock map.

## CURRENT SHADER — exact ground truth (reason against THIS)

```glsl
vec3 srgbToLinear(vec3 c){ return mix(c/12.92, pow((c+0.055)/1.055, vec3(2.4)), step(0.04045,c)); }
vec3 linearToSrgb(vec3 c){ c=clamp(c,0.,1.); return mix(c*12.92, 1.055*pow(c,vec3(1./2.4))-0.055, step(0.0031308,c)); }

// SatMaps are 1-D ELEVATION ramps. We sample by scalar h. (h is NO LONGER elevation — see below.)
vec3 sampleGradient(sampler2D tex, float h){
  return srgbToLinear(texture2D(tex, vec2(0.5, 1.0 - clamp(h,0.02,0.98))).rgb);
}

// fbm = 5-octave value-noise, ~[0,1]. vElevation: continents ~0..0.9, ocean negative.

// ---- biome block ----
vec3 warp = vec3(fbm(n*2.5+a), fbm(n*2.5+b), fbm(n*2.5+c));
float moisture = clamp(fbm(n*3.0 + warp*1.5)*0.65 + fbm(n*9.0)*0.35, 0.,1.);

float latCooling = abs(vWorldNormal.y);
float equivElev  = max(vElevation,0.)*0.7 + latCooling*1.4;
float temperature = 1.0 - clamp(equivElev + (fbm(n*12.0)-0.5)*0.15, 0.,1.);

// h drives the 1-D gradient ROW. It is a noise-dominated blend (NOT elevation):
float elevH  = clamp(max(vElevation,0.)*1.1, 0.,1.);
float detail = fbm(n*11.0)*0.55 + fbm(n*26.0)*0.45;
float h = clamp(0.28*elevH + 0.30*moisture + 0.42*detail, 0.02, 0.98);

// soft 4-way climate weights
float cold    = 1.0 - smoothstep(0.20,0.34, temperature);
float hot     = smoothstep(0.56,0.74, temperature);
float midTemp = clamp(1.0 - cold - hot, 0.,1.);
float wet     = smoothstep(0.42,0.60, moisture);
float wPolar=cold, wTemp=midTemp, wTrop=hot*wet, wArid=hot*(1.0-wet);
// normalize, then BLEND all four SatMaps at the same h:
vec3 base = sampleGradient(uSatTropical,h)*wTrop + sampleGradient(uSatArid,h)*wArid
          + sampleGradient(uSatTemperate,h)*wTemp + sampleGradient(uSatPolar,h)*wPolar;

// rock by slope, then beach, then ocean (Beer-Lambert scalar lerp, fine), then ice override.

// ---- lighting (after albedo) ----
albedo = mix(albedo, albedo*0.80 + 0.055, landMask);     // dark-lift hack
float ndl=dot(reliefNormal,L), wrap=clamp(ndl*0.5+0.5,0.,1.);
float lightTerm = 0.55 + 0.60*pow(wrap,1.2);
vec3 lit = albedo * lightTerm;
float luma=dot(lit,vec3(.2126,.7152,.0722));
lit = mix(vec3(luma), lit, 0.86) * 1.02;                  // desaturate hack
gl_FragColor = vec4(linearToSrgb(lit), 1.0);
```

## OUR HYPOTHESES (confirm / refute each, with reasoning)

- **H1 (suspected primary):** The SatMaps are 1-D **elevation** ramps, but we now index them by `h` = a moisture/noise blend that has *nothing to do with elevation*. So a wet cell samples the gradient's "high-elevation rock/snow" row and a dry cell samples the "low-elevation" row — **semantically inverted/scrambled**, producing wrong hues (the rust = arid map's mid rows, the charcoal = tropical/temperate map's dark rows sampled at the wrong place). The 1-D-elevation-ramp data model is fundamentally incompatible with biome-keyed sampling.
- **H2:** Blending FOUR different SatMaps' rows by soft weights **averages dissimilar hues → desaturated mud** (mixing tropical-green + arid-orange + temperate + polar at every fragment). Production uses discrete/dominant biome selection or splatting, not a 4-way average.
- **H3:** The dark-lift + desaturate + exposure post-hacks compound the muddiness and should be deleted once the real cause is fixed.
- **H4:** The fix is a true **multi-mask biome system**: distinct biome SatMaps, each painted only within its (temperature × humidity × elevation × slope) mask, composited by dominant-weight or splat — not a 1-D-row blend. Possibly the 1-D SatMaps should be re-authored or sampled differently (e.g., the vertical axis should encode *intra-biome* variation, and the *biome identity* must come from the mask, not the row).

## QUESTIONS

1. **Is H1 the primary cause?** Given 1-D elevation-ramp SatMaps, what is the correct way to produce Earth-like continental hue? Specifically: should `h` (the vertical sample coordinate) be driven by *within-biome elevation* (restoring the ramp's authored meaning) while *biome identity* comes purely from the mask selecting *which* SatMap — i.e., decouple "which SatMap" (biome mask) from "where in its gradient" (local elevation)? Or are 1-D elevation-ramp SatMaps the wrong asset entirely for this and we should move to 2-D (climate×moisture) lookups or per-biome flat albedos + detail?
2. **Is the 4-way weighted blend (H2) a muddiness source?** Prescribe the correct composite for soft biome boundaries that does NOT desaturate (dominant-biome / argmax with narrow crossfade? height-based splat? weighted but in a perceptual space?). Give the GLSL.
3. **Correct climate math (real units).** Give a scientifically defensible temperature model (latitude + elevation lapse, in °C) and a humidity proxy, and the Whittaker biome thresholds (in °C and relative precipitation) for: rainforest, tropical-seasonal/savanna, hot desert, temperate forest, temperate grassland/mediterranean, boreal/taiga, tundra, ice. We have ~25 SatMaps to map to these.
4. **Per-biome sampling.** For each biome's 1-D elevation-ramp SatMap, what should the vertical coordinate be so the hue reads correctly (lowland vs upland within that biome) without re-introducing the elevation contour rings we just eliminated?
5. **Validation.** We are adding debug "map modes" (visualize temperature, humidity, biome-class argmax, elevation, slope, masks). What specific visual tests confirm the science is right before we trust the composited render?
6. **Delete the hacks?** Confirm the dark-lift and desaturate steps should be removed once H1/H2 are fixed, or if a principled tone adjustment is still warranted for display-referred Blue-Marble-derived albedo.

## DELIVERABLE

For each question: decisive answer + reasoning + concrete GLSL/pseudocode against the data model above + whether it confirms/refutes our hypotheses. End with a strict dependency-ordered punch-list to get Earth-like continental hue. If the 1-D SatMap concept must be abandoned, say so explicitly and give the replacement.
