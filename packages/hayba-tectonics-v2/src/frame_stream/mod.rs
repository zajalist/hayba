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
        writer.write_all(&((master_seed >> 32) as u32).to_le_bytes())?;

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

    /// Flush + return the inner writer.
    pub fn finish(mut self) -> io::Result<W> {
        self.writer.flush()?;
        Ok(self.writer)
    }
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
}
