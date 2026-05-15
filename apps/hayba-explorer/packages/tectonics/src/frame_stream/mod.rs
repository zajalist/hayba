//! Binary delta-stream encoder for tectonic-v2 simulation playback.
//!
//! Phase 1 — minimal format. Emits a tagged stream of per-frame deltas of
//! plate-id and elevation per cell, plus the initial full snapshot.
//!
//! Climate / biome / mantle / boundary records arrive in later phases.
//!
//! ## Format (little-endian)
//!
//! ```text
//! Header (32 bytes):
//!   [u8;5] magic "HAYV2" + u8 version=1 + [u8;2] pad
//!   u32 total_frames, u32 n_cells, u32 dt_ma_bits, u32 keyframe_stride,
//!   u32 master_seed, u32 reserved
//!
//! Initial state (frame 0 full snapshot, written once after header):
//!   for cell in 0..n_cells: u16 plate_id_or_0xFFFF
//!   for cell in 0..n_cells: f32 elevation
//!   for cell in 0..n_cells: u8 is_continental
//!
//! Per-frame record:
//!   u32 frame_idx
//!   u32 payload_byte_count
//!   <payload bytes>
//!
//! Payload tags inside a frame:
//!   0x01 CELL_PLATE_DELTA: u32 count, then count * (u32 cell, u16 plate_id_or_0xFFFF)
//!   0x02 CELL_ELEV_DELTA:  u32 count, then count * (u32 cell, f32 elevation)
//!   0x03 CELL_CONTINENTAL_DELTA: u32 count, then count * (u32 cell, u8 is_continental)
//!   0x40 KEYFRAME:        followed by a duplicate of the initial-state block.
//!   0x41 SIM_TIME_MA:     f32 sim_time_ma, u16 era_len, [u8; era_len] era_name
//! ```
//!
//! ## Tag-range reservation (forward-compat — keep additions disjoint)
//!
//! | Range       | Purpose                          |
//! |-------------|----------------------------------|
//! | 0x01–0x0F   | Per-cell field deltas            |
//! | 0x10–0x3F   | Crust / age / lithology deltas   |
//! | 0x40–0x4F   | Keyframe / snapshot markers      |
//! | 0x50–0x7F   | Climate deltas                   |
//! | 0x80–0xBF   | Biome deltas                     |
//! | 0xC0–0xEF   | Mantle / deep-earth deltas       |
//! | 0xF0–0xFF   | Reserved for protocol expansion  |
//!
//! ## Determinism
//!
//! The encoder is read-only with respect to sim state. Same master seed →
//! byte-identical output.

use std::io::{self, Write};

use half::f16;

use crate::field::Field;

/// Magic header bytes — distinct from v1's "HAYBA".
pub const MAGIC: &[u8; 5] = b"HAYV2";
pub const VERSION: u8 = 1;

/// Tag identifiers. See the tag-range reservation table in the module docs.
pub const TAG_CELL_PLATE_DELTA: u8 = 0x01;
pub const TAG_CELL_ELEV_DELTA: u8 = 0x02;
pub const TAG_CELL_CONTINENTAL_DELTA: u8 = 0x03;
pub const TAG_KEYFRAME: u8 = 0x40;
/// Wilson-cycle simulation clock + Earth-history era name. Emitted at the
/// caller's discretion (typically once per frame). Payload layout:
/// `f32 sim_time_ma` followed by `u16 era_len` and `era_len` UTF-8 bytes.
pub const TAG_SIM_TIME_MA: u8 = 0x41;

// ── Phase 9 climate / crust / plume tags ───────────────────────────────────
//
// Per-cell climate (full-array writes; not delta-compressed yet). Each tag is
// followed by `u32 n_cells` then the quantized payload.
//
// Quantization details:
//   * temperature_k:  200..328 K → 0..255 (0.5 K step)
//   * humidity:       0..1     → 0..255
//   * snow_cover:     0..1     → 0..255
//   * river_flow:     u16 = (log2(flow_m3_s + 1.0) * 1024.0) as u16
//   * lake_mask:      bitpacked 1 bit/cell, LSB-first per byte
//   * ocean_current:  3 × f16 per cell (6 bytes/cell)
pub const TAG_CELL_TEMPERATURE_K: u8 = 0x09;
pub const TAG_CELL_HUMIDITY: u8 = 0x0A;
pub const TAG_CELL_BIOME_ID: u8 = 0x0B;
pub const TAG_CELL_RIVER_FLOW: u8 = 0x0C;
pub const TAG_CELL_LAKE_MASK: u8 = 0x0D;
pub const TAG_CELL_SNOW_COVER: u8 = 0x0E;
pub const TAG_CELL_OCEAN_CURRENT_VEC: u8 = 0x0F;

/// Plume-track point — `u32 plume_id, u32 cell_idx, u16 age_ma`.
///
/// Spec asked for 0x17; it lives in the documented 0x10–0x3F crust/age band.
/// Plume tracks are deep-earth metadata stamped onto a crust cell, so we keep
/// it adjacent to the lifecycle/crust tags rather than the mantle band.
pub const TAG_PLUME_TRACK_POINT: u8 = 0x17;

/// Crust layer stack — per-cell variable length.
///
/// Payload: `u32 n_cells` then for each cell `u8 n_layers` followed by
/// `n_layers * (u8 rock_id, u16 thickness_m)`.
///
/// Spec requested 0x41, which is already taken by `TAG_SIM_TIME_MA`. We use
/// 0x18 instead — still inside the documented 0x10–0x3F crust/lithology band.
pub const TAG_CRUST_LAYER_STACK: u8 = 0x18;

// Temperature quantization helpers (200..328 K, 0.5 K step).
const TEMP_K_MIN: f32 = 200.0;
const TEMP_K_STEP: f32 = 0.5;

/// Sentinel for "no plate" in the 16-bit cell-plate slot. (TE has at most
/// ~16 plates ever; u16 is comfortably plenty.)
pub const NO_PLATE: u16 = 0xFFFF;

/// Elevation deltas smaller than this absolute value are dropped from the
/// per-frame stream.
pub const ELEVATION_DELTA_EPSILON: f32 = 1.0e-4;

/// Frame stream encoder. Holds the previous snapshot so per-frame deltas
/// can be computed against it.
pub struct FrameEncoder<W: Write> {
    writer: W,
    n_cells: u32,
    keyframe_stride: u32,
    frame_idx: u32,
    /// Previous per-cell plate ids (one u16 per cell).
    prev_plate: Vec<u16>,
    /// Previous per-cell elevation.
    prev_elev: Vec<f32>,
    /// Previous per-cell continental flag.
    prev_continental: Vec<u8>,
    /// Count of frames written (excluding the initial-state block).
    frames_written: u32,
}

impl<W: Write> FrameEncoder<W> {
    /// Construct + write the header and frame-0 full snapshot.
    pub fn new(
        mut writer: W,
        n_cells: u32,
        dt_ma: f32,
        total_frames: u32,
        keyframe_stride: u32,
        master_seed: u64,
        fields: &[Field],
    ) -> io::Result<Self> {
        // ── Header ───────────────────────────────────────────────────
        writer.write_all(MAGIC)?;
        writer.write_all(&[VERSION, 0, 0])?;
        writer.write_all(&total_frames.to_le_bytes())?;
        writer.write_all(&n_cells.to_le_bytes())?;
        writer.write_all(&dt_ma.to_bits().to_le_bytes())?;
        writer.write_all(&keyframe_stride.to_le_bytes())?;
        writer.write_all(&(master_seed as u32).to_le_bytes())?;
        // Last u32 of the 32-byte header carries the peels `divisions` (u16)
        // plus a u16 reserved slot. Phase 10.1 surfaced that without divisions
        // in-band, JS consumers had to guess what sphere to build to match the
        // bin's cells. n_cells = 10*d² + 2 → derive d from n_cells.
        let divisions: u16 = (((n_cells as f64 - 2.0) / 10.0).sqrt().round() as u16).max(1);
        writer.write_all(&divisions.to_le_bytes())?;
        writer.write_all(&0u16.to_le_bytes())?; // reserved u16

        // ── Initial-state block ──────────────────────────────────────
        let (plate, elev, continental) = snapshot(n_cells, fields);
        write_full_snapshot(&mut writer, &plate, &elev, &continental)?;

        Ok(Self {
            writer,
            n_cells,
            keyframe_stride: keyframe_stride.max(1),
            frame_idx: 0,
            prev_plate: plate,
            prev_elev: elev,
            prev_continental: continental,
            frames_written: 0,
        })
    }

    /// Number of frames emitted (initial snapshot doesn't count).
    pub fn frames_written(&self) -> u32 {
        self.frames_written
    }

    /// Emit a frame. Computes deltas against the previous snapshot, writes
    /// them, and updates the cached snapshot.
    pub fn write_frame(&mut self, fields: &[Field]) -> io::Result<()> {
        self.frame_idx = self.frame_idx.wrapping_add(1);
        let (new_plate, new_elev, new_continental) = snapshot(self.n_cells, fields);

        // Build payload in memory so we can prepend the byte length.
        let mut payload: Vec<u8> = Vec::with_capacity(64);

        // Keyframe every `keyframe_stride` frames.
        let is_keyframe = self.keyframe_stride > 0 && self.frame_idx % self.keyframe_stride == 0;
        if is_keyframe {
            payload.push(TAG_KEYFRAME);
            write_full_snapshot(&mut payload, &new_plate, &new_elev, &new_continental)?;
        } else {
            // Plate-id deltas.
            let mut plate_changes: Vec<(u32, u16)> = Vec::new();
            for i in 0..self.n_cells as usize {
                if new_plate[i] != self.prev_plate[i] {
                    plate_changes.push((i as u32, new_plate[i]));
                }
            }
            if !plate_changes.is_empty() {
                payload.push(TAG_CELL_PLATE_DELTA);
                payload.extend_from_slice(&(plate_changes.len() as u32).to_le_bytes());
                for (c, p) in &plate_changes {
                    payload.extend_from_slice(&c.to_le_bytes());
                    payload.extend_from_slice(&p.to_le_bytes());
                }
            }

            // Elevation deltas.
            let mut elev_changes: Vec<(u32, f32)> = Vec::new();
            for i in 0..self.n_cells as usize {
                let d = (new_elev[i] - self.prev_elev[i]).abs();
                if d > ELEVATION_DELTA_EPSILON {
                    elev_changes.push((i as u32, new_elev[i]));
                }
            }
            if !elev_changes.is_empty() {
                payload.push(TAG_CELL_ELEV_DELTA);
                payload.extend_from_slice(&(elev_changes.len() as u32).to_le_bytes());
                for (c, e) in &elev_changes {
                    payload.extend_from_slice(&c.to_le_bytes());
                    payload.extend_from_slice(&e.to_bits().to_le_bytes());
                }
            }

            // Continental-flag deltas.
            let mut cont_changes: Vec<(u32, u8)> = Vec::new();
            for i in 0..self.n_cells as usize {
                if new_continental[i] != self.prev_continental[i] {
                    cont_changes.push((i as u32, new_continental[i]));
                }
            }
            if !cont_changes.is_empty() {
                payload.push(TAG_CELL_CONTINENTAL_DELTA);
                payload.extend_from_slice(&(cont_changes.len() as u32).to_le_bytes());
                for (c, b) in &cont_changes {
                    payload.extend_from_slice(&c.to_le_bytes());
                    payload.push(*b);
                }
            }
        }

        // Emit the frame record.
        self.writer.write_all(&self.frame_idx.to_le_bytes())?;
        self.writer.write_all(&(payload.len() as u32).to_le_bytes())?;
        self.writer.write_all(&payload)?;

        // Commit snapshot.
        self.prev_plate = new_plate;
        self.prev_elev = new_elev;
        self.prev_continental = new_continental;
        self.frames_written += 1;
        Ok(())
    }

    /// Emit a standalone `SIM_TIME_MA` frame record carrying the current
    /// Wilson-cycle clock + Earth-history era. Uses tag `0x41` inside the
    /// payload (see [`TAG_SIM_TIME_MA`]). Payload layout:
    /// `u8 tag | f32 sim_time_ma | u16 era_len | era_bytes`.
    ///
    /// Note: this advances `frame_idx` like any other frame so downstream
    /// decoders see a contiguous frame stream.
    pub fn write_sim_time(&mut self, ma: f64, era: &str) -> io::Result<()> {
        self.frame_idx = self.frame_idx.wrapping_add(1);
        let era_bytes = era.as_bytes();
        assert!(
            era_bytes.len() <= u16::MAX as usize,
            "era name length {} exceeds u16 range",
            era_bytes.len()
        );

        let mut payload: Vec<u8> = Vec::with_capacity(1 + 4 + 2 + era_bytes.len());
        payload.push(TAG_SIM_TIME_MA);
        payload.extend_from_slice(&(ma as f32).to_bits().to_le_bytes());
        payload.extend_from_slice(&(era_bytes.len() as u16).to_le_bytes());
        payload.extend_from_slice(era_bytes);

        self.writer.write_all(&self.frame_idx.to_le_bytes())?;
        self.writer.write_all(&(payload.len() as u32).to_le_bytes())?;
        self.writer.write_all(&payload)?;
        self.frames_written += 1;
        Ok(())
    }

    // ── Phase 9 climate / crust / plume writers ─────────────────────────
    //
    // Each writer emits one frame record (frame_idx + u32 payload_len +
    // payload). The payload begins with the tag byte, then for the per-cell
    // tags a `u32 n_cells` length prefix, then quantized data.

    /// u8-quantized per-cell temperatures (200..328 K, 0.5 K step).
    pub fn write_cell_temperature(&mut self, temps_k: &[f32]) -> io::Result<()> {
        let mut payload = Vec::with_capacity(1 + 4 + temps_k.len());
        payload.push(TAG_CELL_TEMPERATURE_K);
        payload.extend_from_slice(&(temps_k.len() as u32).to_le_bytes());
        for &t in temps_k {
            payload.push(quantize_temperature_k(t));
        }
        self.emit_frame_payload(&payload)
    }

    /// u8-quantized humidity (0..1).
    pub fn write_cell_humidity(&mut self, humidity: &[f32]) -> io::Result<()> {
        let mut payload = Vec::with_capacity(1 + 4 + humidity.len());
        payload.push(TAG_CELL_HUMIDITY);
        payload.extend_from_slice(&(humidity.len() as u32).to_le_bytes());
        for &h in humidity {
            payload.push(quantize_unit(h));
        }
        self.emit_frame_payload(&payload)
    }

    /// Biome ids (u8 enum).
    pub fn write_cell_biome(&mut self, biomes: &[u8]) -> io::Result<()> {
        let mut payload = Vec::with_capacity(1 + 4 + biomes.len());
        payload.push(TAG_CELL_BIOME_ID);
        payload.extend_from_slice(&(biomes.len() as u32).to_le_bytes());
        payload.extend_from_slice(biomes);
        self.emit_frame_payload(&payload)
    }

    /// u16 log2-quantized river flow.
    pub fn write_cell_river_flow(&mut self, flow_m3_s: &[f32]) -> io::Result<()> {
        let mut payload = Vec::with_capacity(1 + 4 + flow_m3_s.len() * 2);
        payload.push(TAG_CELL_RIVER_FLOW);
        payload.extend_from_slice(&(flow_m3_s.len() as u32).to_le_bytes());
        for &f in flow_m3_s {
            payload.extend_from_slice(&quantize_river_flow(f).to_le_bytes());
        }
        self.emit_frame_payload(&payload)
    }

    /// Bitpacked lake mask, 1 bit / cell, LSB-first per byte.
    pub fn write_cell_lake_mask(&mut self, mask: &[bool]) -> io::Result<()> {
        let n = mask.len();
        let n_bytes = (n + 7) / 8;
        let mut payload = Vec::with_capacity(1 + 4 + n_bytes);
        payload.push(TAG_CELL_LAKE_MASK);
        payload.extend_from_slice(&(n as u32).to_le_bytes());
        let mut bytes = vec![0u8; n_bytes];
        for (i, &b) in mask.iter().enumerate() {
            if b {
                bytes[i >> 3] |= 1 << (i & 7);
            }
        }
        payload.extend_from_slice(&bytes);
        self.emit_frame_payload(&payload)
    }

    /// u8-quantized snow cover (0..1).
    pub fn write_cell_snow_cover(&mut self, snow: &[f32]) -> io::Result<()> {
        let mut payload = Vec::with_capacity(1 + 4 + snow.len());
        payload.push(TAG_CELL_SNOW_COVER);
        payload.extend_from_slice(&(snow.len() as u32).to_le_bytes());
        for &s in snow {
            payload.push(quantize_unit(s));
        }
        self.emit_frame_payload(&payload)
    }

    /// 3 × f16 ocean-current vector per cell.
    pub fn write_cell_ocean_current(&mut self, vecs: &[[f32; 3]]) -> io::Result<()> {
        let mut payload = Vec::with_capacity(1 + 4 + vecs.len() * 6);
        payload.push(TAG_CELL_OCEAN_CURRENT_VEC);
        payload.extend_from_slice(&(vecs.len() as u32).to_le_bytes());
        for v in vecs {
            for &c in v {
                payload.extend_from_slice(&f16::from_f32(c).to_le_bytes());
            }
        }
        self.emit_frame_payload(&payload)
    }

    /// Single plume-track point: `u32 plume_id, u32 cell_idx, u16 age_ma`.
    pub fn write_plume_track_point(
        &mut self,
        plume_id: u32,
        cell: u32,
        age_ma: u16,
    ) -> io::Result<()> {
        let mut payload = Vec::with_capacity(1 + 4 + 4 + 2);
        payload.push(TAG_PLUME_TRACK_POINT);
        payload.extend_from_slice(&plume_id.to_le_bytes());
        payload.extend_from_slice(&cell.to_le_bytes());
        payload.extend_from_slice(&age_ma.to_le_bytes());
        self.emit_frame_payload(&payload)
    }

    /// Variable-length per-cell crust layer stack. Each cell contributes
    /// `u8 n_layers` followed by `n_layers * (u8 rock_id, u16 thickness_m)`.
    pub fn write_crust_layer_stack(&mut self, stacks: &[Vec<(u8, u16)>]) -> io::Result<()> {
        let mut payload = Vec::new();
        payload.push(TAG_CRUST_LAYER_STACK);
        payload.extend_from_slice(&(stacks.len() as u32).to_le_bytes());
        for layers in stacks {
            assert!(
                layers.len() <= u8::MAX as usize,
                "crust layer stack length {} exceeds u8 range",
                layers.len()
            );
            payload.push(layers.len() as u8);
            for (rock_id, thickness_m) in layers {
                payload.push(*rock_id);
                payload.extend_from_slice(&thickness_m.to_le_bytes());
            }
        }
        self.emit_frame_payload(&payload)
    }

    /// Wrap a raw payload in a frame record (frame_idx + u32 len + bytes).
    fn emit_frame_payload(&mut self, payload: &[u8]) -> io::Result<()> {
        self.frame_idx = self.frame_idx.wrapping_add(1);
        self.writer.write_all(&self.frame_idx.to_le_bytes())?;
        self.writer.write_all(&(payload.len() as u32).to_le_bytes())?;
        self.writer.write_all(payload)?;
        self.frames_written += 1;
        Ok(())
    }

    /// Flush + return the inner writer.
    pub fn finish(mut self) -> io::Result<W> {
        self.writer.flush()?;
        Ok(self.writer)
    }
}

// ── Quantization helpers ────────────────────────────────────────────────────

/// Quantize a temperature in Kelvin to a u8 (200..328 K, 0.5 K step).
pub fn quantize_temperature_k(t: f32) -> u8 {
    let v = ((t - TEMP_K_MIN) / TEMP_K_STEP).round();
    v.clamp(0.0, 255.0) as u8
}

/// Dequantize the inverse of [`quantize_temperature_k`].
pub fn dequantize_temperature_k(q: u8) -> f32 {
    TEMP_K_MIN + (q as f32) * TEMP_K_STEP
}

/// Quantize a 0..1 value to u8 (round, clamp).
pub fn quantize_unit(v: f32) -> u8 {
    (v.clamp(0.0, 1.0) * 255.0).round() as u8
}

/// Inverse of [`quantize_unit`].
pub fn dequantize_unit(q: u8) -> f32 {
    (q as f32) / 255.0
}

/// `u16 = (log2(flow + 1) * 1024) as u16`, saturating.
pub fn quantize_river_flow(flow_m3_s: f32) -> u16 {
    let v = ((flow_m3_s.max(0.0) + 1.0).log2() * 1024.0).round();
    v.clamp(0.0, u16::MAX as f32) as u16
}

/// Inverse of [`quantize_river_flow`]: `2^(q/1024) - 1`.
pub fn dequantize_river_flow(q: u16) -> f32 {
    2f32.powf((q as f32) / 1024.0) - 1.0
}

// ── Phase 9 decoder helpers ─────────────────────────────────────────────────
//
// Free functions that decode a single tag payload (the bytes immediately
// following the tag byte). The JS side has its own decoder in
// `viz/lib/frame-stream.js`; these are Rust round-trip helpers.

/// Errors raised by the Phase-9 decoders.
#[derive(Debug)]
pub enum DecodeError {
    /// Buffer too short for the declared payload.
    UnexpectedEof,
    /// Tag header byte did not match the expected tag.
    UnexpectedTag { expected: u8, got: u8 },
}

impl std::fmt::Display for DecodeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            DecodeError::UnexpectedEof => write!(f, "unexpected EOF in frame_stream payload"),
            DecodeError::UnexpectedTag { expected, got } => {
                write!(f, "unexpected tag 0x{:02X} (expected 0x{:02X})", got, expected)
            }
        }
    }
}

impl std::error::Error for DecodeError {}

fn read_u8(buf: &[u8], off: &mut usize) -> Result<u8, DecodeError> {
    if *off + 1 > buf.len() {
        return Err(DecodeError::UnexpectedEof);
    }
    let v = buf[*off];
    *off += 1;
    Ok(v)
}

fn read_u16(buf: &[u8], off: &mut usize) -> Result<u16, DecodeError> {
    if *off + 2 > buf.len() {
        return Err(DecodeError::UnexpectedEof);
    }
    let v = u16::from_le_bytes(buf[*off..*off + 2].try_into().unwrap());
    *off += 2;
    Ok(v)
}

fn read_u32(buf: &[u8], off: &mut usize) -> Result<u32, DecodeError> {
    if *off + 4 > buf.len() {
        return Err(DecodeError::UnexpectedEof);
    }
    let v = u32::from_le_bytes(buf[*off..*off + 4].try_into().unwrap());
    *off += 4;
    Ok(v)
}

fn expect_tag(buf: &[u8], off: &mut usize, expected: u8) -> Result<(), DecodeError> {
    let got = read_u8(buf, off)?;
    if got != expected {
        return Err(DecodeError::UnexpectedTag { expected, got });
    }
    Ok(())
}

/// Decode a [`TAG_CELL_TEMPERATURE_K`] payload starting at the tag byte.
pub fn read_cell_temperature(buf: &[u8]) -> Result<Vec<f32>, DecodeError> {
    let mut off = 0;
    expect_tag(buf, &mut off, TAG_CELL_TEMPERATURE_K)?;
    let n = read_u32(buf, &mut off)? as usize;
    if off + n > buf.len() {
        return Err(DecodeError::UnexpectedEof);
    }
    Ok(buf[off..off + n]
        .iter()
        .map(|&q| dequantize_temperature_k(q))
        .collect())
}

pub fn read_cell_humidity(buf: &[u8]) -> Result<Vec<f32>, DecodeError> {
    let mut off = 0;
    expect_tag(buf, &mut off, TAG_CELL_HUMIDITY)?;
    let n = read_u32(buf, &mut off)? as usize;
    if off + n > buf.len() {
        return Err(DecodeError::UnexpectedEof);
    }
    Ok(buf[off..off + n].iter().map(|&q| dequantize_unit(q)).collect())
}

pub fn read_cell_biome(buf: &[u8]) -> Result<Vec<u8>, DecodeError> {
    let mut off = 0;
    expect_tag(buf, &mut off, TAG_CELL_BIOME_ID)?;
    let n = read_u32(buf, &mut off)? as usize;
    if off + n > buf.len() {
        return Err(DecodeError::UnexpectedEof);
    }
    Ok(buf[off..off + n].to_vec())
}

pub fn read_cell_river_flow(buf: &[u8]) -> Result<Vec<f32>, DecodeError> {
    let mut off = 0;
    expect_tag(buf, &mut off, TAG_CELL_RIVER_FLOW)?;
    let n = read_u32(buf, &mut off)? as usize;
    if off + n * 2 > buf.len() {
        return Err(DecodeError::UnexpectedEof);
    }
    let mut out = Vec::with_capacity(n);
    for i in 0..n {
        let q = u16::from_le_bytes(buf[off + i * 2..off + i * 2 + 2].try_into().unwrap());
        out.push(dequantize_river_flow(q));
    }
    Ok(out)
}

pub fn read_cell_lake_mask(buf: &[u8]) -> Result<Vec<bool>, DecodeError> {
    let mut off = 0;
    expect_tag(buf, &mut off, TAG_CELL_LAKE_MASK)?;
    let n = read_u32(buf, &mut off)? as usize;
    let n_bytes = (n + 7) / 8;
    if off + n_bytes > buf.len() {
        return Err(DecodeError::UnexpectedEof);
    }
    let bits = &buf[off..off + n_bytes];
    let mut out = Vec::with_capacity(n);
    for i in 0..n {
        out.push((bits[i >> 3] >> (i & 7)) & 1 == 1);
    }
    Ok(out)
}

pub fn read_cell_snow_cover(buf: &[u8]) -> Result<Vec<f32>, DecodeError> {
    let mut off = 0;
    expect_tag(buf, &mut off, TAG_CELL_SNOW_COVER)?;
    let n = read_u32(buf, &mut off)? as usize;
    if off + n > buf.len() {
        return Err(DecodeError::UnexpectedEof);
    }
    Ok(buf[off..off + n].iter().map(|&q| dequantize_unit(q)).collect())
}

pub fn read_cell_ocean_current(buf: &[u8]) -> Result<Vec<[f32; 3]>, DecodeError> {
    let mut off = 0;
    expect_tag(buf, &mut off, TAG_CELL_OCEAN_CURRENT_VEC)?;
    let n = read_u32(buf, &mut off)? as usize;
    if off + n * 6 > buf.len() {
        return Err(DecodeError::UnexpectedEof);
    }
    let mut out = Vec::with_capacity(n);
    for i in 0..n {
        let base = off + i * 6;
        let x = f16::from_le_bytes([buf[base], buf[base + 1]]).to_f32();
        let y = f16::from_le_bytes([buf[base + 2], buf[base + 3]]).to_f32();
        let z = f16::from_le_bytes([buf[base + 4], buf[base + 5]]).to_f32();
        out.push([x, y, z]);
    }
    Ok(out)
}

pub fn read_plume_track_point(buf: &[u8]) -> Result<(u32, u32, u16), DecodeError> {
    let mut off = 0;
    expect_tag(buf, &mut off, TAG_PLUME_TRACK_POINT)?;
    let plume_id = read_u32(buf, &mut off)?;
    let cell = read_u32(buf, &mut off)?;
    let age_ma = read_u16(buf, &mut off)?;
    Ok((plume_id, cell, age_ma))
}

pub fn read_crust_layer_stack(buf: &[u8]) -> Result<Vec<Vec<(u8, u16)>>, DecodeError> {
    let mut off = 0;
    expect_tag(buf, &mut off, TAG_CRUST_LAYER_STACK)?;
    let n_cells = read_u32(buf, &mut off)? as usize;
    let mut out = Vec::with_capacity(n_cells);
    for _ in 0..n_cells {
        let n_layers = read_u8(buf, &mut off)? as usize;
        let mut layers = Vec::with_capacity(n_layers);
        for _ in 0..n_layers {
            let rock_id = read_u8(buf, &mut off)?;
            let thickness = read_u16(buf, &mut off)?;
            layers.push((rock_id, thickness));
        }
        out.push(layers);
    }
    Ok(out)
}

fn snapshot(n_cells: u32, fields: &[Field]) -> (Vec<u16>, Vec<f32>, Vec<u8>) {
    let n = n_cells as usize;
    let mut plate = vec![NO_PLATE; n];
    let mut elev = vec![0.0f32; n];
    let mut cont = vec![0u8; n];
    for f in fields.iter() {
        let i = f.id as usize;
        if i < n {
            plate[i] = match f.plate_id {
                Some(pid) => {
                    // Encoder boundary: u16 plate-id slot uses 0xFFFF as the
                    // sentinel. Reject any plate id that would collide.
                    // Expand the protocol to u32 if you genuinely need >65534
                    // plates.
                    assert!(
                        pid < NO_PLATE as u32,
                        "plate id {} exceeds u16 encoder range (NO_PLATE = 0x{:04X})",
                        pid,
                        NO_PLATE
                    );
                    pid as u16
                }
                None => NO_PLATE,
            };
            elev[i] = f.elevation;
            cont[i] = if f.is_continent_crust() { 1 } else { 0 };
        }
    }
    (plate, elev, cont)
}

fn write_full_snapshot<W: Write>(
    w: &mut W,
    plate: &[u16],
    elev: &[f32],
    continental: &[u8],
) -> io::Result<()> {
    for p in plate {
        w.write_all(&p.to_le_bytes())?;
    }
    for e in elev {
        w.write_all(&e.to_bits().to_le_bytes())?;
    }
    w.write_all(continental)?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::field::Field;
    use glam::Vec3;

    fn make_fields(n: u32) -> Vec<Field> {
        (0..n).map(|i| Field::new(i, Vec3::X)).collect()
    }

    #[test]
    fn encoder_writes_header_and_initial_snapshot() {
        let fields = make_fields(4);
        let mut buf: Vec<u8> = Vec::new();
        let enc = FrameEncoder::new(&mut buf, 4, 5.0, 10, 4, 42, &fields).unwrap();
        drop(enc);
        // Header = 32 bytes. Initial snapshot = 4*(2+4+1) = 28 bytes.
        assert_eq!(buf.len(), 32 + 28);
        assert_eq!(&buf[0..5], MAGIC);
        assert_eq!(buf[5], VERSION);
    }

    #[test]
    fn encoder_emits_frame_records() {
        let fields = make_fields(4);
        let mut buf: Vec<u8> = Vec::new();
        {
            let mut enc = FrameEncoder::new(&mut buf, 4, 5.0, 3, 100, 1, &fields).unwrap();
            // No state changed — payload should be tiny.
            enc.write_frame(&fields).unwrap();
            enc.write_frame(&fields).unwrap();
            enc.write_frame(&fields).unwrap();
            assert_eq!(enc.frames_written(), 3);
        }
        // At least header + initial + 3 frame headers worth.
        assert!(buf.len() > 32 + 28);
    }

    #[test]
    fn encoder_records_elevation_changes() {
        let fields = make_fields(2);
        let mut buf: Vec<u8> = Vec::new();
        let mut changed = fields.clone();
        changed[0].elevation = 0.5;
        let baseline_len;
        {
            let mut enc = FrameEncoder::new(&mut buf, 2, 1.0, 1, 100, 0, &fields).unwrap();
            let pre = enc.frames_written();
            assert_eq!(pre, 0);
            // Quick measurement: emit one no-op frame to size the empty-frame floor.
            enc.write_frame(&fields).unwrap();
            baseline_len = 0; // not used, just kept for clarity
        }
        let mut buf2: Vec<u8> = Vec::new();
        {
            let mut enc = FrameEncoder::new(&mut buf2, 2, 1.0, 1, 100, 0, &fields).unwrap();
            enc.write_frame(&changed).unwrap();
        }
        // Frame with an elevation delta is larger than empty frame.
        assert!(buf2.len() > buf.len() - 0, "{} {}", buf2.len(), buf.len());
        let _ = baseline_len;
    }

    #[test]
    fn write_sim_time_emits_tag_and_era_string() {
        let fields = make_fields(2);
        let mut buf: Vec<u8> = Vec::new();
        {
            let mut enc = FrameEncoder::new(&mut buf, 2, 0.5, 1, 100, 0, &fields).unwrap();
            enc.write_sim_time(123.5, "Cretaceous").unwrap();
            assert_eq!(enc.frames_written(), 1);
        }
        // Locate the SIM_TIME_MA tag byte after the header (32) + initial
        // snapshot (2*(2+4+1) = 14) + frame header (4+4 = 8). The next byte
        // is the payload's first tag.
        let tag_offset = 32 + 14 + 8;
        assert_eq!(buf[tag_offset], TAG_SIM_TIME_MA);
        // f32 sim_time_ma bits.
        let ma_bits = u32::from_le_bytes([
            buf[tag_offset + 1],
            buf[tag_offset + 2],
            buf[tag_offset + 3],
            buf[tag_offset + 4],
        ]);
        assert_eq!(f32::from_bits(ma_bits), 123.5_f32);
        // u16 era_len.
        let era_len =
            u16::from_le_bytes([buf[tag_offset + 5], buf[tag_offset + 6]]) as usize;
        assert_eq!(era_len, "Cretaceous".len());
        let era_bytes = &buf[tag_offset + 7..tag_offset + 7 + era_len];
        assert_eq!(std::str::from_utf8(era_bytes).unwrap(), "Cretaceous");
    }

    #[test]
    fn determinism_two_runs_identical() {
        let fields = make_fields(8);
        fn run(fields: &[Field]) -> Vec<u8> {
            let mut buf: Vec<u8> = Vec::new();
            let mut enc = FrameEncoder::new(&mut buf, 8, 5.0, 5, 100, 99, fields).unwrap();
            for _ in 0..5 {
                enc.write_frame(fields).unwrap();
            }
            buf
        }
        assert_eq!(run(&fields), run(&fields));
    }

    // ── Phase 9 round-trip tests ────────────────────────────────────────

    /// Extract the payload of the most recently written frame. Format is
    /// `[header(32) | initial-snapshot | (u32 frame_idx | u32 len | bytes)*]`.
    /// We scan from the end: read back `len`, then `bytes` = last `len` bytes
    /// before the final 0-byte trailer. Simpler: just iterate frames.
    fn last_frame_payload(buf: &[u8], n_cells: u32) -> Vec<u8> {
        let header = 32;
        let init = (n_cells as usize) * (2 + 4 + 1);
        let mut off = header + init;
        let mut last = Vec::new();
        while off + 8 <= buf.len() {
            off += 4; // frame_idx
            let len = u32::from_le_bytes(buf[off..off + 4].try_into().unwrap()) as usize;
            off += 4;
            last = buf[off..off + len].to_vec();
            off += len;
        }
        last
    }

    fn make_encoder<'a>(buf: &'a mut Vec<u8>, n_cells: u32) -> FrameEncoder<&'a mut Vec<u8>> {
        let fields = make_fields(n_cells);
        FrameEncoder::new(buf, n_cells, 1.0, 1, 1_000_000, 0, &fields).unwrap()
    }

    #[test]
    fn roundtrip_cell_temperature() {
        let temps = vec![200.0f32, 250.5, 287.3, 327.9, 400.0]; // last clamps
        let mut buf = Vec::new();
        {
            let mut enc = make_encoder(&mut buf, temps.len() as u32);
            enc.write_cell_temperature(&temps).unwrap();
        }
        let payload = last_frame_payload(&buf, temps.len() as u32);
        let decoded = read_cell_temperature(&payload).unwrap();
        assert_eq!(decoded.len(), temps.len());
        for (i, (&want, &got)) in temps.iter().zip(decoded.iter()).enumerate() {
            let want_clamped = want.clamp(TEMP_K_MIN, TEMP_K_MIN + 255.0 * TEMP_K_STEP);
            assert!(
                (got - want_clamped).abs() <= TEMP_K_STEP * 0.5 + 1e-3,
                "[{}] got {} want {}",
                i,
                got,
                want_clamped
            );
        }
    }

    #[test]
    fn roundtrip_cell_humidity_and_snow() {
        let vals = vec![0.0f32, 0.25, 0.5, 0.75, 1.0];
        let mut buf = Vec::new();
        {
            let mut enc = make_encoder(&mut buf, vals.len() as u32);
            enc.write_cell_humidity(&vals).unwrap();
        }
        let p = last_frame_payload(&buf, vals.len() as u32);
        let dec = read_cell_humidity(&p).unwrap();
        for (a, b) in vals.iter().zip(dec.iter()) {
            assert!((a - b).abs() <= 0.5 / 255.0 + 1e-6);
        }

        let mut buf2 = Vec::new();
        {
            let mut enc = make_encoder(&mut buf2, vals.len() as u32);
            enc.write_cell_snow_cover(&vals).unwrap();
        }
        let p2 = last_frame_payload(&buf2, vals.len() as u32);
        let dec2 = read_cell_snow_cover(&p2).unwrap();
        for (a, b) in vals.iter().zip(dec2.iter()) {
            assert!((a - b).abs() <= 0.5 / 255.0 + 1e-6);
        }
    }

    #[test]
    fn roundtrip_cell_biome() {
        let biomes: Vec<u8> = vec![0, 1, 7, 42, 255];
        let mut buf = Vec::new();
        {
            let mut enc = make_encoder(&mut buf, biomes.len() as u32);
            enc.write_cell_biome(&biomes).unwrap();
        }
        let p = last_frame_payload(&buf, biomes.len() as u32);
        assert_eq!(read_cell_biome(&p).unwrap(), biomes);
    }

    #[test]
    fn roundtrip_cell_river_flow() {
        let flows = vec![0.0f32, 1.0, 10.0, 1_000.0, 1.0e6];
        let mut buf = Vec::new();
        {
            let mut enc = make_encoder(&mut buf, flows.len() as u32);
            enc.write_cell_river_flow(&flows).unwrap();
        }
        let p = last_frame_payload(&buf, flows.len() as u32);
        let dec = read_cell_river_flow(&p).unwrap();
        for (a, b) in flows.iter().zip(dec.iter()) {
            // Log-domain quantization: tolerance ~ a * (2^(1/1024) - 1)
            let tol = (a.max(1.0)) * (2f32.powf(1.0 / 1024.0) - 1.0) + 1e-3;
            assert!(
                (a - b).abs() <= tol,
                "want {} got {} tol {}",
                a,
                b,
                tol
            );
        }
    }

    #[test]
    fn roundtrip_cell_lake_mask() {
        let mask = vec![true, false, true, true, false, false, false, true, true, false, true];
        let mut buf = Vec::new();
        {
            let mut enc = make_encoder(&mut buf, mask.len() as u32);
            enc.write_cell_lake_mask(&mask).unwrap();
        }
        let p = last_frame_payload(&buf, mask.len() as u32);
        assert_eq!(read_cell_lake_mask(&p).unwrap(), mask);
    }

    #[test]
    fn roundtrip_cell_ocean_current() {
        let vecs = vec![[0.0, 0.0, 0.0], [1.0, -1.0, 0.5], [3.14, 2.71, -0.001]];
        let mut buf = Vec::new();
        {
            let mut enc = make_encoder(&mut buf, vecs.len() as u32);
            enc.write_cell_ocean_current(&vecs).unwrap();
        }
        let p = last_frame_payload(&buf, vecs.len() as u32);
        let dec = read_cell_ocean_current(&p).unwrap();
        assert_eq!(dec.len(), vecs.len());
        for (a, b) in vecs.iter().zip(dec.iter()) {
            for k in 0..3 {
                // f16 mantissa precision ~ 10 bits → relative ~1e-3.
                let tol = a[k].abs() * 1.5e-3 + 1e-3;
                assert!(
                    (a[k] - b[k]).abs() <= tol,
                    "comp {}: want {} got {} tol {}",
                    k,
                    a[k],
                    b[k],
                    tol
                );
            }
        }
    }

    #[test]
    fn roundtrip_plume_track_point() {
        let mut buf = Vec::new();
        {
            let mut enc = make_encoder(&mut buf, 4);
            enc.write_plume_track_point(7, 1234, 250).unwrap();
        }
        let p = last_frame_payload(&buf, 4);
        assert_eq!(read_plume_track_point(&p).unwrap(), (7, 1234, 250));
    }

    #[test]
    fn roundtrip_crust_layer_stack() {
        let stacks: Vec<Vec<(u8, u16)>> = vec![
            vec![(0, 100), (1, 250)],
            vec![],
            vec![(2, 7000), (3, 1234), (4, 65535)],
        ];
        let mut buf = Vec::new();
        {
            let mut enc = make_encoder(&mut buf, stacks.len() as u32);
            enc.write_crust_layer_stack(&stacks).unwrap();
        }
        let p = last_frame_payload(&buf, stacks.len() as u32);
        assert_eq!(read_crust_layer_stack(&p).unwrap(), stacks);
    }

    #[test]
    fn unexpected_tag_is_rejected() {
        let payload = vec![0xAB, 0, 0, 0, 0];
        let err = read_cell_temperature(&payload).unwrap_err();
        match err {
            DecodeError::UnexpectedTag { expected, got } => {
                assert_eq!(expected, TAG_CELL_TEMPERATURE_K);
                assert_eq!(got, 0xAB);
            }
            other => panic!("wrong error: {:?}", other),
        }
    }
}
