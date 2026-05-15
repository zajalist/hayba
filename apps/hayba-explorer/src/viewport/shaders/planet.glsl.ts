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

  void main() {
    float h = max(elevation, 0.0);
    vec3  displaced = position * (1.0 + h * 0.08 * uExaggeration);

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

    gl_Position = projectionMatrix * modelViewMatrix * vec4(displaced, 1.0);
  }
`;

export const FRAGMENT_SHADER = /* glsl */ `
  uniform sampler2D uSatMap;
  uniform vec3      uSunDir;
  uniform float     uAmbient;
  uniform vec3      uRimColor;
  uniform vec3      uOceanColor;
  uniform float     uShowPlateOutlines;
  uniform float     uShowBoundaryGlow;

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

  void main() {
    // 1. Base albedo from SatMap (x = normalized elevation, y = slope)
    float h = clamp(vElevation * 0.5 + 0.5, 0.0, 1.0);
    vec3  albedo = texture2D(uSatMap, vec2(h, vSlope)).rgb;

    // 2. Ocean clip — flat ocean below sea level
    if (vElevation < 0.0) {
      albedo = mix(uOceanColor, albedo, smoothstep(-0.05, 0.0, vElevation));
    }

    // 3. Continental brightness boost (+10%)
    if (vContinental > 0.5) albedo *= 1.10;

    // 4. Crust age fade for oceanic crust (older = darker blue)
    if (vContinental < 0.5) {
      float ageFactor = clamp(vCrustAge / 200.0, 0.0, 1.0);
      albedo *= mix(1.0, 0.75, ageFactor);
    }

    // 5. MOR new-cell brightness (cyan-blue, lerps out over 30 steps)
    float morT = clamp(1.0 - vMorAgeSteps / 30.0, 0.0, 1.0);
    if (morT > 0.001) {
      vec3 morColor = vec3(0.50, 0.78, 1.00);
      albedo = mix(albedo, morColor, morT * 0.6);
    }

    // 6. Active-boundary effects (gated by uShowBoundaryGlow)
    if (uShowBoundaryGlow > 0.5) {
      // 6a. Subduction (kind == 1): hot orange scaled by (1 - progress)
      if (vCollisionKind > 0.5 && vCollisionKind < 1.5) {
        vec3 hot = vec3(0.95, 0.40, 0.15);
        float t = (1.0 - vSubductionProgress) * 0.65;
        albedo = mix(albedo, hot, t);
      }
      // 6b. Orogeny (kind == 2): warm red-brown scaled by uplift
      else if (vCollisionKind > 1.5 && vCollisionKind < 2.5) {
        vec3 rb = vec3(0.78, 0.32, 0.20);
        albedo = mix(albedo, rb, vOrogenicUplift * 0.55);
      }
      // 6c. Buffer kill (kind == 3): dim grey flash
      else if (vCollisionKind > 2.5 && vCollisionKind < 3.5) {
        albedo = mix(albedo, vec3(0.15), 0.7);
      }
    }

    // 7. Volcanic arc glow (additive)
    if (vVolcanicIntensity > 0.01) {
      albedo += vec3(1.0, 0.55, 0.15) * vVolcanicIntensity * 0.4;
    }

    // 8. Plate outline pass — fwidth derivative across the triangle catches
    //    inter-plate seams (plateId jumps).
    if (uShowPlateOutlines > 0.5) {
      float edge = step(0.001, fwidth(vPlateId));
      albedo *= mix(1.0, 0.82, edge);
    }

    // 9. Lighting — Lambert + warm rim
    float lambert = max(dot(vWorldNormal, normalize(uSunDir)), 0.0);
    float rim     = pow(1.0 - max(dot(vWorldNormal, vec3(0,0,1)), 0.0), 2.0);
    vec3  lit     = albedo * (uAmbient + (1.0 - uAmbient) * lambert) + uRimColor * rim * 0.25;

    gl_FragColor = vec4(lit, 1.0);
  }
`;
