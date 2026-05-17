//! Phase 13.1 — `WorldSave` JSON contract.
//!
//! A WorldSave is the durable artifact a user takes away from a session:
//! the seed, the wizard inputs, the continent sketch, and any named
//! snapshots they've pinned along the timeline. Playback regenerates the
//! frame stream from these inputs — the binary world.bin is *not* part of
//! the save, it's a build artifact derived from the save deterministically.
//!
//! Determinism: the save header carries `determinism_version`. Loaders may
//! warn-and-replay on a mismatch (see `determinism::check_save_compat`), so
//! older saves remain inspectable after a version bump.

use serde::{Deserialize, Serialize};

use crate::determinism::{SaveHeader, DETERMINISM_VERSION};
use crate::wizard::OrbitalParams;

/// One continent-drawing stroke from the wizard intake step. Coordinates are
/// unit-sphere positions in the canonical orientation; the wizard renderer
/// emits them by clicking on the sphere.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct ContinentStroke {
    pub plate_id: u32,
    /// (x, y, z) unit-sphere positions, in stroke order.
    pub points: Vec<[f32; 3]>,
}

/// User-pinned point in the timeline. Stored as a frame index plus a label.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct NamedSnapshot {
    pub frame_idx: u32,
    pub label: String,
}

/// Wizard inputs in serialized form. Keeps the orbital params plus the seed
/// preset name (for UI restoration; not load-bearing).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct WizardInputs {
    pub preset_name: String,
    pub orbital_params: OrbitalParams,
    /// Total simulated time in megayears the user asked the run to cover.
    pub run_length_ma: f64,
}

/// Top-level save artifact. Round-trips via `serde_json` — keep all fields
/// JSON-friendly (no `f32::NAN`, no `u64` overflow).
#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct WorldSave {
    pub header: SaveHeader,
    pub wizard_inputs: WizardInputs,
    pub continent_drawings: Vec<ContinentStroke>,
    pub named_snapshots: Vec<NamedSnapshot>,
}

impl WorldSave {
    pub fn new(master_seed: u64, wizard_inputs: WizardInputs) -> Self {
        Self {
            header: SaveHeader::current(master_seed),
            wizard_inputs,
            continent_drawings: Vec::new(),
            named_snapshots: Vec::new(),
        }
    }

    /// Serialize to pretty-printed JSON. Pretty by default so saves are
    /// human-diffable when checked into git.
    pub fn to_json(&self) -> serde_json::Result<String> {
        serde_json::to_string_pretty(self)
    }

    /// Parse from JSON. Does not verify determinism compat — callers should
    /// run `determinism::check_save_compat(&save.header)` and decide.
    pub fn from_json(s: &str) -> serde_json::Result<Self> {
        serde_json::from_str(s)
    }

    /// Convenience: add a named snapshot, keeping the list sorted by frame.
    pub fn pin_snapshot(&mut self, frame_idx: u32, label: impl Into<String>) {
        self.named_snapshots.push(NamedSnapshot { frame_idx, label: label.into() });
        self.named_snapshots.sort_by_key(|s| s.frame_idx);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn earth_inputs() -> WizardInputs {
        WizardInputs {
            preset_name: "earth".into(),
            orbital_params: OrbitalParams::earth(),
            run_length_ma: 500.0,
        }
    }

    #[test]
    fn round_trips_via_json() {
        let mut save = WorldSave::new(12345, earth_inputs());
        save.continent_drawings.push(ContinentStroke {
            plate_id: 1,
            points: vec![[1.0, 0.0, 0.0], [0.0, 1.0, 0.0]],
        });
        save.pin_snapshot(0, "start");
        save.pin_snapshot(100, "rift opens");

        let s = save.to_json().expect("serialize");
        let back = WorldSave::from_json(&s).expect("parse");

        assert_eq!(back.header.master_seed, 12345);
        assert_eq!(back.header.determinism_version, DETERMINISM_VERSION);
        assert_eq!(back.continent_drawings, save.continent_drawings);
        assert_eq!(back.named_snapshots, save.named_snapshots);
    }

    #[test]
    fn pin_snapshot_keeps_sorted() {
        let mut save = WorldSave::new(0, earth_inputs());
        save.pin_snapshot(50, "mid");
        save.pin_snapshot(10, "early");
        save.pin_snapshot(100, "late");
        let frames: Vec<u32> = save.named_snapshots.iter().map(|s| s.frame_idx).collect();
        assert_eq!(frames, vec![10, 50, 100]);
    }
}
