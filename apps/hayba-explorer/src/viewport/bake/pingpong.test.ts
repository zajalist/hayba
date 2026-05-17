// Run: npx tsx src/viewport/bake/pingpong.test.ts
//
// Pure-logic unit test for the reduced RGBA32F ping-pong module. There is
// NO headless WebGL in this repo, so this test only covers the parts
// callable without a real GL context:
//   1. decideFloatSupport(gl) — the float-capability probe, exercised via
//      an injected fake `{ getExtension }` context.
//   2. createPingPong — the extension-probing + RGBA32F RT-allocation shape,
//      exercised via a fake renderer + injected render-target factory. The
//      actual draw runs on the raw-WebGL2 runner (glPass.ts) at runtime.
import assert from "node:assert/strict";
import { decideFloatSupport, createPingPong } from "./pingpong";
import type { RenderTargetFactory } from "./pingpong";

// --- 1. decideFloatSupport: float-linear HARDENING ----------------------
// Fake ctx: has color-buffer-float, but NOT float-linear -> manualBilinear.
const ctxNoLinear = {
  getExtension(name: string) {
    if (name === "EXT_color_buffer_float") return {};
    if (name === "OES_texture_float_linear") return null;
    return null;
  },
};
const dNoLinear = decideFloatSupport(ctxNoLinear);
assert.equal(dNoLinear.ok32f, true, "color-buffer-float present");
assert.equal(
  dNoLinear.manualBilinear,
  true,
  "no OES_texture_float_linear -> manualBilinear",
);
assert.equal(dNoLinear.floatLinearOk, false);

// Fake ctx: both extensions present -> hardware linear, no manual bilinear.
const ctxBoth = {
  getExtension(name: string) {
    if (name === "EXT_color_buffer_float") return {};
    if (name === "OES_texture_float_linear") return {};
    return null;
  },
};
const dBoth = decideFloatSupport(ctxBoth);
assert.equal(dBoth.ok32f, true);
assert.equal(dBoth.manualBilinear, false, "linear ext present -> hw bilinear");
assert.equal(dBoth.floatLinearOk, true);

// Fake ctx: NO EXT_color_buffer_float -> hard fail (ok32f false).
const ctxNo32f = {
  getExtension(_name: string) {
    return null;
  },
};
const dNo32f = decideFloatSupport(ctxNo32f);
assert.equal(dNo32f.ok32f, false, "no color-buffer-float -> not ok");

// --- 2. createPingPong extension-probing + RT-alloc shape ----------------
// Minimal fake renderer whose getContext() returns our fake gl. We supply
// a fake render-target factory so no real WebGL is touched; the assertions
// cover the manualBilinear decision, the EXT_color_buffer_float hard guard,
// and the per-channel `rt[ch] = [slot0, slot1]` allocation shape that
// hydraulic.ts consumes (pp.rt.A / pp.rt.F).
function fakeRenderer(gl: { getExtension(n: string): unknown }) {
  return { getContext: () => gl } as unknown as import("three").WebGLRenderer;
}
const fakeRtFactory: RenderTargetFactory = (_w, _h, _opts) =>
  ({ dispose() {} }) as unknown as import("three").WebGLRenderTarget;

const ppNoLinear = createPingPong(
  fakeRenderer(ctxNoLinear),
  16,
  16,
  ["A", "F"],
  fakeRtFactory,
);
assert.equal(
  ppNoLinear.manualBilinear,
  true,
  "createPingPong: no float-linear -> manualBilinear true",
);
// RT-alloc shape: one [slot0, slot1] pair per requested channel.
assert.deepEqual(
  Object.keys(ppNoLinear.rt).sort(),
  ["A", "F"],
  "createPingPong allocates one RT pair per channel",
);
assert.equal(ppNoLinear.rt.A.length, 2, "channel A is a [slot0, slot1] pair");
assert.equal(ppNoLinear.rt.F.length, 2, "channel F is a [slot0, slot1] pair");
assert.equal(typeof ppNoLinear.dispose, "function", "dispose() present");

const ppBoth = createPingPong(
  fakeRenderer(ctxBoth),
  16,
  16,
  ["A", "F"],
  fakeRtFactory,
);
assert.equal(
  ppBoth.manualBilinear,
  false,
  "createPingPong: float-linear -> manualBilinear false",
);

// Absence of EXT_color_buffer_float must hard-fail with a clear Error.
assert.throws(
  () =>
    createPingPong(fakeRenderer(ctxNo32f), 16, 16, ["A"], fakeRtFactory),
  /RGBA32F render targets unsupported \(EXT_color_buffer_float\)/,
  "missing EXT_color_buffer_float must throw a clear Error",
);

console.log("ok");
