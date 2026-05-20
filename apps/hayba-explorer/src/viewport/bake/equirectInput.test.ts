// Run: npx tsx src/viewport/bake/equirectInput.test.ts
import { strict as assert } from "node:assert";
import * as THREE from "three";
import { uploadEquirect } from "./equirectInput";

const w = 4, h = 2;
const arr = new Float32Array([1,2,3,4,5,6,7,8]); // w*h
const tex = uploadEquirect(arr, w, h);
assert.ok(tex instanceof THREE.DataTexture);
assert.equal(tex.image.width, w);
assert.equal(tex.image.height, h);
assert.equal(tex.type, THREE.FloatType);
assert.equal(tex.format, THREE.RGBAFormat);
assert.equal(tex.magFilter, THREE.NearestFilter);
assert.equal(tex.minFilter, THREE.NearestFilter);
assert.equal(tex.flipY, false);
// channel-0 carries the value, others 0
const d = tex.image.data as unknown as Float32Array;
assert.equal(d.length, w*h*4);
assert.equal(d[0], 1); assert.equal(d[1], 0); assert.equal(d[4], 2);
console.log("ok");
