//! Binary delta-stream encoder for tectonic animation playback (Sprint A1).
//!
//! Emits a compact tagged binary stream of per-macro-step state deltas plus
//! periodic keyframes. The viewer decodes this stream to scrub through
//! ~1.25 Ga of geological history without re-running the sim.
//!
//! Format (little-endian everywhere) — see
//! `docs/superpowers/specs/2026-05-12-animation-backbone-sprint.md`:
//!
//! ```text
//! Header (32 bytes):
//!   [u8;5] magic "HAYBA" + u8 version=1 + [u8;2] pad
//!   u32 total_frames, u32 n_cells, u32 dt_ma, u32 keyframe_stride,
//!   u32 master_seed, u32 reserved=0
//!
//! Initial state block (frame 0 full snapshot):
//!   7 per-cell arrays, then plate blocks, then MOR blocks.
//!
//! Per-frame record:
//!   u32 frame_idx, u32 payload_byte_count, <payload bytes>
//! ```
//!
//! Tags (see module-private constants below): per-cell deltas 0x01..=0x07,
//! plate registry diffs 0x10..=0x13, plate lifecycle events 0x14..=0x16,
//! MOR events 0x20..=0x21, boundary polylines 0x30, and a 0x40 keyframe marker that
//! prefixes a full duplicate snapshot.
//!
//! ### Plate lifecycle events (0x14..=0x16)
//!
//! Explicit per-frame event records pushed by the macro-step loop via
//! [`FrameEncoder::push_event`]. Distinct from the diff-detected 0x10/0x11
//! registry-membership tags: lifecycle events count the *reason* a plate was
//! born / died / a rift failed, so the viewer can show non-frozen counters
//! for spawns / deaths / passive splits / failed rifts even when the cell
//! grid is otherwise stable.
//!
//! Payloads (little-endian, no length prefix — payload size is fixed per tag):
//!
//! - `0x14` PLATE_DEATH: `u32 plate_id`, `u8 reason` (0=zero_cells, 1=merge,
//!   2=other).
//! - `0x15` PLATE_PASSIVE_SPLIT: `u32 parent_id`, `u32 child_id`.
//! - `0x16` FAILED_RIFT: `u32 parent_id`, `u32 representative_cell` (any one
//!   cell that was part of the failed rift trace; viewer can use this to
//!   place a marker but treats it as informational only).
//!
//! Spawn events (rift-fork and passive-split) reuse the existing 0x10
//! PLATE_SPAWN payload that the diff loop already emits per new plate slot
//! — those are NOT duplicated here. The 0x15 PASSIVE_SPLIT record is a
//! *qualifier* the viewer can pair with a 0x10 SPAWN for the same id to
//! categorize that spawn as "passive" vs "rift fork". Likewise, the 0x11
//! PLATE_RETIRE diff record is still emitted on death; 0x14 PLATE_DEATH
//! adds the reason byte alongside.
//!
//! ## Determinism
//!
//! The encoder is READ-ONLY with respect to sim state. Same master seed →
//! byte-identical world.bin output.

use std::io;

use crate::boundaries::BoundaryPolyline;
use crate::crust_state::{Composition, CrustState};
use crate::mesh::Vec3f;
use crate::mor::MorRegistry;
use crate::motion::PlateMotion;
use crate::plates::PlateAssignment;

/// Elevation deltas smaller than this (in metres) are dropped from the
/// per-frame stream. Keeps the stream compact by ignoring the relaxation
/// jitter that every cell does each step.
pub const ELEVATION_DELTA_THRESHOLD: i32 = 10;

// ── Tag identifiers ────────────────────────────────────────────────────
const TAG_CELL_PLATE:        u8 = 0x01;
const TAG_ELEV:              u8 = 0x02;
const TAG_COMPOSITION:       u8 = 0x03;
const TAG_RIFT_PROGRESS:     u8 = 0x04;
const TAG_FAILED_RIFT_AGE:   u8 = 0x05;
const TAG_LIP_AGE:           u8 = 0x06;
const TAG_VOLCANIC_ACT:      u8 = 0x07;
const TAG_CELL_AGE_MA:       u8 = 0x08;
const TAG_PLATE_SPAWN:       u8 = 0x10;
const TAG_PLATE_RETIRE:      u8 = 0x11;
const TAG_PLATE_MOTION:      u8 = 0x12;
const TAG_PLATE_SEED:        u8 = 0x13;
const TAG_PLATE_DEATH:       u8 = 0x14;
const TAG_PASSIVE_SPLIT:     u8 = 0x15;
const TAG_FAILED_RIFT:       u8 = 0x16;
const TAG_MOR_SPAWN:         u8 = 0x20;
const TAG_MOR_RETIRE:        u8 = 0x21;
/// Per-frame boundary polyline record. Lets the viewer match boundary
/// lines to the actual cell-ownership transitions at every frame instead
/// of relying on a static frame-0 snapshot.
pub const TAG_BOUNDARY_POLYLINES: u8 = 0x30;
const TAG_KEYFRAME:          u8 = 0x40;

/// Marker used in plate-spawn records when the plate has no parent (init-time
/// plates). The viewer treats `0xFFFFFFFF` as "no parent."
const NO_PARENT: u32 = 0xFFFF_FFFF;

/// Lifecycle reason byte for `PLATE_DEATH` (0x14) records. See module-level
/// doc for the encoding the JS decoder is expected to interpret.
#[repr(u8)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DeathReason {
    /// Plate's cell count dropped to zero (`retire_zero_cell_plates`).
    ZeroCells = 0,
    /// Plate was merged into a neighbour (`merge_into`).
    Merge = 1,
    /// Any other path that retires a plate.
    Other = 2,
}

/// Per-frame lifecycle event pushed by the macro-step loop via
/// [`FrameEncoder::push_event`]. Drained and serialized at the end of
/// [`FrameEncoder::write_frame`].
///
/// Spawn events are split into RiftFork vs Passive so the viewer can
/// surface the cause; both flavours also produce a 0x10 PLATE_SPAWN diff
/// record from the existing registry-diff loop — these enum variants only
/// emit the *qualifying* 0x15 PASSIVE_SPLIT tag (rift forks emit nothing
/// extra because the bare 0x10 already implies "rift fork unless paired
/// with 0x15").
#[derive(Debug, Clone, Copy)]
pub enum FrameEvent {
    /// Plate died this frame. Emitted as 0x14 PLATE_DEATH alongside the
    /// existing 0x11 PLATE_RETIRE diff record.
    Death { plate_id: u32, reason: DeathReason },
    /// Passive-split spawn (one CC pinched off by neighbour stress, not a
    /// rift). Emitted as 0x15 PASSIVE_SPLIT to qualify the 0x10 SPAWN.
    PassiveSplit { parent_id: u32, child_id: u32 },
    /// A rift component matured but failed to sever its parent. Emitted as
    /// 0x16 FAILED_RIFT with a representative cell index.
    FailedRift { plate_id: u32, representative_cell: u32 },
}

/// Streaming encoder that accumulates the binary playback log in a single
/// `Vec<u8>` and exposes it via [`FrameEncoder::finish`].
pub struct FrameEncoder {
    /// Output buffer; finalized stream returned by [`finish`].
    pub buf: Vec<u8>,
    pub total_frames: u32,
    pub n_cells: u32,
    pub dt_ma: u32,
    pub keyframe_stride: u32,
    pub master_seed: u32,

    // Previous-frame snapshots for diffing. Sized after the first call to
    // `write_initial_state`. Per-cell arrays mirror `CrustState` shape.
    prev_cell_plate: Vec<u32>,
    prev_elev: Vec<i16>,
    prev_composition: Vec<Composition>,
    prev_rift_progress: Vec<u8>,
    prev_failed_rift_age: Vec<u16>,
    prev_lip_age: Vec<u16>,
    prev_volcanic_act: Vec<u8>,
    prev_age_ma: Vec<u16>,

    // Plate registry diff state. Index = plate id.
    prev_plate_live: Vec<bool>,
    prev_plate_seed: Vec<Vec3f>,
    prev_plate_omega: Vec<Vec3f>,

    // MOR registry diff state. Index = mor id.
    prev_mor_live: Vec<bool>,

    /// Lifecycle events queued by `macro_step` since the last `write_frame`
    /// call. Drained and serialized as 0x14/0x15/0x16 records at the end of
    /// the next frame payload.
    pending_events: Vec<FrameEvent>,

    /// Pre-encoded 0x30 BOUNDARY_POLYLINES record bytes, staged by
    /// [`FrameEncoder::write_polylines`] before each `write_frame` call.
    /// Drained into the next frame payload like `pending_events`. Empty
    /// when no polylines were queued for the upcoming frame.
    pending_polyline_bytes: Vec<u8>,
}

impl FrameEncoder {
    pub fn new(total_frames: u32, n_cells: u32, dt_ma: u32, keyframe_stride: u32, master_seed: u32) -> Self {
        Self {
            buf: Vec::with_capacity(1 << 20),
            total_frames,
            n_cells,
            dt_ma,
            keyframe_stride,
            master_seed,
            prev_cell_plate: Vec::new(),
            prev_elev: Vec::new(),
            prev_composition: Vec::new(),
            prev_rift_progress: Vec::new(),
            prev_failed_rift_age: Vec::new(),
            prev_lip_age: Vec::new(),
            prev_volcanic_act: Vec::new(),
            prev_age_ma: Vec::new(),
            prev_plate_live: Vec::new(),
            prev_plate_seed: Vec::new(),
            prev_plate_omega: Vec::new(),
            prev_mor_live: Vec::new(),
            pending_events: Vec::new(),
            pending_polyline_bytes: Vec::new(),
        }
    }

    /// Queue a lifecycle event to be serialized at the end of the next
    /// [`FrameEncoder::write_frame`] call. Cheap; the queue is drained
    /// every frame so it never grows unbounded.
    pub fn push_event(&mut self, ev: FrameEvent) {
        self.pending_events.push(ev);
    }

    /// Stage a 0x30 BOUNDARY_POLYLINES record for the next frame. The
    /// record is length-prefixed (tag byte + u32 record-payload byte count
    /// + payload) so a tolerant JS decoder can skip over the variable-
    /// length record without knowing how to parse it. Drained by the next
    /// [`FrameEncoder::write_frame`] call.
    ///
    /// Payload layout (LE):
    /// ```text
    /// u16 n_polylines
    /// for each polyline:
    ///     u32 plate_a
    ///     u32 plate_b
    ///     u8  kind   // 0=Divergent, 1=Convergent, 2=Transform, 3=Oblique
    ///     u16 n_verts
    ///     for each vertex: 3 × f16  (x, y, z on the unit sphere)
    /// ```
    ///
    /// Returns `Ok` always — the encoder writes into an in-memory `Vec<u8>`
    /// and has no real IO failure modes. The `io::Result` signature is for
    /// future-proofing if we ever swap the buffer for a streaming writer.
    pub fn write_polylines(&mut self, polylines: &[BoundaryPolyline]) -> io::Result<()> {
        let n = polylines.len().min(u16::MAX as usize) as u16;
        // Serialize the payload into a temporary so we can length-prefix it.
        let mut payload: Vec<u8> = Vec::with_capacity(2 + polylines.len() * 16);
        payload.extend_from_slice(&n.to_le_bytes());
        for poly in polylines.iter().take(n as usize) {
            payload.extend_from_slice(&poly.plate_a.to_le_bytes());
            payload.extend_from_slice(&poly.plate_b.to_le_bytes());
            payload.push(poly.kind as u8);
            let nv = poly.vertices.len().min(u16::MAX as usize) as u16;
            payload.extend_from_slice(&nv.to_le_bytes());
            for v in poly.vertices.iter().take(nv as usize) {
                for &component in v.iter() {
                    let h = half::f16::from_f32(component);
                    payload.extend_from_slice(&h.to_le_bytes());
                }
            }
        }
        // Stage: [tag u8][u32 payload_len][payload bytes].
        self.pending_polyline_bytes.clear();
        self.pending_polyline_bytes.push(TAG_BOUNDARY_POLYLINES);
        let plen = payload.len() as u32;
        self.pending_polyline_bytes.extend_from_slice(&plen.to_le_bytes());
        self.pending_polyline_bytes.extend_from_slice(&payload);
        Ok(())
    }

    /// Consume the encoder and return the finalized byte stream.
    pub fn finish(self) -> Vec<u8> { self.buf }

    // ── Primitive writers (little-endian) ──────────────────────────────
    #[inline] fn w_u8(&mut self, v: u8)   { self.buf.push(v); }
    #[inline] fn w_u16(&mut self, v: u16) { self.buf.extend_from_slice(&v.to_le_bytes()); }
    #[inline] fn w_i16(&mut self, v: i16) { self.buf.extend_from_slice(&v.to_le_bytes()); }
    #[inline] fn w_u32(&mut self, v: u32) { self.buf.extend_from_slice(&v.to_le_bytes()); }
    #[inline] fn w_f32(&mut self, v: f32) { self.buf.extend_from_slice(&v.to_le_bytes()); }
    #[inline] fn w_vec3(&mut self, v: Vec3f) {
        self.w_f32(v.x as f32);
        self.w_f32(v.y as f32);
        self.w_f32(v.z as f32);
    }

    /// Write the 32-byte file header. Must be called once, before any state.
    pub fn write_header(&mut self) {
        debug_assert!(self.buf.is_empty(), "write_header must be called first");
        self.buf.extend_from_slice(b"HAYBA");          // 5 magic bytes
        self.w_u8(1);                                  // version
        self.w_u8(0); self.w_u8(0);                    // [u8;2] pad
        self.w_u32(self.total_frames);
        self.w_u32(self.n_cells);
        self.w_u32(self.dt_ma);
        self.w_u32(self.keyframe_stride);
        self.w_u32(self.master_seed);
        self.w_u32(0);                                 // reserved
        debug_assert_eq!(self.buf.len(), 32, "header must be exactly 32 bytes");
    }

    /// Write the frame-0 full snapshot and seed the diff baselines. The
    /// snapshot uses the same on-disk shape as a 0x40 keyframe payload.
    pub fn write_initial_state(
        &mut self,
        assignment: &PlateAssignment,
        crust: &CrustState,
        motions: &[Option<PlateMotion>],
        mors: Option<&MorRegistry>,
    ) {
        self.write_snapshot_body(assignment, crust, motions, mors);
        self.refresh_prev(assignment, crust, motions, mors);
    }

    /// Write one delta frame (or a full keyframe at the configured cadence)
    /// and update the prev_* baselines for the next call.
    pub fn write_frame(
        &mut self,
        frame_idx: u32,
        assignment: &PlateAssignment,
        crust: &CrustState,
        motions: &[Option<PlateMotion>],
        mors: Option<&MorRegistry>,
    ) {
        // frame_idx + placeholder payload_byte_count.
        self.w_u32(frame_idx);
        let len_offset = self.buf.len();
        self.w_u32(0); // patched at end of frame.
        let payload_start = self.buf.len();

        if self.keyframe_stride > 0 && frame_idx % self.keyframe_stride == 0 {
            self.w_u8(TAG_KEYFRAME);
            self.write_snapshot_body(assignment, crust, motions, mors);
        } else {
            self.write_deltas(assignment, crust, motions, mors);
        }

        // Drain lifecycle events queued by macro_step since the previous
        // frame. Each event becomes a tagged record inside this frame's
        // payload so the viewer can count them per-frame.
        let events = std::mem::take(&mut self.pending_events);
        for ev in events {
            match ev {
                FrameEvent::Death { plate_id, reason } => {
                    self.w_u8(TAG_PLATE_DEATH);
                    self.w_u32(plate_id);
                    self.w_u8(reason as u8);
                }
                FrameEvent::PassiveSplit { parent_id, child_id } => {
                    self.w_u8(TAG_PASSIVE_SPLIT);
                    self.w_u32(parent_id);
                    self.w_u32(child_id);
                }
                FrameEvent::FailedRift { plate_id, representative_cell } => {
                    self.w_u8(TAG_FAILED_RIFT);
                    self.w_u32(plate_id);
                    self.w_u32(representative_cell);
                }
            }
        }

        // Drain any staged BOUNDARY_POLYLINES record into this frame.
        if !self.pending_polyline_bytes.is_empty() {
            let poly_bytes = std::mem::take(&mut self.pending_polyline_bytes);
            self.buf.extend_from_slice(&poly_bytes);
        }

        let payload_len = (self.buf.len() - payload_start) as u32;
        // Patch the placeholder in place.
        let bytes = payload_len.to_le_bytes();
        self.buf[len_offset..len_offset + 4].copy_from_slice(&bytes);

        self.refresh_prev(assignment, crust, motions, mors);
    }

    // ── Snapshot helper (used by initial state + keyframe path) ────────
    fn write_snapshot_body(
        &mut self,
        assignment: &PlateAssignment,
        crust: &CrustState,
        motions: &[Option<PlateMotion>],
        mors: Option<&MorRegistry>,
    ) {
        let n = self.n_cells as usize;
        debug_assert_eq!(assignment.cell_plate.len(), n);
        debug_assert_eq!(crust.elevation_m.len(), n);

        // 8 per-cell arrays, in spec order.
        for &p in &assignment.cell_plate[..n] { self.w_u32(p); }
        for &e in &crust.elevation_m[..n]    { self.w_i16(e); }
        for &c in &crust.composition[..n]    { self.w_u8(c as u8); }
        for &r in &crust.rift_progress[..n]  { self.w_u8(r); }
        for &f in &crust.failed_rift_age_ma[..n] { self.w_u16(f); }
        for &l in &crust.lip_age_ma[..n]     { self.w_u16(l); }
        for &v in &crust.volcanic_act[..n]   { self.w_u8(v); }
        for &a in &crust.age_ma[..n]         { self.w_u16(a); }

        // Plate blocks.
        let live_plates: Vec<(u32, &crate::plates::Plate)> = assignment.live_plates().collect();
        self.w_u32(live_plates.len() as u32);
        for (id, plate) in &live_plates {
            self.w_u32(*id);
            self.w_u32(plate.parent_id.unwrap_or(NO_PARENT));
            self.w_u8(plate.color[0]); self.w_u8(plate.color[1]); self.w_u8(plate.color[2]);
            self.w_vec3(plate.seed_pos);
            let omega = motions.get(*id as usize)
                .and_then(|m| m.as_ref())
                .map(|m| m.omega)
                .unwrap_or_default();
            self.w_vec3(omega);
            self.w_u32(plate.birth_macro_step);
        }

        // MOR blocks.
        let live_mors: Vec<(u32, &crate::mor::MidOceanRidge)> = mors
            .map(|m| m.live_ridges().collect::<Vec<_>>())
            .unwrap_or_default();
        self.w_u32(live_mors.len() as u32);
        for (id, ridge) in &live_mors {
            self.write_mor_block(*id, ridge);
        }
    }

    fn write_mor_block(&mut self, id: u32, ridge: &crate::mor::MidOceanRidge) {
        self.w_u32(id);
        self.w_u32(ridge.flanking_plate_ids.0);
        self.w_u32(ridge.flanking_plate_ids.1);
        self.w_f32(ridge.spreading_rate as f32);
        self.w_u16(ridge.axis.len() as u16);
        for v in &ridge.axis { self.w_vec3(*v); }
        self.w_u16(ridge.transform_segments.len() as u16);
        for &(s, e, o) in &ridge.transform_segments {
            self.w_f32(s as f32);
            self.w_f32(e as f32);
            self.w_f32(o as f32);
        }
    }

    // ── Delta emission ─────────────────────────────────────────────────
    fn write_deltas(
        &mut self,
        assignment: &PlateAssignment,
        crust: &CrustState,
        motions: &[Option<PlateMotion>],
        mors: Option<&MorRegistry>,
    ) {
        let n = self.n_cells as usize;

        // Per-cell deltas.
        for i in 0..n {
            let np = assignment.cell_plate[i];
            if np != self.prev_cell_plate[i] {
                self.w_u8(TAG_CELL_PLATE);
                self.w_u32(i as u32);
                self.w_u32(np);
            }
        }
        for i in 0..n {
            let ne = crust.elevation_m[i];
            let pe = self.prev_elev[i];
            if (ne as i32 - pe as i32).abs() >= ELEVATION_DELTA_THRESHOLD {
                self.w_u8(TAG_ELEV);
                self.w_u32(i as u32);
                self.w_i16(ne);
            }
        }
        for i in 0..n {
            let nc = crust.composition[i];
            if nc as u8 != self.prev_composition[i] as u8 {
                self.w_u8(TAG_COMPOSITION);
                self.w_u32(i as u32);
                self.w_u8(nc as u8);
            }
        }
        for i in 0..n {
            let nv = crust.rift_progress[i];
            if nv != self.prev_rift_progress[i] {
                self.w_u8(TAG_RIFT_PROGRESS);
                self.w_u32(i as u32);
                self.w_u8(nv);
            }
        }
        for i in 0..n {
            let nv = crust.failed_rift_age_ma[i];
            if nv != self.prev_failed_rift_age[i] {
                self.w_u8(TAG_FAILED_RIFT_AGE);
                self.w_u32(i as u32);
                self.w_u16(nv);
            }
        }
        for i in 0..n {
            let nv = crust.lip_age_ma[i];
            if nv != self.prev_lip_age[i] {
                self.w_u8(TAG_LIP_AGE);
                self.w_u32(i as u32);
                self.w_u16(nv);
            }
        }
        for i in 0..n {
            let nv = crust.volcanic_act[i];
            if nv != self.prev_volcanic_act[i] {
                self.w_u8(TAG_VOLCANIC_ACT);
                self.w_u32(i as u32);
                self.w_u8(nv);
            }
        }
        for i in 0..n {
            let nv = crust.age_ma[i];
            if nv != self.prev_age_ma[i] {
                self.w_u8(TAG_CELL_AGE_MA);
                self.w_u32(i as u32);
                self.w_u16(nv);
            }
        }

        // Plate diffs. The registry is monotonic — slots only grow, retired
        // slots stay None forever. Walk the full registry once.
        let cur_len = assignment.plates.len();
        // Spawns / motion / seed-pos changes for live slots.
        for id in 0..cur_len {
            let was_live = self.prev_plate_live.get(id).copied().unwrap_or(false);
            let plate = assignment.plates.get(id).and_then(|p| p.as_ref());
            let omega = motions
                .get(id)
                .and_then(|m| m.as_ref())
                .map(|m| m.omega)
                .unwrap_or_default();
            match (was_live, plate) {
                (false, Some(p)) => {
                    self.w_u8(TAG_PLATE_SPAWN);
                    self.w_u32(id as u32);
                    self.w_u32(p.parent_id.unwrap_or(NO_PARENT));
                    self.w_u8(p.color[0]); self.w_u8(p.color[1]); self.w_u8(p.color[2]);
                    self.w_vec3(p.seed_pos);
                    self.w_vec3(omega);
                    // Bug 1 fix: snapshot/keyframe plate blocks include
                    // birth_macro_step; the JS decoder reads it for every
                    // plate block — including PLATE_SPAWN deltas — so the
                    // delta encoder must emit it too, otherwise the JS reader
                    // overruns the payload by 4 bytes on any frame with a
                    // mid-sim spawn (e.g. frame 17 of world.bin @ seed 12345).
                    self.w_u32(p.birth_macro_step);
                }
                (true, Some(p)) => {
                    // Motion change?
                    if let Some(prev_om) = self.prev_plate_omega.get(id).copied() {
                        if !vec3_eq(prev_om, omega) {
                            self.w_u8(TAG_PLATE_MOTION);
                            self.w_u32(id as u32);
                            self.w_vec3(omega);
                        }
                    }
                    // Seed refresh?
                    if let Some(prev_seed) = self.prev_plate_seed.get(id).copied() {
                        if !vec3_eq(prev_seed, p.seed_pos) {
                            self.w_u8(TAG_PLATE_SEED);
                            self.w_u32(id as u32);
                            self.w_vec3(p.seed_pos);
                        }
                    }
                }
                (true, None) => {
                    self.w_u8(TAG_PLATE_RETIRE);
                    self.w_u32(id as u32);
                }
                (false, None) => {}
            }
        }

        // MOR diffs. Same monotonic-slot pattern.
        if let Some(mor_reg) = mors {
            let mor_len = mor_reg.ridges.len();
            for id in 0..mor_len {
                let was_live = self.prev_mor_live.get(id).copied().unwrap_or(false);
                let ridge = mor_reg.ridges.get(id).and_then(|r| r.as_ref());
                match (was_live, ridge) {
                    (false, Some(r)) => {
                        self.w_u8(TAG_MOR_SPAWN);
                        self.write_mor_block(id as u32, r);
                    }
                    (true, None) => {
                        self.w_u8(TAG_MOR_RETIRE);
                        self.w_u32(id as u32);
                    }
                    _ => {}
                }
            }
        }
    }

    // ── Snapshot prev_* arrays after every frame ───────────────────────
    fn refresh_prev(
        &mut self,
        assignment: &PlateAssignment,
        crust: &CrustState,
        motions: &[Option<PlateMotion>],
        mors: Option<&MorRegistry>,
    ) {
        self.prev_cell_plate.clear();
        self.prev_cell_plate.extend_from_slice(&assignment.cell_plate);
        self.prev_elev.clear();
        self.prev_elev.extend_from_slice(&crust.elevation_m);
        self.prev_composition.clear();
        self.prev_composition.extend_from_slice(&crust.composition);
        self.prev_rift_progress.clear();
        self.prev_rift_progress.extend_from_slice(&crust.rift_progress);
        self.prev_failed_rift_age.clear();
        self.prev_failed_rift_age.extend_from_slice(&crust.failed_rift_age_ma);
        self.prev_lip_age.clear();
        self.prev_lip_age.extend_from_slice(&crust.lip_age_ma);
        self.prev_volcanic_act.clear();
        self.prev_volcanic_act.extend_from_slice(&crust.volcanic_act);
        self.prev_age_ma.clear();
        self.prev_age_ma.extend_from_slice(&crust.age_ma);

        let n_plates = assignment.plates.len();
        self.prev_plate_live.resize(n_plates, false);
        self.prev_plate_seed.resize(n_plates, Vec3f::new(0.0, 0.0, 0.0));
        self.prev_plate_omega.resize(n_plates, Vec3f::new(0.0, 0.0, 0.0));
        for id in 0..n_plates {
            match &assignment.plates[id] {
                Some(p) => {
                    self.prev_plate_live[id] = true;
                    self.prev_plate_seed[id] = p.seed_pos;
                    self.prev_plate_omega[id] = motions
                        .get(id)
                        .and_then(|m| m.as_ref())
                        .map(|m| m.omega)
                        .unwrap_or_default();
                }
                None => {
                    self.prev_plate_live[id] = false;
                }
            }
        }

        if let Some(mor_reg) = mors {
            let n_mors = mor_reg.ridges.len();
            self.prev_mor_live.resize(n_mors, false);
            for id in 0..n_mors {
                self.prev_mor_live[id] = mor_reg.ridges[id].is_some();
            }
        }
    }
}

#[inline]
fn vec3_eq(a: Vec3f, b: Vec3f) -> bool {
    a.x.to_bits() == b.x.to_bits() && a.y.to_bits() == b.y.to_bits() && a.z.to_bits() == b.z.to_bits()
}

// ───────────────────────────────────────────────────────────────────────
// Tests
// ───────────────────────────────────────────────────────────────────────
#[cfg(test)]
mod tests {
    use super::*;
    use crate::adjacency::Adjacency;
    use crate::crust_state::{CrustOptions, CrustState};
    use crate::mesh::Icosphere;
    use crate::motion::sample_plate_motions;
    use crate::plates::{BuildOptions, PlateAssignment};
    use hayba_seeds::MasterSeed;

    fn synthetic_world(seed: u64) -> (Icosphere, PlateAssignment, Vec<Option<PlateMotion>>, CrustState, Adjacency) {
        let sphere = Icosphere::new(3);
        let mut plates = PlateAssignment::build(
            MasterSeed(seed),
            &sphere,
            BuildOptions { plate_count: 8, ..BuildOptions::default() },
        );
        let mut motions = sample_plate_motions(MasterSeed(seed), 8);
        plates.prune_empty(&mut motions);
        let seed_positions: Vec<Vec3f> = plates.plates.iter()
            .map(|p| p.as_ref().map(|p| p.seed_pos).unwrap_or_default())
            .collect();
        let crust = CrustState::initial(
            MasterSeed(seed),
            &sphere.vertices,
            &mut plates,
            &seed_positions,
            CrustOptions::default(),
        );
        let adj = Adjacency::build(&sphere);
        (sphere, plates, motions, crust, adj)
    }

    /// Helper: parse a u32 little-endian from a byte slice.
    fn read_u32(buf: &[u8], off: usize) -> u32 {
        u32::from_le_bytes(buf[off..off + 4].try_into().unwrap())
    }

    #[test]
    fn header_round_trip() {
        let mut enc = FrameEncoder::new(/*total*/ 250, /*n_cells*/ 1234, /*dt*/ 5, /*stride*/ 10, /*seed*/ 12345);
        enc.write_header();
        let bytes = enc.finish();
        assert_eq!(bytes.len(), 32, "header is exactly 32 bytes");
        assert_eq!(&bytes[0..5], b"HAYBA");
        assert_eq!(bytes[5], 1, "version=1");
        assert_eq!(bytes[6], 0);
        assert_eq!(bytes[7], 0);
        assert_eq!(read_u32(&bytes, 8),  250);
        assert_eq!(read_u32(&bytes, 12), 1234);
        assert_eq!(read_u32(&bytes, 16), 5);
        assert_eq!(read_u32(&bytes, 20), 10);
        assert_eq!(read_u32(&bytes, 24), 12345);
        assert_eq!(read_u32(&bytes, 28), 0);
    }

    /// Scan the buffer for keyframe tags. Returns the frame_idx of every
    /// frame record whose first payload byte is TAG_KEYFRAME (0x40).
    ///
    /// Parser walks frame records (u32 idx, u32 len, payload[len]) starting
    /// at the offset just after the initial state block, which the caller
    /// supplies.
    fn scan_keyframe_frame_indices(buf: &[u8], start: usize) -> Vec<u32> {
        let mut out = Vec::new();
        let mut off = start;
        while off + 8 <= buf.len() {
            let idx = read_u32(buf, off);
            let len = read_u32(buf, off + 4) as usize;
            let payload_start = off + 8;
            if payload_start + len > buf.len() { break; }
            if len > 0 && buf[payload_start] == TAG_KEYFRAME {
                out.push(idx);
            }
            off = payload_start + len;
        }
        out
    }

    #[test]
    fn keyframe_at_correct_intervals() {
        let (_sphere, assignment, motions, crust, _adj) = synthetic_world(42);
        let n_cells = assignment.cell_plate.len() as u32;
        let stride = 10u32;
        let mut enc = FrameEncoder::new(21, n_cells, 5, stride, 42);
        enc.write_header();
        let header_end = enc.buf.len();
        enc.write_initial_state(&assignment, &crust, &motions, None);
        let init_end = enc.buf.len();
        assert!(init_end > header_end);

        // Emit 21 frames (0..=20) so frame_idx 0, 10, 20 are keyframes.
        for f in 0..21 {
            enc.write_frame(f, &assignment, &crust, &motions, None);
        }
        let buf = enc.finish();
        let kf_indices = scan_keyframe_frame_indices(&buf, init_end);
        assert_eq!(kf_indices, vec![0, 10, 20],
            "keyframe markers must land on multiples of stride={}", stride);
    }

    #[test]
    fn delta_diffs_against_prev() {
        let (_sphere, assignment, motions, crust, _adj) = synthetic_world(7);
        let n_cells = assignment.cell_plate.len() as u32;
        // Stride large enough that frame 1 is a delta frame (not a keyframe).
        let mut enc = FrameEncoder::new(2, n_cells, 5, 100, 7);
        enc.write_header();
        enc.write_initial_state(&assignment, &crust, &motions, None);

        // Mutate one cell's plate id between the two frames.
        let mut a2 = assignment.clone();
        // Find a cell whose plate id we can validly swap to another live id.
        let live_ids: Vec<u32> = a2.live_plates().map(|(id, _)| id).collect();
        assert!(live_ids.len() >= 2, "need at least 2 live plates");
        let victim_idx = 0usize;
        let cur = a2.cell_plate[victim_idx];
        let new = *live_ids.iter().find(|&&id| id != cur).unwrap();
        a2.cell_plate[victim_idx] = new;

        // Frame 1 must be a delta frame (stride=100, idx=1 → 1 % 100 != 0).
        let len_before = enc.buf.len();
        enc.write_frame(1, &a2, &crust, &motions, None);
        let frame_bytes = &enc.buf[len_before..];

        // frame_bytes layout: u32 idx, u32 payload_len, payload...
        assert_eq!(read_u32(frame_bytes, 0), 1);
        let payload_len = read_u32(frame_bytes, 4) as usize;
        let payload = &frame_bytes[8..8 + payload_len];
        assert!(!payload.is_empty());
        assert_ne!(payload[0], TAG_KEYFRAME, "frame 1 must be a delta, not a keyframe");

        // Walk the payload, count cell-plate records.
        let mut off = 0usize;
        let mut cell_plate_records = 0usize;
        let mut saw_target_cell = false;
        while off < payload.len() {
            let tag = payload[off];
            off += 1;
            match tag {
                TAG_CELL_PLATE => {
                    let idx = read_u32(payload, off); off += 4;
                    let new_p = read_u32(payload, off); off += 4;
                    cell_plate_records += 1;
                    if idx as usize == victim_idx {
                        assert_eq!(new_p, new);
                        saw_target_cell = true;
                    }
                }
                // Other tags shouldn't appear here because nothing else
                // changed — but accept and skip anyway in case of surprise.
                TAG_ELEV              => { off += 4 + 2; }
                TAG_COMPOSITION       => { off += 4 + 1; }
                TAG_RIFT_PROGRESS     => { off += 4 + 1; }
                TAG_FAILED_RIFT_AGE   => { off += 4 + 2; }
                TAG_LIP_AGE           => { off += 4 + 2; }
                TAG_VOLCANIC_ACT      => { off += 4 + 1; }
                TAG_CELL_AGE_MA       => { off += 4 + 2; }
                TAG_PLATE_MOTION      => { off += 4 + 12; }
                TAG_PLATE_SEED        => { off += 4 + 12; }
                TAG_PLATE_RETIRE      => { off += 4; }
                other => panic!("unexpected tag 0x{:02X} at off {}", other, off - 1),
            }
        }
        assert_eq!(cell_plate_records, 1,
            "exactly one cell_plate delta should fire for a single-cell mutation");
        assert!(saw_target_cell, "the mutation must show up in the stream");
    }

    /// Walk the buffer, counting each lifecycle tag. Returns
    /// (death, passive_split, failed_rift, spawn) tallies summed across all
    /// per-frame records (skips the header + initial-state block via the
    /// caller-supplied `start` offset). Keyframe payloads are skipped — they
    /// embed a full snapshot, not a tag stream.
    fn scan_lifecycle_counts(buf: &[u8], start: usize) -> (u32, u32, u32, u32) {
        let mut death = 0u32;
        let mut passive = 0u32;
        let mut failed = 0u32;
        let mut spawn = 0u32;
        let mut off = start;
        while off + 8 <= buf.len() {
            let _idx = read_u32(buf, off);
            let len = read_u32(buf, off + 4) as usize;
            let payload_start = off + 8;
            if payload_start + len > buf.len() { break; }
            if len > 0 && buf[payload_start] != TAG_KEYFRAME {
                let payload = &buf[payload_start..payload_start + len];
                let mut p = 0usize;
                while p < payload.len() {
                    let tag = payload[p]; p += 1;
                    match tag {
                        TAG_CELL_PLATE        => { p += 4 + 4; }
                        TAG_ELEV              => { p += 4 + 2; }
                        TAG_COMPOSITION       => { p += 4 + 1; }
                        TAG_RIFT_PROGRESS     => { p += 4 + 1; }
                        TAG_FAILED_RIFT_AGE   => { p += 4 + 2; }
                        TAG_LIP_AGE           => { p += 4 + 2; }
                        TAG_VOLCANIC_ACT      => { p += 4 + 1; }
                        TAG_CELL_AGE_MA       => { p += 4 + 2; }
                        TAG_PLATE_SPAWN       => { spawn += 1; p += 4 + 4 + 3 + 12 + 12 + 4; }
                        TAG_PLATE_RETIRE      => { p += 4; }
                        TAG_PLATE_MOTION      => { p += 4 + 12; }
                        TAG_PLATE_SEED        => { p += 4 + 12; }
                        TAG_PLATE_DEATH       => { death += 1; p += 4 + 1; }
                        TAG_PASSIVE_SPLIT     => { passive += 1; p += 4 + 4; }
                        TAG_FAILED_RIFT       => { failed += 1; p += 4 + 4; }
                        _ => {
                            // Defensive bail-out on unrecognized tags (MOR
                            // records are variable-length; this test runs
                            // without a MOR registry so they should not
                            // appear, but skip the rest of this payload if
                            // they ever do).
                            break;
                        }
                    }
                }
            }
            off = payload_start + len;
        }
        (death, passive, failed, spawn)
    }

    /// Seed 12345 is the canonical preview seed (`tectonic-preview 12345`).
    /// The macro-step loop should emit at least one 0x10 PLATE_SPAWN per
    /// fork/passive-split that fired and at least one 0x14 PLATE_DEATH per
    /// retired plate. Confirms the encoder hook fires on the same code
    /// paths that bump `metrics.spawn_count` / `metrics.death_count`.
    #[test]
    fn lifecycle_events_emit_on_seed_12345() {
        use crate::ca_evolution::{evolve_ca_with_encoder, EvolutionOptions};
        use crate::metrics::Metrics;

        let seed: u64 = 12345;
        let sphere = Icosphere::new(5);
        let adj = Adjacency::build(&sphere);
        let mut plates = PlateAssignment::build(
            MasterSeed(seed),
            &sphere,
            BuildOptions { plate_count: 20, ..BuildOptions::default() },
        );
        let mut motions = sample_plate_motions(MasterSeed(seed), 20);
        plates.prune_empty(&mut motions);
        let seed_positions: Vec<Vec3f> = plates.plates.iter()
            .map(|p| p.as_ref().map(|p| p.seed_pos).unwrap_or_default())
            .collect();
        let mut crust = CrustState::initial(
            MasterSeed(seed),
            &sphere.vertices,
            &mut plates,
            &seed_positions,
            CrustOptions::default(),
        );

        let macro_steps = 150u32;
        let n_cells = sphere.vertices.len() as u32;
        let mut encoder = FrameEncoder::new(macro_steps + 1, n_cells, 5, 10, seed as u32);
        encoder.write_header();
        let header_end = encoder.buf.len();
        encoder.write_initial_state(&plates, &crust, &motions, None);
        let init_end = encoder.buf.len();
        assert!(init_end > header_end);

        let mut metrics = Metrics::new();
        let _stats = evolve_ca_with_encoder(
            &mut plates,
            &mut crust,
            &sphere.vertices,
            &adj,
            &mut motions,
            EvolutionOptions { macro_steps, ..Default::default() },
            &mut metrics,
            &mut encoder,
        );

        let buf = encoder.finish();
        let (death, passive, failed, spawn) = scan_lifecycle_counts(&buf, init_end);

        // Spawns are emitted by the registry-diff loop (0x10) for any
        // post-initial plate allocation — known to fire on seed 12345.
        assert!(
            spawn > 0,
            "expected at least one 0x10 PLATE_SPAWN event on seed {} (got {})",
            seed, spawn,
        );
        // Deaths land via retire_zero_cell_plates → push_event Death. With
        // 20 plates on a level-5 icosphere over 60 macro-steps the smallest
        // plates almost always get absorbed; if this ever flakes, raise
        // macro_steps or plate_count.
        assert!(
            death > 0,
            "expected at least one 0x14 PLATE_DEATH event on seed {} (got {})",
            seed, death,
        );
        // Passive splits + failed rifts are seed-dependent; the canonical
        // preview-length (250-step) run sees hundreds of failed rifts per
        // metrics.aulacogen_count. Just confirm the counters are tracked.
        let _ = passive;
        let _ = failed;
    }

    // ─────────────────────────────────────────────────────────────────────
    // Bug-fix regression tests (timeline wiring): record-length audit,
    // keyframe stride, cell_age_ma tag 0x08.
    // ─────────────────────────────────────────────────────────────────────

    /// Plate-block size used by both the initial-state snapshot and the
    /// PLATE_SPAWN delta record after Bug 1 fix:
    /// id(4) + parent(4) + color(3) + seed(12) + omega(12) + birth_macro_step(4) = 39 bytes.
    const PLATE_BLOCK_BYTES: usize = 4 + 4 + 3 + 12 + 12 + 4;

    /// Per-cell snapshot bytes after Bug 3 fix:
    /// u32 + i16 + u8 + u8 + u16 + u16 + u8 + u16 = 15 bytes.
    const SNAPSHOT_CELL_BYTES: usize = 4 + 2 + 1 + 1 + 2 + 2 + 1 + 2;

    fn read_u16_at(buf: &[u8], off: usize) -> u16 {
        u16::from_le_bytes(buf[off..off + 2].try_into().unwrap())
    }

    /// Compute the byte length of one snapshot body (initial state OR the
    /// payload immediately after a 0x40 keyframe tag). Asserts 0 MORs (tests
    /// run without a MOR registry).
    fn snapshot_body_len(buf: &[u8], start: usize, n_cells: usize) -> usize {
        let mut off = start + n_cells * SNAPSHOT_CELL_BYTES;
        let n_plates = read_u32(buf, off) as usize;
        off += 4 + n_plates * PLATE_BLOCK_BYTES;
        let n_mors = read_u32(buf, off) as usize;
        off += 4;
        assert_eq!(n_mors, 0, "snapshot_body_len: tests assume 0 MORs");
        off - start
    }

    /// Walk one delta payload, advancing exactly the number of bytes each
    /// tag's schema declares, and confirm we land on `payload.len()`.
    fn audit_delta_payload(payload: &[u8]) -> Result<(), String> {
        let mut off = 0usize;
        while off < payload.len() {
            let start = off;
            let tag = payload[off];
            off += 1;
            let consumed = match tag {
                TAG_CELL_PLATE        => 4 + 4,
                TAG_ELEV              => 4 + 2,
                TAG_COMPOSITION       => 4 + 1,
                TAG_RIFT_PROGRESS     => 4 + 1,
                TAG_FAILED_RIFT_AGE   => 4 + 2,
                TAG_LIP_AGE           => 4 + 2,
                TAG_VOLCANIC_ACT      => 4 + 1,
                TAG_CELL_AGE_MA       => 4 + 2,
                TAG_PLATE_SPAWN       => PLATE_BLOCK_BYTES,
                TAG_PLATE_RETIRE      => 4,
                TAG_PLATE_MOTION      => 4 + 12,
                TAG_PLATE_SEED        => 4 + 12,
                TAG_PLATE_DEATH       => 4 + 1,
                TAG_PASSIVE_SPLIT     => 4 + 4,
                TAG_FAILED_RIFT       => 4 + 4,
                TAG_MOR_RETIRE        => 4,
                other => return Err(format!(
                    "tag 0x{:02X} at off {} not handled by audit table", other, start
                )),
            };
            if off + consumed > payload.len() {
                return Err(format!(
                    "tag 0x{:02X} at off {} would read past payload end ({} + {} > {})",
                    tag, start, off, consumed, payload.len()
                ));
            }
            let record_len = 1 + consumed;
            debug_assert_eq!(off + consumed - start, record_len);
            off += consumed;
        }
        if off != payload.len() {
            return Err(format!(
                "payload audit ended at {} but len is {}", off, payload.len()
            ));
        }
        Ok(())
    }

    /// **Bug 1 regression** — every record in every frame's payload must
    /// consume exactly the bytes its tag schema declares, and the per-frame
    /// `payload_byte_count` header must match the actual written length.
    ///
    /// Reproduces the frame-17 over/underrun (a PLATE_SPAWN delta that
    /// omitted `birth_macro_step`, 4 bytes shorter than the snapshot/keyframe
    /// plate block).
    #[test]
    fn every_record_length_matches_declared() {
        let (_sphere, mut assignment, mut motions, mut crust, _adj) = synthetic_world(12345);
        let n_cells = assignment.cell_plate.len() as u32;
        let total = 30u32;
        let stride = 10u32;
        let mut enc = FrameEncoder::new(total, n_cells, 5, stride, 12345);
        enc.write_header();
        enc.write_initial_state(&assignment, &crust, &motions, None);

        let init_total = enc.buf.len();
        let expected = 32 + snapshot_body_len(&enc.buf, 32, n_cells as usize);
        assert_eq!(init_total, expected,
            "initial state body length mismatch: wrote {} bytes, math says {}",
            init_total, expected);

        // Mid-sim spawn at frame 5 forces the PLATE_SPAWN delta path; also
        // perturb elevation to flush cell deltas every frame.
        for f in 1..=total {
            if f == 5 {
                let new_id = assignment.plates.len() as u32;
                assignment.plates.push(Some(crate::plates::Plate {
                    id: new_id,
                    seed_pos: Vec3f::new(0.0, 0.0, 1.0),
                    color: [200, 50, 25],
                    parent_id: Some(0),
                    birth_macro_step: f,
                    last_division_step: None,
                    age_since_last_split: 0,
                }));
                assignment.plate_composition.push(Some(Composition::Oceanic));
                motions.push(None);
            }
            crust.elevation_m[(f as usize) % n_cells as usize] = (f as i16) * 100;
            enc.write_frame(f, &assignment, &crust, &motions, None);
        }

        let buf = enc.finish();
        let mut off = expected;
        let mut frames_audited = 0u32;
        let mut saw_spawn = false;
        while off + 8 <= buf.len() {
            let idx = read_u32(&buf, off);
            let plen = read_u32(&buf, off + 4) as usize;
            assert!(off + 8 + plen <= buf.len(),
                "frame {} declares len {} which spills past buf end", idx, plen);
            let payload = &buf[off + 8..off + 8 + plen];
            if !payload.is_empty() && payload[0] == TAG_KEYFRAME {
                let body = snapshot_body_len(&buf, off + 8 + 1, n_cells as usize);
                assert_eq!(body + 1, plen,
                    "frame {} keyframe payload mismatch: declared {} actual {}",
                    idx, plen, body + 1);
            } else {
                audit_delta_payload(payload).unwrap_or_else(|e| {
                    panic!("frame {} payload audit: {}", idx, e);
                });
                if payload.iter().any(|&b| b == TAG_PLATE_SPAWN) {
                    saw_spawn = true;
                }
            }
            off += 8 + plen;
            frames_audited += 1;
        }
        assert_eq!(frames_audited, total,
            "expected to audit all {} frames, got {}", total, frames_audited);
        assert!(saw_spawn, "the synthetic spawn at frame 5 must produce a PLATE_SPAWN tag");
    }

    /// **Bug 2 regression** — keyframes (0x40) must land at every `stride`-th
    /// frame index. The JS viewer needs these for backward scrubs.
    #[test]
    fn keyframes_emitted_at_stride() {
        let (_sphere, assignment, motions, crust, _adj) = synthetic_world(9001);
        let n_cells = assignment.cell_plate.len() as u32;
        let stride = 10u32;
        let mut enc = FrameEncoder::new(30, n_cells, 5, stride, 9001);
        enc.write_header();
        enc.write_initial_state(&assignment, &crust, &motions, None);
        let init_end = enc.buf.len();
        for f in 0..30 {
            enc.write_frame(f, &assignment, &crust, &motions, None);
        }
        let buf = enc.finish();
        let kf = scan_keyframe_frame_indices(&buf, init_end);
        // 0 % 10 == 0 too, so frame 0 also encodes as a keyframe.
        assert_eq!(kf, vec![0, 10, 20],
            "keyframes at stride={} expected at [0,10,20], got {:?}", stride, kf);
    }

    /// Task 1.1 — per-frame BOUNDARY_POLYLINES streaming. Each frame written
    /// after a `write_polylines` call must carry at least one 0x30 record,
    /// and the record's declared payload length must match the actual byte
    /// count of the payload that follows.
    #[test]
    fn polylines_emit_per_frame() {
        use crate::boundaries::{classify_boundaries, extract_polylines};

        let (sphere, assignment, motions, crust, _adj) = synthetic_world(31337);
        let n_cells = assignment.cell_plate.len() as u32;
        let mut enc = FrameEncoder::new(/*total*/ 6, n_cells, 5, /*stride*/ 100, 31337);
        enc.write_header();
        enc.write_initial_state(&assignment, &crust, &motions, None);
        let init_end = enc.buf.len();

        // Compute polylines once — the static synthetic world doesn't change
        // across frames, so the polyline set is the same. The test cares
        // that the record is emitted into every frame.
        let classification = classify_boundaries(&sphere.vertices, &assignment, &motions);
        let polylines = extract_polylines(&assignment, &sphere.vertices, &classification);
        assert!(!polylines.is_empty(), "synthetic world must produce some polylines");

        for f in 1u32..=5 {
            enc.write_polylines(&polylines).expect("write_polylines is infallible");
            enc.write_frame(f, &assignment, &crust, &motions, None);
        }
        let buf = enc.finish();

        // Walk frames, count 0x30 records per frame.
        let mut off = init_end;
        let mut frames_seen = 0u32;
        while off + 8 <= buf.len() {
            let frame_idx = read_u32(&buf, off);
            let plen = read_u32(&buf, off + 4) as usize;
            let payload_start = off + 8;
            assert!(payload_start + plen <= buf.len(),
                "frame {} declared length spills past buf", frame_idx);
            let payload = &buf[payload_start..payload_start + plen];

            // Skip a leading keyframe snapshot block if present (none here
            // with stride=100 and frames 1..=5).
            assert_ne!(payload.first().copied(), Some(TAG_KEYFRAME));

            // The 0x30 BOUNDARY_POLYLINES record is appended last in the
            // payload (after deltas + any lifecycle events). Walk forward
            // looking for it, then check its declared length matches the
            // remaining bytes.
            let mut p = 0usize;
            let mut saw_polyline_record = false;
            while p < payload.len() {
                let tag = payload[p];
                if tag == TAG_BOUNDARY_POLYLINES {
                    // [tag u8][u32 record_len][record bytes]
                    let rec_len = read_u32(payload, p + 1) as usize;
                    let rec_start = p + 1 + 4;
                    assert!(rec_start + rec_len <= payload.len(),
                        "frame {} 0x30 record declared len {} would spill past payload (have {} bytes left)",
                        frame_idx, rec_len, payload.len() - rec_start);
                    // Sanity-check the inner record: u16 n_polylines that
                    // matches what we wrote.
                    let n_in_record = u16::from_le_bytes(
                        payload[rec_start..rec_start + 2].try_into().unwrap()
                    );
                    assert_eq!(n_in_record as usize, polylines.len(),
                        "frame {} polyline count mismatch", frame_idx);
                    saw_polyline_record = true;
                    p = rec_start + rec_len;
                } else {
                    // Skip a known fixed-size tag, else bail to avoid an
                    // infinite loop on an unknown variable-length tag.
                    let consumed = match tag {
                        TAG_CELL_PLATE        => 1 + 4 + 4,
                        TAG_ELEV              => 1 + 4 + 2,
                        TAG_COMPOSITION       => 1 + 4 + 1,
                        TAG_RIFT_PROGRESS     => 1 + 4 + 1,
                        TAG_FAILED_RIFT_AGE   => 1 + 4 + 2,
                        TAG_LIP_AGE           => 1 + 4 + 2,
                        TAG_VOLCANIC_ACT      => 1 + 4 + 1,
                        TAG_CELL_AGE_MA       => 1 + 4 + 2,
                        TAG_PLATE_SPAWN       => 1 + PLATE_BLOCK_BYTES,
                        TAG_PLATE_RETIRE      => 1 + 4,
                        TAG_PLATE_MOTION      => 1 + 4 + 12,
                        TAG_PLATE_SEED        => 1 + 4 + 12,
                        TAG_PLATE_DEATH       => 1 + 4 + 1,
                        TAG_PASSIVE_SPLIT     => 1 + 4 + 4,
                        TAG_FAILED_RIFT       => 1 + 4 + 4,
                        TAG_MOR_RETIRE        => 1 + 4,
                        other => panic!("frame {}: unexpected tag 0x{:02X} at off {}",
                            frame_idx, other, p),
                    };
                    p += consumed;
                }
            }
            assert!(saw_polyline_record,
                "frame {} must contain at least one 0x30 BOUNDARY_POLYLINES record",
                frame_idx);

            off = payload_start + plen;
            frames_seen += 1;
        }
        assert_eq!(frames_seen, 5, "expected 5 delta frames in the stream");
    }

    /// **Bug 3 regression** — `cell_age_ma` (tag 0x08, u16 LE) must appear
    /// in the initial-state snapshot AND emit a delta when the value changes
    /// for a cell.
    #[test]
    fn cell_age_ma_in_initial_and_deltas() {
        let (_sphere, assignment, motions, mut crust, _adj) = synthetic_world(2024);
        let n_cells = assignment.cell_plate.len() as u32;
        let mut enc = FrameEncoder::new(2, n_cells, 5, 100, 2024);
        enc.write_header();
        enc.write_initial_state(&assignment, &crust, &motions, None);

        // The snapshot body math must work out — that's only true if the
        // age_ma array is actually being written.
        let body = snapshot_body_len(&enc.buf, 32, n_cells as usize);
        assert_eq!(32 + body, enc.buf.len(),
            "initial-state body length wrong: encoder wrote {} bytes, expected {}",
            enc.buf.len(), 32 + body);

        // Spot-check: the last age value in the age_ma section must match
        // crust.age_ma[last]. age_ma is the 8th per-cell array.
        let age_off = 32
            + (n_cells as usize) * 4   // cell_plate
            + (n_cells as usize) * 2   // elevation
            + (n_cells as usize) * 1   // composition
            + (n_cells as usize) * 1   // rift_progress
            + (n_cells as usize) * 2   // failed_rift_age
            + (n_cells as usize) * 2   // lip_age
            + (n_cells as usize) * 1;  // volcanic_act
        let last = n_cells as usize - 1;
        assert_eq!(
            read_u16_at(&enc.buf, age_off + last * 2),
            crust.age_ma[last],
            "trailing cell_age_ma value mismatch"
        );

        // Mutate one cell's age and verify the delta fires with tag 0x08.
        let target = 7usize;
        crust.age_ma[target] = crust.age_ma[target].wrapping_add(123);
        let before = enc.buf.len();
        enc.write_frame(1, &assignment, &crust, &motions, None);
        let frame_bytes = &enc.buf[before..];
        assert_eq!(read_u32(frame_bytes, 0), 1);
        let plen = read_u32(frame_bytes, 4) as usize;
        let payload = &frame_bytes[8..8 + plen];
        audit_delta_payload(payload).expect("delta payload must round-trip cleanly");

        // Walk and find the TAG_CELL_AGE_MA record for our target cell.
        let mut off = 0usize;
        let mut saw = false;
        while off < payload.len() {
            let tag = payload[off]; off += 1;
            match tag {
                TAG_CELL_AGE_MA => {
                    let idx = read_u32(payload, off);
                    let v = read_u16_at(payload, off + 4);
                    if idx as usize == target {
                        assert_eq!(v, crust.age_ma[target]);
                        saw = true;
                    }
                    off += 4 + 2;
                }
                TAG_CELL_PLATE        => off += 4 + 4,
                TAG_ELEV              => off += 4 + 2,
                TAG_COMPOSITION       => off += 4 + 1,
                TAG_RIFT_PROGRESS     => off += 4 + 1,
                TAG_FAILED_RIFT_AGE   => off += 4 + 2,
                TAG_LIP_AGE           => off += 4 + 2,
                TAG_VOLCANIC_ACT      => off += 4 + 1,
                TAG_PLATE_SPAWN       => off += PLATE_BLOCK_BYTES,
                TAG_PLATE_RETIRE      => off += 4,
                TAG_PLATE_MOTION      => off += 4 + 12,
                TAG_PLATE_SEED        => off += 4 + 12,
                TAG_PLATE_DEATH       => off += 4 + 1,
                TAG_PASSIVE_SPLIT     => off += 4 + 4,
                TAG_FAILED_RIFT       => off += 4 + 4,
                TAG_MOR_RETIRE        => off += 4,
                other => panic!("unexpected tag 0x{:02X}", other),
            }
        }
        assert!(saw, "TAG_CELL_AGE_MA delta for mutated cell must appear");
    }
}
