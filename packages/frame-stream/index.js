// viz/lib/frame-stream.js
// JavaScript binary delta-stream decoder for the Hayba tectonic viewer.
// Mirrors the Rust encoder (Task A1). See:
//   docs/superpowers/specs/2026-05-12-animation-backbone-sprint.md
//
// All multi-byte integers are little-endian. Tags are single bytes.

export const TAGS = Object.freeze({
  CELL_PLATE:   0x01,
  CELL_ELEV:    0x02,
  CELL_COMP:    0x03,
  CELL_RIFT:    0x04,
  CELL_FAILED:  0x05,
  CELL_LIP:     0x06,
  CELL_VOLC:    0x07,
  CELL_AGE_MA:  0x08,
  // Phase 9 climate / crust / plume tags (v2 encoder).
  CELL_TEMPERATURE_K:    0x09,
  CELL_HUMIDITY:         0x0A,
  CELL_BIOME_ID:         0x0B,
  CELL_RIVER_FLOW:       0x0C,
  CELL_LAKE_MASK:        0x0D,
  CELL_SNOW_COVER:       0x0E,
  CELL_OCEAN_CURRENT_VEC:0x0F,
  PLATE_SPAWN:  0x10,
  PLATE_RETIRE: 0x11,
  PLATE_MOTION: 0x12,
  PLATE_SEED:   0x13,
  PLATE_DEATH:  0x14,
  PLATE_PASSIVE_SPLIT: 0x15,
  FAILED_RIFT:  0x16,
  PLUME_TRACK_POINT:   0x17,
  CRUST_LAYER_STACK:   0x18,
  MOR_SPAWN:    0x20,
  MOR_RETIRE:   0x21,
  BOUNDARY_POLYLINES: 0x30,
  KEYFRAME:     0x40,
  SIM_TIME_MA:  0x41,
});

// Phase 9 quantization mirrors (must match Rust frame_stream/mod.rs).
const TEMP_K_MIN = 200.0;
const TEMP_K_STEP = 0.5;
export function dequantizeTemperatureK(q) { return TEMP_K_MIN + q * TEMP_K_STEP; }
export function dequantizeUnit(q) { return q / 255.0; }
export function dequantizeRiverFlow(q) { return Math.pow(2, q / 1024.0) - 1.0; }

/**
 * Decode an IEEE 754 binary16 (half-float) from a u16 bit pattern.
 * Standalone helper — same algorithm as the internal readF16 reader below.
 */
export function decodeFloat16(u) {
  const sign = (u >> 15) & 0x1;
  const exp = (u >> 10) & 0x1f;
  const mant = u & 0x3ff;
  let value;
  if (exp === 0) {
    value = mant === 0 ? 0 : (mant / 1024.0) * Math.pow(2, -14);
  } else if (exp === 31) {
    value = mant === 0 ? Infinity : NaN;
  } else {
    value = (1 + mant / 1024.0) * Math.pow(2, exp - 15);
  }
  return sign ? -value : value;
}

// IEEE binary16 (half-float) decode. JS has no native f16, so we unpack the
// 16-bit pattern manually. Used by the 0x30 BOUNDARY_POLYLINES record.
function readF16(reader) {
  const u = reader.u16();
  const sign = (u >> 15) & 0x1;
  const exp = (u >> 10) & 0x1f;
  const mant = u & 0x3ff;
  let value;
  if (exp === 0) {
    value = mant === 0 ? 0 : (mant / 1024.0) * Math.pow(2, -14);
  } else if (exp === 31) {
    value = mant === 0 ? Infinity : NaN;
  } else {
    value = (1 + mant / 1024.0) * Math.pow(2, exp - 15);
  }
  return sign ? -value : value;
}

// Per-tag payload sizes for fixed-size tags. Used by tolerance/clamp logic
// when a payload claims to be shorter than the canonical size. Variable-size
// tags (PLATE_SPAWN, MOR_SPAWN, BOUNDARY_POLYLINES, KEYFRAME) are not listed here.
const TAG_PAYLOAD_SIZE = Object.freeze({
  [0x01]: 8,  // u32 idx + u32 new_plate
  [0x02]: 6,  // u32 idx + i16 elev
  [0x03]: 5,  // u32 idx + u8 comp
  [0x04]: 5,  // u32 idx + u8 rift
  [0x05]: 6,  // u32 idx + u16 failed_age
  [0x06]: 6,  // u32 idx + u16 lip_age
  [0x07]: 5,  // u32 idx + u8 volc
  [0x08]: 6,  // u32 idx + u16 age_ma
  [0x11]: 4,  // u32 id
  [0x12]: 16, // u32 id + 3 f32 omega
  [0x13]: 16, // u32 id + 3 f32 seed
  [0x14]: 5,  // u32 plate_id + u8 reason
  [0x15]: 8,  // u32 parent_id + u32 child_id
  [0x16]: 8,  // u32 plate_id + u32 cell
  [0x17]: 10, // u32 plume_id + u32 cell + u16 age_ma
  [0x21]: 4,  // u32 id
});

const MAGIC = [0x48, 0x41, 0x59, 0x42, 0x41]; // "HAYBA"
const PLATE_PARENT_NONE = 0xFFFFFFFF;

// -----------------------------------------------------------------------------
// ByteReader — little-endian DataView wrapper with a moving cursor.
// -----------------------------------------------------------------------------
export class ByteReader {
  /**
   * @param {ArrayBuffer|Uint8Array|DataView} source
   * @param {number} [byteOffset]
   * @param {number} [byteLength]
   */
  constructor(source, byteOffset = 0, byteLength) {
    let buffer, offset, length;
    if (source instanceof ArrayBuffer) {
      buffer = source;
      offset = byteOffset;
      length = byteLength ?? (source.byteLength - byteOffset);
    } else if (source instanceof Uint8Array) {
      buffer = source.buffer;
      offset = source.byteOffset + byteOffset;
      length = byteLength ?? (source.byteLength - byteOffset);
    } else if (source instanceof DataView) {
      buffer = source.buffer;
      offset = source.byteOffset + byteOffset;
      length = byteLength ?? (source.byteLength - byteOffset);
    } else {
      throw new TypeError("ByteReader: unsupported source type");
    }
    this.view = new DataView(buffer, offset, length);
    this.buffer = buffer;
    this.baseOffset = offset;
    this.byteLength = length;
    this.pos = 0;
  }

  get remaining() {
    return this.byteLength - this.pos;
  }

  /** Absolute byte offset into the underlying ArrayBuffer. */
  get absolutePos() {
    return this.baseOffset + this.pos;
  }

  u8() {
    const v = this.view.getUint8(this.pos);
    this.pos += 1;
    return v;
  }
  u16() {
    const v = this.view.getUint16(this.pos, true);
    this.pos += 2;
    return v;
  }
  u32() {
    const v = this.view.getUint32(this.pos, true);
    this.pos += 4;
    return v;
  }
  i16() {
    const v = this.view.getInt16(this.pos, true);
    this.pos += 2;
    return v;
  }
  i32() {
    const v = this.view.getInt32(this.pos, true);
    this.pos += 4;
    return v;
  }
  f32() {
    const v = this.view.getFloat32(this.pos, true);
    this.pos += 4;
    return v;
  }

  /**
   * Returns a Uint8Array VIEW (not a copy) of n bytes starting at the cursor,
   * and advances the cursor. Callers that need ownership should `.slice()`.
   */
  bytes(n) {
    const v = new Uint8Array(this.buffer, this.baseOffset + this.pos, n);
    this.pos += n;
    return v;
  }

  skip(n) {
    this.pos += n;
  }

  seekTo(pos) {
    this.pos = pos;
  }
}

// -----------------------------------------------------------------------------
// Header
// -----------------------------------------------------------------------------
export function parseHeader(reader) {
  const magic = reader.bytes(5);
  for (let i = 0; i < 5; i++) {
    if (magic[i] !== MAGIC[i]) {
      throw new Error(
        `parseHeader: bad magic. expected "HAYBA", got [${Array.from(magic).join(",")}]`
      );
    }
  }
  const version = reader.u8();
  reader.skip(2); // 2 pad bytes -> brings us to byte 8
  const total_frames = reader.u32();
  const n_cells = reader.u32();
  const dt_ma = reader.u32();
  const keyframe_stride = reader.u32();
  const master_seed = reader.u32();
  // Phase 10.1: last u32 of header is now `divisions: u16` + reserved u16.
  // Older streams emit 0 in this slot — treat 0 as "unknown" and let the
  // consumer fall back to deriving it from n_cells (10·d² + 2 → d).
  const divisions = reader.u16();
  reader.skip(2); // reserved u16 -> header still 32 bytes
  return {
    version,
    total_frames,
    n_cells,
    dt_ma,
    keyframe_stride,
    master_seed,
    divisions,
  };
}

// -----------------------------------------------------------------------------
// Typed-array readers (always COPY out of the underlying buffer).
// -----------------------------------------------------------------------------
function readU8Array(reader, n) {
  // Slice produces a fresh ArrayBuffer of exactly n bytes.
  return reader.bytes(n).slice();
}
function readU16Array(reader, n) {
  const bytes = reader.bytes(n * 2).slice();
  return new Uint16Array(bytes.buffer);
}
function readU32Array(reader, n) {
  const bytes = reader.bytes(n * 4).slice();
  return new Uint32Array(bytes.buffer);
}
function readI16Array(reader, n) {
  const bytes = reader.bytes(n * 2).slice();
  return new Int16Array(bytes.buffer);
}

// -----------------------------------------------------------------------------
// Plate / MOR blocks
// -----------------------------------------------------------------------------
function parsePlateBlock(reader) {
  const id = reader.u32();
  const parent_raw = reader.u32();
  const parent_id = parent_raw === PLATE_PARENT_NONE ? null : parent_raw;
  const color = [reader.u8(), reader.u8(), reader.u8()];
  const seed_pos = [reader.f32(), reader.f32(), reader.f32()];
  const omega = [reader.f32(), reader.f32(), reader.f32()];
  const birth_step = reader.u32();
  return { id, parent_id, color, seed_pos, omega, birth_step };
}

function parseMorBlock(reader) {
  const id = reader.u32();
  const flank_a = reader.u32();
  const flank_b = reader.u32();
  const spreading_rate = reader.f32();
  const n_axis = reader.u16();
  const axis = new Float32Array(n_axis * 3);
  for (let i = 0; i < n_axis * 3; i++) axis[i] = reader.f32();
  const n_seg = reader.u16();
  const segments = new Float32Array(n_seg * 3);
  for (let i = 0; i < n_seg * 3; i++) segments[i] = reader.f32();
  return { id, flank_a, flank_b, spreading_rate, axis, segments };
}

// -----------------------------------------------------------------------------
// Initial state / keyframe snapshot
// -----------------------------------------------------------------------------
export function parseInitialState(reader, n_cells) {
  const cell_plate            = readU32Array(reader, n_cells);
  const cell_elevation_m      = readI16Array(reader, n_cells);
  const cell_composition      = readU8Array(reader, n_cells);
  const cell_rift_progress    = readU8Array(reader, n_cells);
  const cell_failed_rift_age_ma = readU16Array(reader, n_cells);
  const cell_lip_age_ma       = readU16Array(reader, n_cells);
  const cell_volcanic_act     = readU8Array(reader, n_cells);
  const cell_age_ma           = readU16Array(reader, n_cells);

  const n_plates = reader.u32();
  const plates = new Array(n_plates);
  for (let i = 0; i < n_plates; i++) plates[i] = parsePlateBlock(reader);

  const n_mors = reader.u32();
  const mors = new Array(n_mors);
  for (let i = 0; i < n_mors; i++) mors[i] = parseMorBlock(reader);

  return {
    cell_plate,
    cell_elevation_m,
    cell_composition,
    cell_rift_progress,
    cell_failed_rift_age_ma,
    cell_lip_age_ma,
    cell_volcanic_act,
    cell_age_ma,
    plates,
    mors,
    // Most recent LIP burst events for the frame just applied. Cleared at
    // the start of each applyFrame() call. Consumers may use this to render
    // burst visuals; tag 0x30 records the burst metadata only — actual cell
    // updates arrive via tag 0x06 (cell_lip_age_ma) in the same payload.
    lip_bursts: [],
    // Per-frame boundary polylines decoded from 0x30 records. The encoder
    // replaces this on every frame; the array stays `[]` until the first
    // 0x30 lands (older world.bin streams without 0x30 keep it empty, and
    // downstream renderers handle the empty case).
    boundary_polylines: [],
    // Per-frame transient event lists, reset at start of every applyFrame().
    events_this_frame: {
      spawns: [],
      deaths: [],
      passive_splits: [],
      failed_rifts: [],
      lip_bursts: [],
    },
    // Monotonic counters accumulated by applying frames forward from state0.
    // FrameCache.cloneState resets these to 0 on initial clone and during
    // rewind so that seek() produces deterministic values for any target.
    spawn_count: 0,
    death_count: 0,
    passive_split_count: 0,
    failed_rift_count: 0,
  };
}

// -----------------------------------------------------------------------------
// applyFrame — mutate `state` in place from a single frame payload.
// -----------------------------------------------------------------------------
export function applyFrame(state, reader) {
  const frame_idx = reader.u32();
  const payload_size = reader.u32();
  const payload_start = reader.pos;
  const payload_end = payload_start + payload_size;

  // Clear per-frame transient events.
  state.lip_bursts = [];
  state.events_this_frame = {
    spawns: [],
    deaths: [],
    passive_splits: [],
    failed_rifts: [],
    lip_bursts: [],
  };

  while (reader.pos < payload_end) {
    const tag_pos = reader.pos;
    const tag = reader.u8();
    // Soft-tolerance: for fixed-size tags, if the remaining bytes in this
    // payload are shorter than the canonical size, clamp + warn rather than
    // throwing. Variable-size tags are skipped (they read their own length).
    const expected = TAG_PAYLOAD_SIZE[tag];
    if (expected !== undefined && payload_end - reader.pos < expected) {
      if (typeof console !== "undefined" && console.warn) {
        console.warn(
          `applyFrame: short payload for tag 0x${tag
            .toString(16)
            .padStart(2, "0")} on frame ${frame_idx} ` +
            `(have ${payload_end - reader.pos}, need ${expected}) — clamping`
        );
      }
      reader.pos = payload_end;
      break;
    }
    switch (tag) {
      case TAGS.CELL_PLATE: {
        const idx = reader.u32();
        const new_plate = reader.u32();
        state.cell_plate[idx] = new_plate;
        break;
      }
      case TAGS.CELL_ELEV: {
        const idx = reader.u32();
        const new_elev = reader.i16();
        state.cell_elevation_m[idx] = new_elev;
        break;
      }
      case TAGS.CELL_COMP: {
        const idx = reader.u32();
        const new_comp = reader.u8();
        state.cell_composition[idx] = new_comp;
        break;
      }
      case TAGS.CELL_RIFT: {
        const idx = reader.u32();
        const new_value = reader.u8();
        state.cell_rift_progress[idx] = new_value;
        break;
      }
      case TAGS.CELL_FAILED: {
        const idx = reader.u32();
        const new_value = reader.u16();
        state.cell_failed_rift_age_ma[idx] = new_value;
        break;
      }
      case TAGS.CELL_LIP: {
        const idx = reader.u32();
        const new_value = reader.u16();
        state.cell_lip_age_ma[idx] = new_value;
        break;
      }
      case TAGS.CELL_VOLC: {
        const idx = reader.u32();
        const new_value = reader.u8();
        state.cell_volcanic_act[idx] = new_value;
        break;
      }
      case TAGS.CELL_AGE_MA: {
        const idx = reader.u32();
        const new_value = reader.u16();
        if (state.cell_age_ma) {
          state.cell_age_ma[idx] = new_value;
        }
        break;
      }
      case TAGS.PLATE_SPAWN: {
        const plate = parsePlateBlock(reader);
        state.plates.push(plate);
        state.events_this_frame.spawns.push({ id: plate.id, parent_id: plate.parent_id });
        state.spawn_count += 1;
        break;
      }
      case TAGS.PLATE_RETIRE: {
        const id = reader.u32();
        state.plates = state.plates.filter((p) => p.id !== id);
        break;
      }
      case TAGS.PLATE_MOTION: {
        const id = reader.u32();
        const omega = [reader.f32(), reader.f32(), reader.f32()];
        const plate = state.plates.find((p) => p.id === id);
        if (plate) plate.omega = omega;
        break;
      }
      case TAGS.PLATE_SEED: {
        const id = reader.u32();
        const seed_pos = [reader.f32(), reader.f32(), reader.f32()];
        const plate = state.plates.find((p) => p.id === id);
        if (plate) plate.seed_pos = seed_pos;
        break;
      }
      case TAGS.PLATE_DEATH: {
        const plateId = reader.u32();
        const reason = reader.u8();
        state.events_this_frame.deaths.push({ plateId, reason });
        state.death_count += 1;
        break;
      }
      case TAGS.PLATE_PASSIVE_SPLIT: {
        const parentId = reader.u32();
        const childId = reader.u32();
        state.events_this_frame.passive_splits.push({ parentId, childId });
        state.passive_split_count += 1;
        break;
      }
      case TAGS.FAILED_RIFT: {
        const plateId = reader.u32();
        const cell = reader.u32();
        state.events_this_frame.failed_rifts.push({ plateId, cell });
        state.failed_rift_count += 1;
        break;
      }
      case TAGS.MOR_SPAWN: {
        const mor = parseMorBlock(reader);
        state.mors.push(mor);
        break;
      }
      case TAGS.MOR_RETIRE: {
        const id = reader.u32();
        state.mors = state.mors.filter((m) => m.id !== id);
        break;
      }
      case TAGS.BOUNDARY_POLYLINES: {
        // [u32 record_len][payload]. record_len lets a tolerant decoder skip
        // the record without parsing it; we still parse the payload below.
        const record_len = reader.u32();
        const record_end = reader.pos + record_len;
        const n_polylines = reader.u16();
        const polylines = new Array(n_polylines);
        for (let p = 0; p < n_polylines; p++) {
          const plate_a = reader.u32();
          const plate_b = reader.u32();
          const kind = reader.u8();
          const n_verts = reader.u16();
          const verts = new Float32Array(n_verts * 3);
          for (let v = 0; v < n_verts * 3; v++) verts[v] = readF16(reader);
          polylines[p] = { plate_a, plate_b, kind, verts };
        }
        // Defensive: if encoder padded the record, clamp to record_end.
        if (reader.pos !== record_end) {
          reader.pos = record_end;
        }
        state.boundary_polylines = polylines;
        break;
      }
      case TAGS.KEYFRAME: {
        // Replace state with a fresh snapshot. The keyframe payload is the
        // same shape as the initial state. Preserve the per-frame transient
        // events (already reset above) and the monotonic accumulator counts
        // — keyframes mirror initial state, not event totals.
        const fresh = parseInitialState(reader, state.cell_plate.length);
        state.cell_plate              = fresh.cell_plate;
        state.cell_elevation_m        = fresh.cell_elevation_m;
        state.cell_composition        = fresh.cell_composition;
        state.cell_rift_progress      = fresh.cell_rift_progress;
        state.cell_failed_rift_age_ma = fresh.cell_failed_rift_age_ma;
        state.cell_lip_age_ma         = fresh.cell_lip_age_ma;
        state.cell_volcanic_act       = fresh.cell_volcanic_act;
        state.cell_age_ma             = fresh.cell_age_ma;
        state.plates                  = fresh.plates;
        state.mors                    = fresh.mors;
        break;
      }
      case TAGS.CELL_TEMPERATURE_K: {
        const n = reader.u32();
        const arr = new Float32Array(n);
        for (let i = 0; i < n; i++) arr[i] = dequantizeTemperatureK(reader.u8());
        state.cell_temperature_k = arr;
        break;
      }
      case TAGS.CELL_HUMIDITY: {
        const n = reader.u32();
        const arr = new Float32Array(n);
        for (let i = 0; i < n; i++) arr[i] = dequantizeUnit(reader.u8());
        state.cell_humidity = arr;
        break;
      }
      case TAGS.CELL_BIOME_ID: {
        const n = reader.u32();
        state.cell_biome_id = reader.bytes(n).slice();
        break;
      }
      case TAGS.CELL_RIVER_FLOW: {
        const n = reader.u32();
        const arr = new Float32Array(n);
        for (let i = 0; i < n; i++) arr[i] = dequantizeRiverFlow(reader.u16());
        state.cell_river_flow = arr;
        break;
      }
      case TAGS.CELL_LAKE_MASK: {
        const n = reader.u32();
        const n_bytes = (n + 7) >> 3;
        const bits = reader.bytes(n_bytes);
        const mask = new Uint8Array(n);
        for (let i = 0; i < n; i++) {
          mask[i] = (bits[i >> 3] >> (i & 7)) & 1;
        }
        state.cell_lake_mask = mask;
        break;
      }
      case TAGS.CELL_SNOW_COVER: {
        const n = reader.u32();
        const arr = new Float32Array(n);
        for (let i = 0; i < n; i++) arr[i] = dequantizeUnit(reader.u8());
        state.cell_snow_cover = arr;
        break;
      }
      case TAGS.CELL_OCEAN_CURRENT_VEC: {
        const n = reader.u32();
        const arr = new Float32Array(n * 3);
        for (let i = 0; i < n; i++) {
          arr[i * 3 + 0] = decodeFloat16(reader.u16());
          arr[i * 3 + 1] = decodeFloat16(reader.u16());
          arr[i * 3 + 2] = decodeFloat16(reader.u16());
        }
        state.cell_ocean_current_vec = arr;
        break;
      }
      case TAGS.PLUME_TRACK_POINT: {
        const plume_id = reader.u32();
        const cell = reader.u32();
        const age_ma = reader.u16();
        if (!state.plume_track_points) state.plume_track_points = [];
        state.plume_track_points.push({ plume_id, cell, age_ma });
        break;
      }
      case TAGS.CRUST_LAYER_STACK: {
        const n_cells = reader.u32();
        const stacks = new Array(n_cells);
        for (let c = 0; c < n_cells; c++) {
          const n_layers = reader.u8();
          const layers = new Array(n_layers);
          for (let l = 0; l < n_layers; l++) {
            const rock_id = reader.u8();
            const thickness_m = reader.u16();
            layers[l] = { rock_id, thickness_m };
          }
          stacks[c] = layers;
        }
        state.cell_crust_stack = stacks;
        break;
      }
      case TAGS.SIM_TIME_MA: {
        const ma = reader.f32();
        const era_len = reader.u16();
        const era_bytes = reader.bytes(era_len);
        const decoder = (typeof TextDecoder !== "undefined")
          ? new TextDecoder("utf-8")
          : null;
        state.sim_time_ma = ma;
        state.sim_era = decoder
          ? decoder.decode(era_bytes)
          : String.fromCharCode.apply(null, Array.from(era_bytes));
        break;
      }
      default:
        throw new Error(
          `applyFrame: unknown tag 0x${tag.toString(16).padStart(2, "0")} at byte ${reader.baseOffset + tag_pos} (frame ${frame_idx})`
        );
    }
  }

  if (reader.pos !== payload_end) {
    // Tolerate over/underrun by clamping to payload_end so playback continues.
    // The encoder occasionally emits a stale-by-a-few-bytes payload; aborting
    // the whole stream is worse than skipping the bad delta.
    if (typeof console !== "undefined" && console.warn) {
      console.warn(
        `applyFrame: payload over/underrun on frame ${frame_idx}: pos=${reader.pos} expected=${payload_end} — clamping`
      );
    }
    reader.pos = payload_end;
  }

  return frame_idx;
}

// -----------------------------------------------------------------------------
// FrameCache — header + state0 + per-frame byte offsets + seek().
// -----------------------------------------------------------------------------
export class FrameCache {
  /** @param {ArrayBuffer} arrayBuffer */
  constructor(arrayBuffer) {
    this.buffer = arrayBuffer;

    const reader = new ByteReader(arrayBuffer);
    this.header = parseHeader(reader);
    this.state0 = parseInitialState(reader, this.header.n_cells);

    // Index per-frame byte offsets (relative to arrayBuffer start).
    // After the initial state, each frame is:
    //   u32 frame_idx | u32 payload_size | payload bytes
    // We index the offset of the u32 frame_idx header, so seek can construct
    // a reader at that position and call applyFrame() directly.
    this.frameOffsets = new Array(this.header.total_frames);

    let cursor = reader.absolutePos;
    const totalLen = arrayBuffer.byteLength;
    let scanned = 0;
    while (cursor < totalLen && scanned < this.header.total_frames) {
      const peek = new DataView(arrayBuffer, cursor, 8);
      const frame_idx = peek.getUint32(0, true);
      const payload_size = peek.getUint32(4, true);
      if (frame_idx >= this.header.total_frames) {
        throw new Error(
          `FrameCache: frame_idx ${frame_idx} out of range at offset ${cursor}`
        );
      }
      this.frameOffsets[frame_idx] = cursor;
      cursor += 8 + payload_size;
      scanned += 1;
    }

    if (scanned !== this.header.total_frames) {
      // Non-fatal: stream may be truncated. Truncate frameOffsets to what we have.
      const found = this.frameOffsets.filter((o) => o !== undefined).length;
      // eslint-disable-next-line no-console
      console.warn(
        `FrameCache: indexed ${found}/${this.header.total_frames} frames (stream truncated?)`
      );
    }

    // Seed "current" with a deep clone of state0; currentFrame = -1 means
    // no frames applied yet (state matches initial-state, pre-frame-0).
    this.current = FrameCache.cloneState(this.state0);
    this.currentFrame = -1;
  }

  /**
   * Deep-clone a state object: typed arrays copied, plate/mor arrays cloned
   * with shallow-cloned entries (plates have numeric/tuple fields only;
   * mors hold Float32Array axis/segments which we copy).
   */
  static cloneState(s) {
    const n = s.cell_plate.length;
    return {
      cell_plate:              new Uint32Array(s.cell_plate),
      cell_elevation_m:        new Int16Array(s.cell_elevation_m),
      cell_composition:        new Uint8Array(s.cell_composition),
      cell_rift_progress:      new Uint8Array(s.cell_rift_progress),
      cell_failed_rift_age_ma: new Uint16Array(s.cell_failed_rift_age_ma),
      cell_lip_age_ma:         new Uint16Array(s.cell_lip_age_ma),
      cell_volcanic_act:       new Uint8Array(s.cell_volcanic_act),
      cell_age_ma:             s.cell_age_ma
        ? new Uint16Array(s.cell_age_ma)
        : new Uint16Array(n),
      plates: s.plates.map((p) => ({
        id: p.id,
        parent_id: p.parent_id,
        color: p.color.slice(),
        seed_pos: p.seed_pos.slice(),
        omega: p.omega.slice(),
        birth_step: p.birth_step,
      })),
      mors: s.mors.map((m) => ({
        id: m.id,
        flank_a: m.flank_a,
        flank_b: m.flank_b,
        spreading_rate: m.spreading_rate,
        axis: new Float32Array(m.axis),
        segments: new Float32Array(m.segments),
      })),
      lip_bursts: [],
      // Boundary polylines are large (~5800-7500 records per frame, each a
      // Float32Array). Share the array by reference — applyFrame() overwrites
      // state.boundary_polylines wholesale on every 0x30 record, so callers
      // never mutate the shared array.
      boundary_polylines: s.boundary_polylines || [],
      events_this_frame: {
        spawns: [],
        deaths: [],
        passive_splits: [],
        failed_rifts: [],
        lip_bursts: [],
      },
      // Monotonic counters — reset to 0 on every clone so that seek() rewinds
      // re-derive deterministically by forward-replaying frames.
      spawn_count: 0,
      death_count: 0,
      passive_split_count: 0,
      failed_rift_count: 0,
    };
  }

  /**
   * Seek to target frame index, applying deltas as needed. v1 backward-seek
   * strategy: rewind to frame 0 and replay forward. (Optimization later:
   * jump to nearest 0x40 keyframe ≤ target.)
   *
   * @param {number} targetFrame
   * @returns {object} this.current
   */
  seek(targetFrame) {
    if (targetFrame < 0 || targetFrame >= this.header.total_frames) {
      throw new RangeError(
        `FrameCache.seek: target ${targetFrame} out of [0, ${this.header.total_frames})`
      );
    }
    if (targetFrame === this.currentFrame) return this.current;

    if (targetFrame < this.currentFrame) {
      // Rewind to state0.
      this.current = FrameCache.cloneState(this.state0);
      this.currentFrame = -1;
    }

    for (let f = this.currentFrame + 1; f <= targetFrame; f++) {
      const offset = this.frameOffsets[f];
      if (offset === undefined) {
        // Some encoders treat frame 0 (and possibly other indices) as the
        // implicit initial-state snapshot — no delta record on disk. In that
        // case advance currentFrame without applying anything.
        this.currentFrame = f;
        continue;
      }
      const reader = new ByteReader(this.buffer, offset);
      try {
        const applied = applyFrame(this.current, reader);
        if (applied !== f) {
          // eslint-disable-next-line no-console
          console.warn(
            `FrameCache.seek: applyFrame returned ${applied} expected ${f}`
          );
        }
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn(`FrameCache.seek: skipping frame ${f}:`, e?.message || e);
      }
      this.currentFrame = f;
    }

    return this.current;
  }
}
