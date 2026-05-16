// Run: npx tsx src/viewport/bake/pingpong.test.ts
//
// Pure-logic unit test for the RGBA32F ping-pong framework (Task A12).
// There is NO headless WebGL in this repo, so this test only covers the
// parts callable without a real GL context:
//   1. PingPongBook  — per-channel read/write index bookkeeping (pure swap).
//   2. decideFloatSupport(gl) — the extension-probing branch of
//      createPingPong, exercised via an injected fake `{ getExtension }`
//      context. The GL allocation / runPass paths are verified later by the
//      A18 parity harness.
import assert from "node:assert/strict";
import {
  PingPongBook,
  decideFloatSupport,
  createPingPong,
} from "./pingpong";
import type { RenderTargetFactory } from "./pingpong";

// --- 1. PingPongBook pure swap logic (spec A12 Step 1) -------------------
const bk = new PingPongBook(["h", "water", "sed"]);
assert.equal(bk.read("h"), 0);
bk.swap("h");
assert.equal(bk.read("h"), 1);
bk.swap("h");
assert.equal(bk.read("h"), 0);
assert.equal(bk.read("water"), 0, "channels swap independently");

// write() is the opposite of read()
assert.equal(bk.write("h"), 1, "write is opposite of read");
bk.swap("water");
assert.equal(bk.read("water"), 1);
assert.equal(bk.write("water"), 0);
assert.equal(bk.read("h"), 0, "swapping water does not move h");

// unknown channel must fail loudly
assert.throws(() => bk.read("nope"), /unknown ping-pong channel/);

// --- 2. decideFloatSupport: float-linear HARDENING ----------------------
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

// --- 3. createPingPong extension-probing branch (injected fake ctx) ------
// Minimal fake renderer whose getContext() returns our fake gl. We supply
// a fake render-target factory so no real WebGL is touched; the assertion
// is purely about the manualBilinear decision + the EXT_color_buffer_float
// hard guard.
function fakeRenderer(gl: { getExtension(n: string): unknown }) {
  return { getContext: () => gl } as unknown as import("three").WebGLRenderer;
}
const fakeRtFactory: RenderTargetFactory = (_w, _h, _opts) =>
  ({ dispose() {} }) as unknown as import("three").WebGLRenderTarget;

const ppNoLinear = createPingPong(
  fakeRenderer(ctxNoLinear),
  16,
  16,
  ["h"],
  fakeRtFactory,
);
assert.equal(
  ppNoLinear.manualBilinear,
  true,
  "createPingPong: no float-linear -> manualBilinear true",
);

const ppBoth = createPingPong(
  fakeRenderer(ctxBoth),
  16,
  16,
  ["h"],
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
    createPingPong(fakeRenderer(ctxNo32f), 16, 16, ["h"], fakeRtFactory),
  /RGBA32F render targets unsupported \(EXT_color_buffer_float\)/,
  "missing EXT_color_buffer_float must throw a clear Error",
);

console.log("ok");
