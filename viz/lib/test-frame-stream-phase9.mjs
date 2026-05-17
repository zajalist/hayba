// Standalone smoke test for Phase 9 frame-stream decoder extensions.
// Run: node viz/lib/test-frame-stream-phase9.mjs
//
// Hand-builds binary payloads matching the Rust encoder in
// packages/hayba-tectonics-v2/src/frame_stream/mod.rs and asserts that the
// JS decoder recovers the values within the quantization tolerance.

import {
  TAGS,
  ByteReader,
  applyFrame,
  decodeFloat16,
  dequantizeTemperatureK,
  dequantizeUnit,
  dequantizeRiverFlow,
} from "./frame-stream.js";

let passed = 0;
let failed = 0;

function assert(cond, msg) {
  if (cond) {
    passed++;
    console.log(`  ok  ${msg}`);
  } else {
    failed++;
    console.error(`  FAIL ${msg}`);
  }
}

function approx(a, b, tol, msg) {
  assert(Math.abs(a - b) <= tol, `${msg} (a=${a} b=${b} tol=${tol})`);
}

// Build a synthetic state minimal enough for applyFrame to run.
function makeState() {
  return {
    cell_plate: new Uint32Array(4),
    cell_elevation_m: new Int16Array(4),
    cell_composition: new Uint8Array(4),
    cell_rift_progress: new Uint8Array(4),
    cell_failed_rift_age_ma: new Uint16Array(4),
    cell_lip_age_ma: new Uint16Array(4),
    cell_volcanic_act: new Uint8Array(4),
    cell_age_ma: new Uint16Array(4),
    plates: [],
    mors: [],
    lip_bursts: [],
    boundary_polylines: [],
    events_this_frame: {
      spawns: [], deaths: [], passive_splits: [], failed_rifts: [], lip_bursts: [],
    },
    spawn_count: 0, death_count: 0, passive_split_count: 0, failed_rift_count: 0,
  };
}

// Wrap a tag payload into a frame record: u32 frame_idx | u32 payload_len | payload.
function frameRecord(payloadBytes) {
  const buf = new Uint8Array(8 + payloadBytes.length);
  const dv = new DataView(buf.buffer);
  dv.setUint32(0, 0, true);                       // frame_idx
  dv.setUint32(4, payloadBytes.length, true);     // payload_len
  buf.set(payloadBytes, 8);
  return buf;
}

function runApply(payloadBytes) {
  const state = makeState();
  const rec = frameRecord(payloadBytes);
  const reader = new ByteReader(rec.buffer, rec.byteOffset, rec.byteLength);
  applyFrame(state, reader);
  return state;
}

// Rust-side encoders (reimplemented in JS for the test fixture).
function quantizeTemperatureK(t) {
  const v = Math.round((t - 200.0) / 0.5);
  return Math.max(0, Math.min(255, v));
}
function quantizeUnit(v) {
  return Math.max(0, Math.min(255, Math.round(Math.max(0, Math.min(1, v)) * 255)));
}
function quantizeRiverFlow(f) {
  const v = Math.round(Math.log2(Math.max(0, f) + 1.0) * 1024.0);
  return Math.max(0, Math.min(0xFFFF, v));
}
function f32ToF16Bits(val) {
  const f32 = new Float32Array(1);
  const u32 = new Uint32Array(f32.buffer);
  f32[0] = val;
  const x = u32[0];
  const sign = (x >>> 16) & 0x8000;
  let mant = x & 0x7fffff;
  let exp = (x >>> 23) & 0xff;
  if (exp === 0xff) return sign | 0x7c00 | (mant ? 1 : 0);
  exp = exp - 127 + 15;
  if (exp >= 31) return sign | 0x7c00;
  if (exp <= 0) {
    if (exp < -10) return sign;
    mant = (mant | 0x800000) >>> (1 - exp);
    if (mant & 0x1000) mant += 0x2000;
    return sign | (mant >>> 13);
  }
  if (mant & 0x1000) {
    mant += 0x2000;
    if (mant & 0x800000) { mant = 0; exp += 1; if (exp >= 31) return sign | 0x7c00; }
  }
  return sign | (exp << 10) | (mant >>> 13);
}

function bytesFromParts(parts) {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}
const u8 = (v) => new Uint8Array([v & 0xff]);
const u16le = (v) => { const b = new Uint8Array(2); new DataView(b.buffer).setUint16(0, v & 0xffff, true); return b; };
const u32le = (v) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, v >>> 0, true); return b; };
const f32le = (v) => { const b = new Uint8Array(4); new DataView(b.buffer).setFloat32(0, v, true); return b; };

console.log("Phase 9 decoder smoke tests:");

// 1. Temperature
{
  const temps = [200.0, 250.5, 287.3, 327.9, 400.0];
  const payload = bytesFromParts([
    u8(TAGS.CELL_TEMPERATURE_K),
    u32le(temps.length),
    ...temps.map((t) => u8(quantizeTemperatureK(t))),
  ]);
  const s = runApply(payload);
  assert(s.cell_temperature_k instanceof Float32Array, "cell_temperature_k is Float32Array");
  assert(s.cell_temperature_k.length === 5, "temperature length matches");
  for (let i = 0; i < temps.length; i++) {
    const want = Math.min(Math.max(temps[i], 200.0), 200.0 + 255 * 0.5);
    approx(s.cell_temperature_k[i], want, 0.5, `temp[${i}] roundtrip`);
  }
}

// 2. Humidity
{
  const vals = [0.0, 0.25, 0.5, 0.75, 1.0];
  const payload = bytesFromParts([
    u8(TAGS.CELL_HUMIDITY), u32le(vals.length),
    ...vals.map((v) => u8(quantizeUnit(v))),
  ]);
  const s = runApply(payload);
  for (let i = 0; i < vals.length; i++) approx(s.cell_humidity[i], vals[i], 0.5/255 + 1e-6, `humidity[${i}]`);
}

// 3. Biome
{
  const biomes = [0, 1, 7, 42, 255];
  const payload = bytesFromParts([
    u8(TAGS.CELL_BIOME_ID), u32le(biomes.length), new Uint8Array(biomes),
  ]);
  const s = runApply(payload);
  assert(s.cell_biome_id instanceof Uint8Array, "biome is Uint8Array");
  for (let i = 0; i < biomes.length; i++) assert(s.cell_biome_id[i] === biomes[i], `biome[${i}]=${biomes[i]}`);
}

// 4. River flow
{
  const flows = [0.0, 1.0, 10.0, 1000.0, 1e6];
  const payload = bytesFromParts([
    u8(TAGS.CELL_RIVER_FLOW), u32le(flows.length),
    ...flows.map((f) => u16le(quantizeRiverFlow(f))),
  ]);
  const s = runApply(payload);
  for (let i = 0; i < flows.length; i++) {
    const tol = Math.max(flows[i], 1.0) * (Math.pow(2, 1/1024) - 1) + 1e-3;
    approx(s.cell_river_flow[i], flows[i], tol, `river_flow[${i}]`);
  }
}

// 5. Lake mask
{
  const mask = [true, false, true, true, false, false, false, true, true, false, true];
  const n_bytes = (mask.length + 7) >> 3;
  const bits = new Uint8Array(n_bytes);
  for (let i = 0; i < mask.length; i++) if (mask[i]) bits[i >> 3] |= 1 << (i & 7);
  const payload = bytesFromParts([
    u8(TAGS.CELL_LAKE_MASK), u32le(mask.length), bits,
  ]);
  const s = runApply(payload);
  assert(s.cell_lake_mask.length === mask.length, "lake mask length");
  for (let i = 0; i < mask.length; i++) assert(!!s.cell_lake_mask[i] === mask[i], `lake_mask[${i}]`);
}

// 6. Snow
{
  const vals = [0.0, 0.5, 1.0];
  const payload = bytesFromParts([
    u8(TAGS.CELL_SNOW_COVER), u32le(vals.length), ...vals.map((v) => u8(quantizeUnit(v))),
  ]);
  const s = runApply(payload);
  for (let i = 0; i < vals.length; i++) approx(s.cell_snow_cover[i], vals[i], 0.5/255 + 1e-6, `snow[${i}]`);
}

// 7. Ocean current vec
{
  const vecs = [[0,0,0], [1,-1,0.5], [3.14, 2.71, -0.001]];
  const parts = [u8(TAGS.CELL_OCEAN_CURRENT_VEC), u32le(vecs.length)];
  for (const v of vecs) for (const c of v) parts.push(u16le(f32ToF16Bits(c)));
  const payload = bytesFromParts(parts);
  const s = runApply(payload);
  assert(s.cell_ocean_current_vec.length === vecs.length * 3, "ocean vec length");
  for (let i = 0; i < vecs.length; i++) {
    for (let k = 0; k < 3; k++) {
      const want = vecs[i][k];
      const tol = Math.abs(want) * 1.5e-3 + 2e-3;
      approx(s.cell_ocean_current_vec[i*3+k], want, tol, `ocean[${i}][${k}]`);
    }
  }
}

// 8. Plume track point
{
  const payload = bytesFromParts([
    u8(TAGS.PLUME_TRACK_POINT), u32le(7), u32le(1234), u16le(250),
  ]);
  const s = runApply(payload);
  assert(s.plume_track_points.length === 1, "plume track point recorded");
  const p = s.plume_track_points[0];
  assert(p.plume_id === 7 && p.cell === 1234 && p.age_ma === 250, "plume fields");
}

// 9. Crust layer stack
{
  const stacks = [[[0,100],[1,250]], [], [[2,7000],[3,1234],[4,65535]]];
  const parts = [u8(TAGS.CRUST_LAYER_STACK), u32le(stacks.length)];
  for (const layers of stacks) {
    parts.push(u8(layers.length));
    for (const [r, t] of layers) { parts.push(u8(r)); parts.push(u16le(t)); }
  }
  const payload = bytesFromParts(parts);
  const s = runApply(payload);
  assert(s.cell_crust_stack.length === 3, "crust stack n_cells");
  assert(s.cell_crust_stack[0].length === 2 && s.cell_crust_stack[1].length === 0 && s.cell_crust_stack[2].length === 3, "crust stack per-cell lengths");
  assert(s.cell_crust_stack[2][2].rock_id === 4 && s.cell_crust_stack[2][2].thickness_m === 65535, "crust deepest layer");
}

// 10. SIM_TIME_MA
{
  const era = "Cretaceous";
  const eraBytes = new TextEncoder().encode(era);
  const payload = bytesFromParts([
    u8(TAGS.SIM_TIME_MA), f32le(123.5), u16le(eraBytes.length), eraBytes,
  ]);
  const s = runApply(payload);
  approx(s.sim_time_ma, 123.5, 1e-4, "sim_time_ma");
  assert(s.sim_era === era, `sim_era="${s.sim_era}"`);
}

// 11. decodeFloat16 helper smoke
{
  assert(decodeFloat16(f32ToF16Bits(1.0)) === 1.0, "decodeFloat16(1.0)");
  assert(decodeFloat16(0) === 0, "decodeFloat16(0)");
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
