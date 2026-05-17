//! Multi-layer crust column.
//!
//! Hayba extension of TE's `Crust` (`src/plates-model/crust.ts`). TE stored
//! an arbitrary ordered `rockLayers: IRockLayer[]`; Hayba uses a fixed
//! five-slot column (sedimentary / extrusive / intrusive / metamorphic /
//! basement) so layer access is O(1), serialisation is fixed-size, and
//! metamorphic transformations have a defined destination slot.
//!
//! # Units
//!
//! **All thicknesses in this module are in SI meters.** TE's `crust.ts`
//! stores thicknesses in dimensionless model units; convert any TE
//! thickness constant through [`super::TE_UNIT_TO_METERS`] before using
//! it here. Hayba uses real Airy isostasy
//! ([`super::ISOSTASY_CRUST_PER_ELEV_METERS`]), not TE's
//! `CRUST_THICKNESS_TO_ELEVATION_RATIO`. Future ports of TE's
//! `addVolcanicRocks`, `addSediment`, `subduct`, and `uplift` MUST
//! convert TE constants on the way in.
//!
//! The basement layer is always present: basalt for oceanic crust (~7 km)
//! and granite for continental crust (~35 km). The other four layers
//! default to zero thickness and are grown by surface processes
//! (volcanism, sedimentation, metamorphism).
//!
//! Frozen reference: `docs/research/te-snapshot/plates-model/crust.ts`.

use serde::{Deserialize, Serialize};

use super::{TE_UNIT_TO_METERS};
use crate::rock::Rock;

/// A single rock layer in the crust column.
///
/// `thickness_m == 0.0` is the canonical "absent" state. `age_ma` is the
/// age of the *top* of the layer (when it was last deposited / formed).
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Layer {
    pub rock: Rock,
    pub thickness_m: f32,
    pub age_ma: f32,
}

impl Layer {
    /// An empty layer slot — zero thickness, age zero, holding the given
    /// rock type as its default classification (used so the slot still has
    /// a rock identity even when its thickness is zero).
    ///
    /// `age_ma` is reserved for Phase 3 thermochronology. It is currently
    /// set by deposition / metamorphism code but not consumed by any
    /// downstream calculation in this module.
    #[inline]
    pub const fn empty(rock: Rock) -> Self {
        Self {
            rock,
            thickness_m: 0.0,
            age_ma: 0.0,
        }
    }

    /// True when the layer has zero thickness.
    #[inline]
    pub fn is_absent(&self) -> bool {
        self.thickness_m <= 0.0
    }
}

/// Default initial thickness for oceanic basement (basalt), in meters.
/// Real-world oceanic crust is 5–10 km; we pick 7 km.
pub const DEFAULT_OCEANIC_BASEMENT_THICKNESS_M: f32 = 7_000.0;

/// Default initial thickness for continental basement (granite), in meters.
/// Real-world continental crust is 30–70 km; we pick 35 km.
pub const DEFAULT_CONTINENTAL_BASEMENT_THICKNESS_M: f32 = 35_000.0;

// ---------------------------------------------------------------------------
// Per-column random caps (ported from TE)
// ---------------------------------------------------------------------------

/// Base of the per-column maximum crust thickness, in meters.
///
/// TE: `MAX_CRUST_THICKNESS_BASE = 2` model units (`crust.ts:76`).
/// Converted via [`super::TE_UNIT_TO_METERS`]: 2 * 14 000 = 28 000 m.
pub const MAX_CRUST_THICKNESS_BASE_M: f32 = TE_UNIT_TO_METERS * 2.0;

/// Random variation added on top of [`MAX_CRUST_THICKNESS_BASE_M`].
///
/// TE: `maxCrustThickness = MAX_CRUST_THICKNESS_BASE + random()`
/// (`crust.ts:90`). `random()` returns `[0,1)` in model units, so the
/// implicit variation is 1 model unit = 14 000 m here.
pub const MAX_CRUST_THICKNESS_VARIATION_M: f32 = TE_UNIT_TO_METERS * 1.0;

/// Floor of the per-column subduction-uplift time budget, in Ma.
///
/// TE: `SUBDUCTION_UPLIFT_MIN_TIME = 0.6` (`crust.ts:82`) in TE
/// simulation-time units. Hayba treats that scalar as Ma directly so the
/// uplift timer remains numerically identical when ported in Phase 3+.
pub const SUBDUCTION_UPLIFT_MIN_TIME_MA: f32 = 0.6;

/// Random variation added on top of [`SUBDUCTION_UPLIFT_MIN_TIME_MA`].
///
/// TE: `SUBDUCTION_UPLIFT_TIME_VARIATION = 0.7` (`crust.ts:84`).
pub const SUBDUCTION_UPLIFT_TIME_VARIATION_MA: f32 = 0.7;

/// Fixed seed used by the no-rng constructors so that
/// `CrustColumn::new_oceanic()` / `new_continental()` remain
/// deterministic and produce reproducible per-column caps even when the
/// caller does not thread an rng through.
const DEFAULT_COLUMN_SEED: u64 = 0xA1B2_C3D4_E5F6_0718;

/// Minimal deterministic SplitMix64 used to draw per-column caps without
/// pulling in `rand_*` dependencies on the hot crust path.
///
/// Hayba is determinism-first; TE uses `Math.random()` here (`crust.ts:90`)
/// which is not reproducible across JS runtimes. The Rust port replaces
/// that with SplitMix64 driven by an explicit seed.
#[derive(Debug, Clone, Copy)]
pub struct SplitMix64 {
    state: u64,
}

impl SplitMix64 {
    /// Construct from an explicit 64-bit seed.
    #[inline]
    pub const fn new(seed: u64) -> Self {
        Self { state: seed }
    }

    /// Draw the next 64-bit value.
    #[inline]
    pub fn next_u64(&mut self) -> u64 {
        // Constants from Steele, Lea & Flood, "Fast Splittable Pseudorandom
        // Number Generators" (OOPSLA 2014).
        self.state = self.state.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.state;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }

    /// Uniform float in `[0, 1)`.
    #[inline]
    pub fn next_unit_f32(&mut self) -> f32 {
        // Take the top 24 bits (f32 mantissa width) for a well-distributed
        // value in [0,1).
        (self.next_u64() >> 40) as f32 / (1u32 << 24) as f32
    }
}

/// Fixed five-layer crust column. Top-down ordering for rendering /
/// erosion is given by [`CrustColumn::ordered_layers`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CrustColumn {
    /// Sedimentary cover (top).
    pub sedimentary: Layer,
    /// Surface volcanic / extrusive igneous.
    pub extrusive: Layer,
    /// Deep / plutonic igneous emplaced into the column.
    pub intrusive: Layer,
    /// Metamorphic layer (schist → gneiss; or eclogite / blueschist
    /// produced by subduction).
    pub metamorphic: Layer,
    /// Basement (bottom). Always present; basalt for oceanic, granite for
    /// continental.
    pub basement: Layer,
    /// Per-column maximum thickness cap, in meters. Determines the
    /// saturation of layer growth.
    ///
    /// TE: `maxCrustThickness` from `crust.ts:90`. TE draws a fresh value
    /// per crust instance via `MAX_CRUST_THICKNESS_BASE + random()`;
    /// Hayba uses [`MAX_CRUST_THICKNESS_BASE_M`] +
    /// `rng * MAX_CRUST_THICKNESS_VARIATION_M` to produce a deterministic
    /// equivalent in SI meters.
    pub max_total_thickness_m: f32,
    /// Per-column uplift time budget, in Ma. Decremented by `uplift()`
    /// (Phase 3+).
    ///
    /// TE: `upliftCapacity` from `crust.ts:91`. TE draws
    /// `SUBDUCTION_UPLIFT_MIN_TIME + SUBDUCTION_UPLIFT_TIME_VARIATION *
    /// random()`; Hayba mirrors that with [`SUBDUCTION_UPLIFT_MIN_TIME_MA`]
    /// and [`SUBDUCTION_UPLIFT_TIME_VARIATION_MA`].
    pub uplift_capacity_ma: f32,
}

impl CrustColumn {
    /// Build an oceanic crust column: basalt basement at the default
    /// thickness, all other slots empty. Uses a fixed seed so callers
    /// without an rng still get deterministic per-column caps.
    pub fn new_oceanic() -> Self {
        let mut rng = SplitMix64::new(DEFAULT_COLUMN_SEED);
        Self::new_oceanic_with_seed(&mut rng)
    }

    /// Build an oceanic crust column with caller-supplied rng for the
    /// per-column random caps (`max_total_thickness_m`, `uplift_capacity_ma`).
    pub fn new_oceanic_with_seed(rng: &mut SplitMix64) -> Self {
        let max_total_thickness_m =
            MAX_CRUST_THICKNESS_BASE_M + rng.next_unit_f32() * MAX_CRUST_THICKNESS_VARIATION_M;
        let uplift_capacity_ma = SUBDUCTION_UPLIFT_MIN_TIME_MA
            + rng.next_unit_f32() * SUBDUCTION_UPLIFT_TIME_VARIATION_MA;
        Self {
            sedimentary: Layer::empty(Rock::OceanicSediment),
            extrusive: Layer::empty(Rock::Basalt),
            intrusive: Layer::empty(Rock::Gabbro),
            metamorphic: Layer::empty(Rock::Schist),
            basement: Layer {
                rock: Rock::Basalt,
                thickness_m: DEFAULT_OCEANIC_BASEMENT_THICKNESS_M,
                age_ma: 0.0,
            },
            max_total_thickness_m,
            uplift_capacity_ma,
        }
    }

    /// Build a continental crust column: granite basement at the default
    /// thickness, all other slots empty. Uses a fixed seed so callers
    /// without an rng still get deterministic per-column caps.
    pub fn new_continental() -> Self {
        let mut rng = SplitMix64::new(DEFAULT_COLUMN_SEED ^ 0xDEAD_BEEF_DEAD_BEEF);
        Self::new_continental_with_seed(&mut rng)
    }

    /// Build a continental crust column with caller-supplied rng for the
    /// per-column random caps.
    pub fn new_continental_with_seed(rng: &mut SplitMix64) -> Self {
        let max_total_thickness_m =
            MAX_CRUST_THICKNESS_BASE_M + rng.next_unit_f32() * MAX_CRUST_THICKNESS_VARIATION_M;
        let uplift_capacity_ma = SUBDUCTION_UPLIFT_MIN_TIME_MA
            + rng.next_unit_f32() * SUBDUCTION_UPLIFT_TIME_VARIATION_MA;
        Self {
            sedimentary: Layer::empty(Rock::ContinentalSediment),
            extrusive: Layer::empty(Rock::Rhyolite),
            intrusive: Layer::empty(Rock::Diorite),
            metamorphic: Layer::empty(Rock::Schist),
            basement: Layer {
                rock: Rock::Granite,
                thickness_m: DEFAULT_CONTINENTAL_BASEMENT_THICKNESS_M,
                age_ma: 0.0,
            },
            max_total_thickness_m,
            uplift_capacity_ma,
        }
    }

    /// Sum of all layer thicknesses, in meters.
    #[inline]
    pub fn total_thickness_m(&self) -> f32 {
        self.sedimentary.thickness_m
            + self.extrusive.thickness_m
            + self.intrusive.thickness_m
            + self.metamorphic.thickness_m
            + self.basement.thickness_m
    }

    /// Rock identity of the thickest non-empty layer. Falls back to the
    /// basement when every other layer is absent.
    pub fn dominant_rock(&self) -> Rock {
        let candidates = self.ordered_layers();
        let mut best = candidates[4]; // basement
        for layer in candidates {
            if layer.thickness_m > best.thickness_m {
                best = layer;
            }
        }
        best.rock
    }

    /// Returns true iff `basement.rock` is granite-class (continental
    /// basement).
    ///
    /// **Divergence from TE.** TE's `hasContinentalRocks`
    /// (`crust.ts:129-131`) checks the bottom of its `rockLayers` array.
    /// For in-place crust the two checks are equivalent, but they
    /// diverge after [`Self::clear`] (which leaves the basement *rock*
    /// label untouched while zeroing every layer) or any other
    /// basement-replacement event. Consumers that need a guaranteed-live
    /// answer should also check [`Self::total_thickness_m`] > 0 before
    /// consulting this flag.
    #[inline]
    pub fn is_continental(&self) -> bool {
        self.basement.rock == Rock::Granite
    }

    /// Returns true iff `basement.rock` is basalt-class (oceanic basement).
    ///
    /// Same divergence note as [`Self::is_continental`]: TE checks the
    /// bottom of `rockLayers`; Hayba checks `basement.rock`.
    #[inline]
    pub fn is_oceanic(&self) -> bool {
        self.basement.rock == Rock::Basalt
    }

    /// Returns true iff the column was ever oceanic — i.e. gabbro is
    /// present somewhere in the column with non-zero thickness, **or**
    /// the basement is basalt.
    ///
    /// Mirrors TE's `wasInitiallyOceanicCrust` (`crust.ts:137-139`),
    /// which checks `getLayer(Rock.Gabbro) !== null`. This is for
    /// downstream code (subduction, accretion) that cares about historical
    /// origin rather than current basement identity — e.g. a column whose
    /// continental crust was emplaced atop a pre-existing oceanic slab
    /// should still report `true`.
    #[inline]
    pub fn was_initially_oceanic(&self) -> bool {
        self.basement.rock == Rock::Basalt
            || (self.intrusive.rock == Rock::Gabbro && !self.intrusive.is_absent())
            || (self.extrusive.rock == Rock::Gabbro && !self.extrusive.is_absent())
    }

    /// Rock identity of the topmost non-empty layer — i.e. what an eroder
    /// would scrape off first. Mirrors the top-down ordering of
    /// [`Self::ordered_layers`]: sedimentary → extrusive → intrusive →
    /// metamorphic → basement. Falls back to the basement rock when every
    /// other slot is absent.
    ///
    /// Used by Phase 5.2 climate-coupled erosion to look up the per-cell
    /// erodibility (`base_k_for_rock`).
    #[inline]
    pub fn top_rock(&self) -> Rock {
        if !self.sedimentary.is_absent() {
            return self.sedimentary.rock;
        }
        if !self.extrusive.is_absent() {
            return self.extrusive.rock;
        }
        if !self.intrusive.is_absent() {
            return self.intrusive.rock;
        }
        if !self.metamorphic.is_absent() {
            return self.metamorphic.rock;
        }
        self.basement.rock
    }

    /// Top-down ordering used by erosion and rendering: sedimentary,
    /// extrusive, intrusive, metamorphic, basement.
    #[inline]
    pub fn ordered_layers(&self) -> [&Layer; 5] {
        [
            &self.sedimentary,
            &self.extrusive,
            &self.intrusive,
            &self.metamorphic,
            &self.basement,
        ]
    }

    // -------------------------------------------------------------------
    // Mutation rules
    // -------------------------------------------------------------------

    /// Deposit volcanic / extrusive material on top of the column.
    ///
    /// Panics in debug builds if `rock` is not extrusive (a logic error
    /// elsewhere in the simulation). In release the call is a no-op
    /// for non-extrusive inputs, so the simulation degrades gracefully.
    ///
    /// **Phase 2 primitive.** TE's `addVolcanicRocks` (`crust.ts:322-338`)
    /// composes continental Rhyolite+Granite or oceanic
    /// Diorite+Andesite+Gabbro+Basalt rules on top of this primitive.
    /// The higher-level method that picks which rocks to emplace based
    /// on tectonic context will be composed in Phase 4.
    pub fn add_volcanic_deposit(&mut self, rock: Rock, thickness_m: f32, age_ma: f32) {
        debug_assert!(rock.is_extrusive(), "volcanic deposit must be extrusive rock");
        if !rock.is_extrusive() || thickness_m <= 0.0 {
            return;
        }
        // If the slot already holds the same rock, accrete. Otherwise the
        // new eruption overwrites the rock identity but keeps the old
        // material — common simplification in TE.
        if self.extrusive.is_absent() {
            self.extrusive = Layer {
                rock,
                thickness_m,
                age_ma,
            };
        } else {
            self.extrusive.thickness_m += thickness_m;
            self.extrusive.age_ma = age_ma;
            self.extrusive.rock = rock;
        }
    }

    /// Deposit sediment on top of the column.
    ///
    /// **Uncapped at this layer.** TE's `MAX_REGULAR_SEDIMENT_THICKNESS`
    /// (`crust.ts:55`) is enforced higher up the call stack: overflow is
    /// routed into TE's `addExcessSediment` (accretionary wedge) path.
    /// Hayba will compose that overflow rule in Phase 4 — for now this
    /// primitive accepts arbitrary thicknesses.
    pub fn add_sediment(&mut self, rock: Rock, thickness_m: f32, age_ma: f32) {
        debug_assert!(rock.is_sedimentary(), "sediment deposit must be sedimentary rock");
        if !rock.is_sedimentary() || thickness_m <= 0.0 {
            return;
        }
        if self.sedimentary.is_absent() {
            self.sedimentary = Layer {
                rock,
                thickness_m,
                age_ma,
            };
        } else {
            self.sedimentary.thickness_m += thickness_m;
            self.sedimentary.age_ma = age_ma;
            self.sedimentary.rock = rock;
        }
    }

    /// Erode `thickness_m` of material from the top of the column.
    ///
    /// Returns the rock type of the *last* slot the eroder actually touched
    /// (sedimentary first, then extrusive, etc.) so downstream
    /// sediment-transport routing knows what was scraped off.
    pub fn erode_top(&mut self, mut thickness_m: f32) -> Rock {
        if thickness_m <= 0.0 {
            return self.sedimentary.rock;
        }
        // Order matches `ordered_layers`. Basement is the floor; we
        // never erode it to zero (a field with zero basement would be
        // worse than oceanic crust, which the simulation does not model).
        let mut last_touched = self.sedimentary.rock;

        for layer in [
            &mut self.sedimentary,
            &mut self.extrusive,
            &mut self.intrusive,
            &mut self.metamorphic,
        ] {
            if thickness_m <= 0.0 {
                break;
            }
            if layer.thickness_m > 0.0 {
                let take = thickness_m.min(layer.thickness_m);
                layer.thickness_m -= take;
                thickness_m -= take;
                last_touched = layer.rock;
            }
        }

        // If there's still erosion budget left, eat into the basement,
        // but never below ~1 m (keep basement present as a class marker).
        if thickness_m > 0.0 && self.basement.thickness_m > 1.0 {
            let take = thickness_m.min(self.basement.thickness_m - 1.0);
            if take > 0.0 {
                self.basement.thickness_m -= take;
                last_touched = self.basement.rock;
            }
        }
        last_touched
    }

    /// Apply metamorphic transformations driven by burial + temperature.
    ///
    /// Rules (simple but defensible — exact thresholds are placeholders;
    /// TODO(phase-4): tune against real petrology phase diagrams).
    /// Rough real-world anchors:
    ///   - greenschist / schist: ~5–10 km, ~300–500 °C (~575–775 K)
    ///   - gneiss (upper amphibolite / granulite onset): ~15–25 km,
    ///     ~600–800 °C (~875–1075 K)
    ///   - blueschist (high P / low T): ~25–40 km, ~200–500 °C
    ///     (~475–775 K) — characteristic of cold subducting slabs
    ///   - eclogite (high P / high T): ~35–80 km, ~500–900 °C
    ///     (~775–1175 K) — deep subducted mafic crust
    ///
    /// Encoded thresholds:
    /// - depth > 5 km AND temp > 600 K AND sedimentary non-empty
    ///   → 50% of sedimentary becomes schist (moved to metamorphic slot)
    /// - depth > 15 km AND temp > 800 K AND metamorphic == schist
    ///   → upgrade schist to gneiss
    /// - depth > 30 km AND temp < 600 K (cold subduction): basaltic
    ///   material (basement basalt / extrusive basalt) → blueschist
    /// - depth > 30 km AND temp > 1000 K (hot subduction): basaltic
    ///   material (basement basalt / extrusive basalt / intrusive gabbro)
    ///   → eclogite
    ///
    /// Blueschist and eclogite are facies of metamorphosed *mafic igneous*
    /// rock, not of sediment — so the donor slot is basalt/gabbro, not
    /// the sedimentary slot.
    pub fn metamorphose_from_pressure(&mut self, depth_burial_km: f32, max_temp_k: f32) {
        // Cold deep subduction → blueschist from basaltic material.
        if depth_burial_km > 30.0 && max_temp_k < 600.0 {
            let donor_thickness = Self::drain_mafic_for_metamorphism(self);
            if donor_thickness > 0.0 {
                self.metamorphic = Layer {
                    rock: Rock::Blueschist,
                    thickness_m: self.metamorphic.thickness_m + donor_thickness,
                    age_ma: self.metamorphic.age_ma,
                };
            }
            return;
        }

        // Hot deep subduction → eclogite from basaltic / gabbroic material.
        if depth_burial_km > 30.0 && max_temp_k > 1000.0 {
            let donor_thickness = Self::drain_mafic_for_metamorphism(self);
            if donor_thickness > 0.0 {
                self.metamorphic = Layer {
                    rock: Rock::Eclogite,
                    thickness_m: self.metamorphic.thickness_m + donor_thickness,
                    age_ma: self.metamorphic.age_ma,
                };
            }
            return;
        }

        // Shallow burial: convert half of any sedimentary to schist.
        if depth_burial_km > 5.0 && max_temp_k > 600.0 && !self.sedimentary.is_absent() {
            let moved = 0.5 * self.sedimentary.thickness_m;
            self.sedimentary.thickness_m -= moved;
            if self.metamorphic.is_absent() || self.metamorphic.rock == Rock::Schist {
                if self.metamorphic.is_absent() {
                    self.metamorphic = Layer {
                        rock: Rock::Schist,
                        thickness_m: moved,
                        age_ma: self.sedimentary.age_ma,
                    };
                } else {
                    self.metamorphic.thickness_m += moved;
                }
            } else {
                // Some other metamorphic phase already there — keep it,
                // accrete schist underneath conceptually by adding mass.
                self.metamorphic.thickness_m += moved;
            }
        }

        // Mid-depth: schist → gneiss upgrade.
        if depth_burial_km > 15.0
            && max_temp_k > 800.0
            && self.metamorphic.rock == Rock::Schist
            && !self.metamorphic.is_absent()
        {
            self.metamorphic.rock = Rock::Gneiss;
        }
    }

    /// Drain mafic igneous material (extrusive basalt, intrusive gabbro,
    /// then a small fraction of basalt basement) to feed a high-pressure
    /// metamorphic transformation. Returns the total thickness drained.
    ///
    /// Basement is left with at least 1 m floor, mirroring [`erode_top`]'s
    /// invariant that a column never loses its basement-class marker.
    /// Caps basement contribution at 25% of available basement so a single
    /// metamorphic event cannot evaporate the slab.
    fn drain_mafic_for_metamorphism(col: &mut CrustColumn) -> f32 {
        let mut drained = 0.0;
        if col.extrusive.rock == Rock::Basalt && !col.extrusive.is_absent() {
            drained += col.extrusive.thickness_m;
            col.extrusive.thickness_m = 0.0;
        }
        if col.intrusive.rock == Rock::Gabbro && !col.intrusive.is_absent() {
            drained += col.intrusive.thickness_m;
            col.intrusive.thickness_m = 0.0;
        }
        if col.basement.rock == Rock::Basalt && col.basement.thickness_m > 1.0 {
            let avail = col.basement.thickness_m - 1.0;
            let take = (avail * 0.25).max(0.0);
            col.basement.thickness_m -= take;
            drained += take;
        }
        drained
    }

    /// Proportionally scale every layer so that `total_thickness_m`
    /// becomes the requested value. Preserves the relative composition.
    /// No-op (sets basement = `target_m`) if the column is currently empty.
    pub fn rescale_total(&mut self, target_m: f32) {
        let total = self.total_thickness_m();
        if total <= 0.0 {
            self.basement.thickness_m = target_m.max(0.0);
            return;
        }
        let ratio = target_m.max(0.0) / total;
        self.sedimentary.thickness_m *= ratio;
        self.extrusive.thickness_m *= ratio;
        self.intrusive.thickness_m *= ratio;
        self.metamorphic.thickness_m *= ratio;
        self.basement.thickness_m *= ratio;
    }

    /// Zero every layer. Used when the field is fully consumed by a
    /// subduction sweep (TE collision branch that sets `crust.thickness = 0`).
    pub fn clear(&mut self) {
        self.sedimentary.thickness_m = 0.0;
        self.extrusive.thickness_m = 0.0;
        self.intrusive.thickness_m = 0.0;
        self.metamorphic.thickness_m = 0.0;
        self.basement.thickness_m = 0.0;
    }
}

impl Default for CrustColumn {
    fn default() -> Self {
        Self::new_oceanic()
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn oceanic_crust_total_thickness_around_7km() {
        let c = CrustColumn::new_oceanic();
        assert!(c.is_oceanic());
        assert!(!c.is_continental());
        let total = c.total_thickness_m();
        assert!(
            (5_000.0..=10_000.0).contains(&total),
            "oceanic total {total} m not in [5,10] km"
        );
        assert_eq!(c.basement.rock, Rock::Basalt);
        assert!(c.sedimentary.is_absent());
        assert!(c.extrusive.is_absent());
    }

    #[test]
    fn continental_crust_total_thickness_around_35km() {
        let c = CrustColumn::new_continental();
        assert!(c.is_continental());
        assert!(!c.is_oceanic());
        let total = c.total_thickness_m();
        assert!(
            (30_000.0..=45_000.0).contains(&total),
            "continental total {total} m not in [30,45] km"
        );
        assert_eq!(c.basement.rock, Rock::Granite);
    }

    #[test]
    fn add_volcanic_deposit_increases_extrusive_thickness() {
        let mut c = CrustColumn::new_oceanic();
        assert!(c.extrusive.is_absent());
        c.add_volcanic_deposit(Rock::Basalt, 500.0, 12.0);
        assert_eq!(c.extrusive.thickness_m, 500.0);
        assert_eq!(c.extrusive.rock, Rock::Basalt);
        assert_eq!(c.extrusive.age_ma, 12.0);
        c.add_volcanic_deposit(Rock::Andesite, 200.0, 13.0);
        assert!((c.extrusive.thickness_m - 700.0).abs() < 1e-3);
        assert_eq!(c.extrusive.rock, Rock::Andesite);
    }

    #[test]
    fn erode_top_removes_sedimentary_first() {
        let mut c = CrustColumn::new_continental();
        c.add_sediment(Rock::Sandstone, 1_000.0, 5.0);
        c.add_volcanic_deposit(Rock::Rhyolite, 500.0, 4.0);
        let before_basement = c.basement.thickness_m;
        let removed_rock = c.erode_top(800.0);
        assert_eq!(removed_rock, Rock::Sandstone);
        assert!((c.sedimentary.thickness_m - 200.0).abs() < 1e-3);
        // Extrusive untouched.
        assert!((c.extrusive.thickness_m - 500.0).abs() < 1e-3);
        // Basement untouched.
        assert_eq!(c.basement.thickness_m, before_basement);
    }

    #[test]
    fn erode_cascades_through_layers() {
        let mut c = CrustColumn::new_continental();
        c.add_sediment(Rock::Sandstone, 100.0, 0.0);
        c.add_volcanic_deposit(Rock::Rhyolite, 200.0, 0.0);
        let last = c.erode_top(250.0);
        assert!(c.sedimentary.is_absent());
        assert!((c.extrusive.thickness_m - 50.0).abs() < 1e-3);
        assert_eq!(last, Rock::Rhyolite);
    }

    #[test]
    fn metamorphose_under_burial_creates_schist() {
        let mut c = CrustColumn::new_continental();
        c.add_sediment(Rock::Shale, 2_000.0, 50.0);
        c.metamorphose_from_pressure(8.0, 700.0);
        assert_eq!(c.metamorphic.rock, Rock::Schist);
        assert!((c.metamorphic.thickness_m - 1_000.0).abs() < 1e-3);
        assert!((c.sedimentary.thickness_m - 1_000.0).abs() < 1e-3);
    }

    #[test]
    fn schist_upgrades_to_gneiss_with_deeper_burial() {
        let mut c = CrustColumn::new_continental();
        c.add_sediment(Rock::Shale, 2_000.0, 50.0);
        c.metamorphose_from_pressure(8.0, 700.0);
        assert_eq!(c.metamorphic.rock, Rock::Schist);
        c.metamorphose_from_pressure(20.0, 900.0);
        assert_eq!(c.metamorphic.rock, Rock::Gneiss);
    }

    #[test]
    fn cold_subduction_creates_blueschist() {
        let mut c = CrustColumn::new_oceanic();
        c.add_sediment(Rock::Shale, 500.0, 0.0);
        c.metamorphose_from_pressure(40.0, 500.0);
        assert_eq!(c.metamorphic.rock, Rock::Blueschist);
        assert!(c.metamorphic.thickness_m > 0.0);
    }

    #[test]
    fn hot_subduction_creates_eclogite() {
        let mut c = CrustColumn::new_oceanic();
        c.add_sediment(Rock::Shale, 500.0, 0.0);
        c.metamorphose_from_pressure(40.0, 1_100.0);
        assert_eq!(c.metamorphic.rock, Rock::Eclogite);
        assert!(c.metamorphic.thickness_m > 0.0);
    }

    #[test]
    fn crust_column_serializes_roundtrip() {
        let mut c = CrustColumn::new_continental();
        c.add_sediment(Rock::Limestone, 300.0, 7.5);
        c.add_volcanic_deposit(Rock::Rhyolite, 150.0, 6.0);
        c.metamorphose_from_pressure(8.0, 700.0);

        let bytes = bincode::serialize(&c).unwrap();
        let d: CrustColumn = bincode::deserialize(&bytes).unwrap();
        assert_eq!(c, d);

        // JSON round-trip too.
        let s = serde_json::to_string(&c).unwrap();
        let e: CrustColumn = serde_json::from_str(&s).unwrap();
        assert_eq!(c, e);
    }

    #[test]
    fn dominant_rock_picks_thickest_layer() {
        let mut c = CrustColumn::new_continental();
        // basement is huge (35 km) — dominates by default.
        assert_eq!(c.dominant_rock(), Rock::Granite);
        // Bury it under a 50-km mythic sandstone — sandstone wins.
        c.add_sediment(Rock::Sandstone, 50_000.0, 0.0);
        assert_eq!(c.dominant_rock(), Rock::Sandstone);
    }

    #[test]
    fn rescale_total_preserves_composition_ratios() {
        let mut c = CrustColumn::new_continental();
        c.add_sediment(Rock::Shale, 5_000.0, 0.0);
        let before_total = c.total_thickness_m();
        let sed_ratio = c.sedimentary.thickness_m / before_total;
        c.rescale_total(before_total * 2.0);
        let new_total = c.total_thickness_m();
        assert!((new_total - before_total * 2.0).abs() < 1.0);
        let new_sed_ratio = c.sedimentary.thickness_m / new_total;
        assert!((new_sed_ratio - sed_ratio).abs() < 1e-4);
    }

    #[test]
    fn default_constructors_are_deterministic() {
        // Two columns built with no-rng constructors must be byte-identical.
        let a = CrustColumn::new_oceanic();
        let b = CrustColumn::new_oceanic();
        assert_eq!(a, b);
        let c = CrustColumn::new_continental();
        let d = CrustColumn::new_continental();
        assert_eq!(c, d);
        // Oceanic vs continental must differ in their random caps because
        // they are seeded with distinct constants (different rock-class
        // priors should not collide in the cap distribution).
        assert_ne!(a.max_total_thickness_m, c.max_total_thickness_m);
    }

    #[test]
    fn seeded_constructors_reproduce_caps() {
        let mut r1 = SplitMix64::new(42);
        let mut r2 = SplitMix64::new(42);
        let a = CrustColumn::new_oceanic_with_seed(&mut r1);
        let b = CrustColumn::new_oceanic_with_seed(&mut r2);
        assert_eq!(a, b);
        // Caps are within the documented bounds.
        assert!(a.max_total_thickness_m >= MAX_CRUST_THICKNESS_BASE_M);
        assert!(
            a.max_total_thickness_m
                <= MAX_CRUST_THICKNESS_BASE_M + MAX_CRUST_THICKNESS_VARIATION_M
        );
        assert!(a.uplift_capacity_ma >= SUBDUCTION_UPLIFT_MIN_TIME_MA);
        assert!(
            a.uplift_capacity_ma
                <= SUBDUCTION_UPLIFT_MIN_TIME_MA + SUBDUCTION_UPLIFT_TIME_VARIATION_MA
        );
    }

    #[test]
    fn was_initially_oceanic_tracks_origin() {
        let oc = CrustColumn::new_oceanic();
        assert!(oc.was_initially_oceanic());
        let cont = CrustColumn::new_continental();
        assert!(!cont.was_initially_oceanic());
        // Continental column with a gabbro intrusive remnant should report
        // historical oceanic origin.
        let mut hybrid = CrustColumn::new_continental();
        hybrid.intrusive = Layer {
            rock: Rock::Gabbro,
            thickness_m: 500.0,
            age_ma: 100.0,
        };
        assert!(hybrid.was_initially_oceanic());
    }

    #[test]
    fn top_rock_returns_topmost_nonempty_layer() {
        // Bare continental crust: basement granite is on top.
        let mut c = CrustColumn::new_continental();
        assert_eq!(c.top_rock(), Rock::Granite);
        // Add a metamorphic layer — still beats basement order-wise.
        c.metamorphic = Layer {
            rock: Rock::Schist,
            thickness_m: 50.0,
            age_ma: 0.0,
        };
        assert_eq!(c.top_rock(), Rock::Schist);
        // Add an intrusive — comes above metamorphic.
        c.add_volcanic_deposit(Rock::Rhyolite, 100.0, 0.0);
        assert_eq!(c.top_rock(), Rock::Rhyolite);
        // Sediment on top wins.
        c.add_sediment(Rock::Shale, 25.0, 0.0);
        assert_eq!(c.top_rock(), Rock::Shale);
    }

    #[test]
    fn clear_zeroes_every_layer() {
        let mut c = CrustColumn::new_continental();
        c.add_sediment(Rock::Limestone, 100.0, 0.0);
        c.clear();
        assert_eq!(c.total_thickness_m(), 0.0);
        // Basement rock identity preserved so is_continental() still works
        // as a "what kind of crust was this?" record.
        assert_eq!(c.basement.rock, Rock::Granite);
        assert!(c.is_continental());
    }
}
