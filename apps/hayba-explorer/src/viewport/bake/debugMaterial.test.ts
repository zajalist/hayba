// Run: npx tsx src/viewport/bake/debugMaterial.test.ts
//
// Task A17: pure (no-GL) factory test for the equirect relief debug
// material. Asserts the factory returns a THREE.ShaderMaterial with the
// documented uniforms (uHeight + the h0/h_final map-mode toggle) so A19
// can eyeball erosion-vs-no-erosion on a debug globe.

import assert from "node:assert/strict";
import * as THREE from "three";
import {
  makeDebugReliefMaterial,
  setDebugTexture,
  setDebugMapMode,
} from "./debugMaterial";

const m = makeDebugReliefMaterial();

// Spec Step 1: a THREE.ShaderMaterial with a uHeight uniform that has a
// `value` slot.
assert.ok(m instanceof THREE.ShaderMaterial, "is a THREE.ShaderMaterial");
assert.ok(
  m.uniforms.uHeight && "value" in m.uniforms.uHeight,
  "uHeight uniform with a value slot",
);

// h0/h_final map-mode toggle: a second bound texture (uHeight0) + a mode
// uniform so A19 can flip between the eroded (h_final) and no-erosion
// (h0) views on the same debug globe.
assert.ok(
  m.uniforms.uHeight0 && "value" in m.uniforms.uHeight0,
  "uHeight0 (h0/no-erosion) uniform with a value slot",
);
assert.ok(
  m.uniforms.uMapMode && "value" in m.uniforms.uMapMode,
  "uMapMode toggle uniform with a value slot",
);

// No backticks in the GLSL strings (the .glsl.ts template footgun).
assert.ok(
  !m.vertexShader.includes("`") && !m.fragmentShader.includes("`"),
  "GLSL contains no backticks",
);

// Helper: setDebugTexture binds h_final (+ optional h0) onto the uniforms.
const hFinal = new THREE.DataTexture(
  new Float32Array(4),
  1,
  1,
  THREE.RGBAFormat,
  THREE.FloatType,
);
const h0 = new THREE.DataTexture(
  new Float32Array(4),
  1,
  1,
  THREE.RGBAFormat,
  THREE.FloatType,
);
setDebugTexture(m, hFinal, h0);
assert.equal(m.uniforms.uHeight.value, hFinal, "h_final bound to uHeight");
assert.equal(m.uniforms.uHeight0.value, h0, "h0 bound to uHeight0");

// h0 is optional — when omitted, both slots fall back to h_final so the
// toggle still renders something instead of a black texture.
setDebugTexture(m, hFinal);
assert.equal(m.uniforms.uHeight.value, hFinal, "h_final bound to uHeight");
assert.equal(
  m.uniforms.uHeight0.value,
  hFinal,
  "uHeight0 falls back to h_final when h0 omitted",
);

// Helper: setDebugMapMode flips the toggle.
setDebugMapMode(m, 1);
assert.equal(m.uniforms.uMapMode.value, 1, "map mode set to 1 (h0 view)");
setDebugMapMode(m, 0);
assert.equal(m.uniforms.uMapMode.value, 0, "map mode set to 0 (h_final view)");

console.log("ok");
