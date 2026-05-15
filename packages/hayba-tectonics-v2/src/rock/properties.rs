//! Rock taxonomy + per-rock physical properties.
//!
//! Port target: tectonic-explorer's `src/plates-model/rock-properties.ts`.
//! Frozen reference: `docs/research/te-snapshot/plates-model/rock-properties.ts`.
//!
//! Rust currently has 13 (igneous / sedimentary) + 2 (OceanicSediment,
//! ContinentalSediment, ported directly from TE) + 4 (Schist, Gneiss,
//! Eclogite, Blueschist — Hayba-original metamorphic phase transitions,
//! not in TE) = **15 variants**. TE has 11. Hayba adds the four metamorphic
//! varieties as explicit rocks because TE collapsed metamorphic state into
//! a per-layer `metamorphic: [0,1]` scalar; Hayba prefers a discrete enum
//! so that downstream code can dispatch on rock identity. Numeric
//! discriminants are non-contiguous so that adding new rock types later
//! does not renumber existing ones — preserves frame-stream serialisation
//! stability.
//!
//! Numeric values: densities and melt temperatures are drawn from real-world
//! geology (Carmichael 1989; CRC handbook). TE's `rock-properties.ts` does
//! not carry density or melt-temperature, so there is no TE source to honour
//! here — we use real values directly. Colors are picked aesthetically; TE
//! renders rocks via `color-maps.ts` palette which is not yet matched here.

use serde::{Deserialize, Serialize};

/// Petrologic origin of a rock.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum Origin {
    Igneous,
    Sedimentary,
    Metamorphic,
}

/// Rock taxonomy used across the crust column.
///
/// Discriminants are stable across versions — *never* re-use an old value
/// for a different rock type. Group prefixes:
///   - 0..9   : igneous extrusive
///   - 10..19 : igneous intrusive
///   - 20..29 : sedimentary
///   - 30..39 : metamorphic
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[repr(u8)]
pub enum Rock {
    // Igneous extrusive (surface).
    Basalt = 0,
    Rhyolite = 1,
    Andesite = 2,
    // Igneous intrusive (deep).
    Gabbro = 10,
    Granite = 11,
    Diorite = 12,
    // Sedimentary.
    Limestone = 20,
    Sandstone = 21,
    Shale = 22,
    /// TE `Rock.OceanicSediment` (rock-properties.ts:6). Mud / clay /
    /// biogenic ooze deposited on the ocean floor. Subducts with the
    /// oceanic plate it rides on.
    OceanicSediment = 23,
    /// TE `Rock.ContinentalSediment` (rock-properties.ts:13). Clastic
    /// detritus deposited on continental margins. Cannot subduct (TE
    /// `canSubduct = false`); accumulates in accretionary wedges instead.
    ContinentalSediment = 24,
    // Metamorphic.
    Schist = 30,
    Gneiss = 31,
    Eclogite = 32,
    Blueschist = 33,
}

/// Per-rock physical / rendering properties.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct RockProperties {
    pub density_kg_m3: f32,
    pub melt_temperature_k: f32,
    pub origin: Origin,
    /// Igneous-only: true for surface-erupted lavas, false for plutonic.
    /// Always false for non-igneous rocks.
    pub extrusive: bool,
    pub color_rgb: [f32; 3],
}

impl Rock {
    /// Static property lookup. Values are baked into the binary.
    #[inline]
    pub fn properties(self) -> RockProperties {
        match self {
            // ----- Igneous extrusive ---------------------------------------
            Rock::Basalt => RockProperties {
                density_kg_m3: 3000.0,
                melt_temperature_k: 1473.0,
                origin: Origin::Igneous,
                extrusive: true,
                color_rgb: [0.18, 0.18, 0.20],
            },
            Rock::Rhyolite => RockProperties {
                density_kg_m3: 2520.0,
                melt_temperature_k: 1073.0,
                origin: Origin::Igneous,
                extrusive: true,
                color_rgb: [0.62, 0.42, 0.36],
            },
            Rock::Andesite => RockProperties {
                density_kg_m3: 2750.0,
                melt_temperature_k: 1273.0,
                origin: Origin::Igneous,
                extrusive: true,
                color_rgb: [0.40, 0.40, 0.42],
            },
            // ----- Igneous intrusive ---------------------------------------
            Rock::Gabbro => RockProperties {
                density_kg_m3: 3000.0,
                melt_temperature_k: 1473.0,
                origin: Origin::Igneous,
                extrusive: false,
                color_rgb: [0.20, 0.24, 0.22],
            },
            Rock::Granite => RockProperties {
                density_kg_m3: 2750.0,
                melt_temperature_k: 1473.0,
                origin: Origin::Igneous,
                extrusive: false,
                color_rgb: [0.66, 0.56, 0.50],
            },
            Rock::Diorite => RockProperties {
                density_kg_m3: 2900.0,
                melt_temperature_k: 1373.0,
                origin: Origin::Igneous,
                extrusive: false,
                color_rgb: [0.45, 0.46, 0.48],
            },
            // ----- Sedimentary --------------------------------------------
            Rock::Limestone => RockProperties {
                density_kg_m3: 2700.0,
                melt_temperature_k: 1373.0,
                origin: Origin::Sedimentary,
                extrusive: false,
                color_rgb: [0.84, 0.82, 0.74],
            },
            Rock::Sandstone => RockProperties {
                density_kg_m3: 2350.0,
                melt_temperature_k: 1473.0,
                origin: Origin::Sedimentary,
                extrusive: false,
                color_rgb: [0.85, 0.65, 0.45],
            },
            Rock::Shale => RockProperties {
                density_kg_m3: 2400.0,
                melt_temperature_k: 1473.0,
                origin: Origin::Sedimentary,
                extrusive: false,
                color_rgb: [0.30, 0.27, 0.24],
            },
            // Unlithified / lightly-lithified sediments are less dense than
            // mature shale; mud / ooze ~1.8 g/cm^3; we pick 2000 so it sits
            // distinctly below limestone (2700).
            Rock::OceanicSediment => RockProperties {
                density_kg_m3: 2000.0,
                melt_temperature_k: 1373.0,
                origin: Origin::Sedimentary,
                extrusive: false,
                color_rgb: [0.55, 0.50, 0.42],
            },
            // Continental-margin clays / silts; slightly denser than
            // ocean-floor ooze but still lighter than shale.
            Rock::ContinentalSediment => RockProperties {
                density_kg_m3: 2200.0,
                melt_temperature_k: 1373.0,
                origin: Origin::Sedimentary,
                extrusive: false,
                color_rgb: [0.78, 0.66, 0.50],
            },
            // ----- Metamorphic --------------------------------------------
            Rock::Schist => RockProperties {
                density_kg_m3: 2700.0,
                melt_temperature_k: 1473.0,
                origin: Origin::Metamorphic,
                extrusive: false,
                color_rgb: [0.45, 0.50, 0.42],
            },
            Rock::Gneiss => RockProperties {
                density_kg_m3: 2800.0,
                melt_temperature_k: 1473.0,
                origin: Origin::Metamorphic,
                extrusive: false,
                color_rgb: [0.60, 0.55, 0.50],
            },
            Rock::Eclogite => RockProperties {
                density_kg_m3: 3500.0,
                melt_temperature_k: 1473.0,
                origin: Origin::Metamorphic,
                extrusive: false,
                color_rgb: [0.55, 0.30, 0.25],
            },
            Rock::Blueschist => RockProperties {
                density_kg_m3: 3100.0,
                melt_temperature_k: 1273.0,
                origin: Origin::Metamorphic,
                extrusive: false,
                color_rgb: [0.30, 0.40, 0.55],
            },
        }
    }

    #[inline]
    pub fn density_kg_m3(self) -> f32 {
        self.properties().density_kg_m3
    }

    #[inline]
    pub fn melt_temperature_k(self) -> f32 {
        self.properties().melt_temperature_k
    }

    #[inline]
    pub fn origin(self) -> Origin {
        self.properties().origin
    }

    #[inline]
    pub fn color_rgb(self) -> [f32; 3] {
        self.properties().color_rgb
    }

    #[inline]
    pub fn is_igneous(self) -> bool {
        self.properties().origin == Origin::Igneous
    }

    #[inline]
    pub fn is_sedimentary(self) -> bool {
        self.properties().origin == Origin::Sedimentary
    }

    #[inline]
    pub fn is_metamorphic(self) -> bool {
        self.properties().origin == Origin::Metamorphic
    }

    /// True only for igneous extrusive (surface-erupted) lavas.
    #[inline]
    pub fn is_extrusive(self) -> bool {
        self.properties().extrusive
    }

    /// True only for igneous intrusive (deep / plutonic) rocks.
    #[inline]
    pub fn is_intrusive(self) -> bool {
        let p = self.properties();
        p.origin == Origin::Igneous && !p.extrusive
    }

    /// True if this rock can be carried down a subduction zone.
    ///
    /// Mirrors TE's `canSubduct` flag (`rock-properties.ts:24-95`). TE
    /// considers only oceanic-affinity rocks subductable: `OceanicSediment`,
    /// `Basalt`, `Gabbro`. Everything continental (`Granite`, `Diorite`,
    /// `Rhyolite`, `Andesite`, `ContinentalSediment`) plus the
    /// continental-shelf sediments (`Limestone`, `Sandstone`, `Shale`)
    /// returns `false`. Metamorphic rocks are not in TE; here we treat
    /// `Eclogite` as subductable (it forms *during* deep oceanic-slab
    /// subduction and continues sinking) and the rest as non-subductable.
    #[inline]
    pub fn can_subduct(self) -> bool {
        match self {
            // TE oceanic-affinity rocks.
            Rock::OceanicSediment | Rock::Basalt | Rock::Gabbro => true,
            // TE continental-affinity and continental-margin sediments.
            Rock::ContinentalSediment
            | Rock::Granite
            | Rock::Diorite
            | Rock::Rhyolite
            | Rock::Andesite
            | Rock::Limestone
            | Rock::Sandstone
            | Rock::Shale => false,
            // Hayba metamorphic extensions (not in TE).
            Rock::Eclogite => true,
            Rock::Schist | Rock::Gneiss | Rock::Blueschist => false,
        }
    }

    /// Canonical bottom-of-column rock for new oceanic crust.
    #[inline]
    pub fn default_oceanic_crust() -> Self {
        Rock::Basalt
    }

    /// Canonical bottom-of-column rock for new continental crust.
    #[inline]
    pub fn default_continental_crust() -> Self {
        Rock::Granite
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    const ALL_ROCKS: &[Rock] = &[
        Rock::Basalt,
        Rock::Rhyolite,
        Rock::Andesite,
        Rock::Gabbro,
        Rock::Granite,
        Rock::Diorite,
        Rock::Limestone,
        Rock::Sandstone,
        Rock::Shale,
        Rock::OceanicSediment,
        Rock::ContinentalSediment,
        Rock::Schist,
        Rock::Gneiss,
        Rock::Eclogite,
        Rock::Blueschist,
    ];

    #[test]
    fn discriminants_are_stable() {
        // Hard-pin every discriminant. If any of these change, the frame
        // stream format breaks.
        assert_eq!(Rock::Basalt as u8, 0);
        assert_eq!(Rock::Rhyolite as u8, 1);
        assert_eq!(Rock::Andesite as u8, 2);
        assert_eq!(Rock::Gabbro as u8, 10);
        assert_eq!(Rock::Granite as u8, 11);
        assert_eq!(Rock::Diorite as u8, 12);
        assert_eq!(Rock::Limestone as u8, 20);
        assert_eq!(Rock::Sandstone as u8, 21);
        assert_eq!(Rock::Shale as u8, 22);
        assert_eq!(Rock::OceanicSediment as u8, 23);
        assert_eq!(Rock::ContinentalSediment as u8, 24);
        assert_eq!(Rock::Schist as u8, 30);
        assert_eq!(Rock::Gneiss as u8, 31);
        assert_eq!(Rock::Eclogite as u8, 32);
        assert_eq!(Rock::Blueschist as u8, 33);
    }

    #[test]
    fn color_components_in_unit_range() {
        for &r in ALL_ROCKS {
            let c = r.color_rgb();
            for component in c {
                assert!(
                    (0.0..=1.0).contains(&component),
                    "rock {:?} color component {} out of [0,1]",
                    r,
                    component
                );
            }
        }
    }

    #[test]
    fn classification_helpers_consistent() {
        for &r in ALL_ROCKS {
            let igneous = r.is_igneous();
            let sed = r.is_sedimentary();
            let meta = r.is_metamorphic();
            // Exactly one of {igneous, sedimentary, metamorphic}.
            assert_eq!(igneous as u8 + sed as u8 + meta as u8, 1);
            // Extrusive implies igneous.
            if r.is_extrusive() {
                assert!(igneous);
            }
            // is_extrusive ^ is_intrusive == is_igneous (mutually exclusive halves).
            assert_eq!(igneous, r.is_extrusive() ^ r.is_intrusive());
        }
    }

    #[test]
    fn extrusive_less_dense_than_dense_metamorphic() {
        // Rhyolite (extrusive felsic) << Eclogite (deep dense metamorphic).
        assert!(Rock::Rhyolite.density_kg_m3() < Rock::Eclogite.density_kg_m3());
        // Sandstone (sed) < Eclogite (dense meta).
        assert!(Rock::Sandstone.density_kg_m3() < Rock::Eclogite.density_kg_m3());
        // Eclogite is the densest of our taxonomy.
        for &r in ALL_ROCKS {
            if r != Rock::Eclogite {
                assert!(
                    r.density_kg_m3() <= Rock::Eclogite.density_kg_m3(),
                    "{:?} denser than eclogite",
                    r
                );
            }
        }
    }

    #[test]
    fn default_oceanic_and_continental_crust_pick_canonical_rocks() {
        assert_eq!(Rock::default_oceanic_crust(), Rock::Basalt);
        assert_eq!(Rock::default_continental_crust(), Rock::Granite);
        assert!(Rock::default_oceanic_crust().is_extrusive());
        assert!(Rock::default_continental_crust().is_intrusive());
    }

    #[test]
    fn rock_serializes_roundtrip_bincode() {
        for &r in ALL_ROCKS {
            let bytes = bincode::serialize(&r).unwrap();
            let r2: Rock = bincode::deserialize(&bytes).unwrap();
            assert_eq!(r, r2);
        }
    }

    #[test]
    fn rock_serializes_roundtrip_json() {
        // JSON round-trip — names are stable serialization keys too.
        for &r in ALL_ROCKS {
            let s = serde_json::to_string(&r).unwrap();
            let r2: Rock = serde_json::from_str(&s).unwrap();
            assert_eq!(r, r2);
        }
    }

    /// Cross-check `Rock::can_subduct` against TE's `canSubduct` flag
    /// (`docs/research/te-snapshot/plates-model/rock-properties.ts:24-95`).
    /// Metamorphic rocks are Hayba-only — they are not asserted by this
    /// test because TE has no source-of-truth for them; see
    /// `metamorphic_can_subduct_is_hayba_choice` below.
    #[test]
    fn can_subduct_matches_te() {
        // TE flags (per frozen snapshot):
        //   OceanicSediment        : true
        //   Basalt                 : true
        //   Gabbro                 : true
        //   ContinentalSediment    : false
        //   Granite                : false
        //   Diorite                : false
        //   Rhyolite               : false
        //   Andesite               : false
        //   Limestone              : false
        //   Sandstone              : false
        //   Shale                  : false
        assert!(Rock::OceanicSediment.can_subduct());
        assert!(Rock::Basalt.can_subduct());
        assert!(Rock::Gabbro.can_subduct());
        assert!(!Rock::ContinentalSediment.can_subduct());
        assert!(!Rock::Granite.can_subduct());
        assert!(!Rock::Diorite.can_subduct());
        assert!(!Rock::Rhyolite.can_subduct());
        assert!(!Rock::Andesite.can_subduct());
        assert!(!Rock::Limestone.can_subduct());
        assert!(!Rock::Sandstone.can_subduct());
        assert!(!Rock::Shale.can_subduct());
    }

    #[test]
    fn metamorphic_can_subduct_is_hayba_choice() {
        // Eclogite forms during deep oceanic-slab subduction and keeps
        // sinking with the slab, so we mark it subductable.
        assert!(Rock::Eclogite.can_subduct());
        // The other metamorphics are continental-affinity → not subductable.
        assert!(!Rock::Schist.can_subduct());
        assert!(!Rock::Gneiss.can_subduct());
        assert!(!Rock::Blueschist.can_subduct());
    }

    #[test]
    fn melt_temperatures_positive() {
        for &r in ALL_ROCKS {
            assert!(r.melt_temperature_k() > 0.0);
        }
    }
}
