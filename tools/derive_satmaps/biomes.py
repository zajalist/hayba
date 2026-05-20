"""Scientifically-tagged SatMap library — climate × geology categories.

Each entry is a (climate_class × geology_class) intersection sampled from a
real-world region that exhibits that combination. The metadata is what the
renderer reads at sample time to pick a SatMap (or blend several) for each
cell based on its sim state.

Climate classes (derivable from cell_latitude_band + cell_elevation + future
cell_precipitation):
  - tropical_wet      (Köppen Af, Am — rainforest, monsoon)
  - tropical_dry      (Aw, As — savanna)
  - arid_hot          (BWh, BSh — hot desert, hot steppe)
  - arid_cold         (BWk, BSk — cold desert, cold steppe)
  - temperate_humid   (Cf — humid subtropical / oceanic)
  - temperate_med     (Cs — mediterranean dry summer)
  - continental       (D — cold continental, seasonal extremes)
  - polar_tundra      (ET — alpine + arctic tundra)
  - polar_icecap      (EF — permanent ice)

Geology classes (derivable from cell_continental + cell_collision_kind +
cell_orogenic_uplift + cell_volcanic_intensity + cell_age_ma):
  - stable_craton       (old continental, low uplift, low volcanic)
  - active_orogeny      (high cell_orogenic_uplift)
  - volcanic_arc        (cell_collision_kind == subduction + high volcanic)
  - hotspot_volcanic    (oceanic, high volcanic_intensity, no subduction)
  - continental_rift    (divergent boundary + volcanic adjacent)
  - sedimentary_basin   (continental, low elev, low uplift)
  - oceanic_basin       (oceanic crust)
  - coastal_shelf       (continental edge, very low elev)

bbox order is (lat_max, lat_min, lon_min, lon_max).
"""

# Each entry: name → spec
# spec keys: bbox, mask, climate, geology, region
LIBRARY: dict[str, dict] = {

    # ── Tropical wet ────────────────────────────────────────────────────────
    "tropical_wet_basin": {
        "bbox": (0, -10, -75, -50),
        "mask": {"elev_min": 10, "elev_max": 600},
        "region": "Amazon lowlands",
        "climate": {"class": "tropical_wet", "koppen": ["Af", "Am"], "lat_band": [0]},
        "geology": {"class": "sedimentary_basin", "crust": "continental", "tectonic": "stable"},
    },
    "tropical_wet_orogeny": {
        "bbox": (-5, -15, -78, -68),
        "mask": {"elev_min": 600, "elev_max": 4500},
        "region": "Andes east slope (Peruvian Amazon)",
        "climate": {"class": "tropical_wet", "koppen": ["Af", "Cwb"], "lat_band": [0, 1]},
        "geology": {"class": "active_orogeny", "crust": "continental", "tectonic": "convergent"},
    },
    "tropical_wet_volcanic": {
        "bbox": (5, -5, 95, 125),
        "mask": {"elev_min": 50, "elev_max": 3000},
        "region": "Indonesian arc",
        "climate": {"class": "tropical_wet", "koppen": ["Af", "Am"], "lat_band": [0]},
        "geology": {"class": "volcanic_arc", "crust": "continental", "tectonic": "subduction"},
    },

    # ── Tropical dry / savanna ──────────────────────────────────────────────
    "tropical_dry_craton": {
        "bbox": (-1, -5, 32, 38),
        "mask": {"elev_min": 500, "elev_max": 2500},
        "region": "Serengeti / East African plateau",
        "climate": {"class": "tropical_dry", "koppen": ["Aw"], "lat_band": [0, 1]},
        "geology": {"class": "stable_craton", "crust": "continental", "tectonic": "stable"},
    },
    "tropical_dry_rift": {
        "bbox": (5, -10, 28, 38),
        "mask": {"elev_min": 400, "elev_max": 2000},
        "region": "East African Rift",
        "climate": {"class": "tropical_dry", "koppen": ["Aw", "BSh"], "lat_band": [0, 1]},
        "geology": {"class": "continental_rift", "crust": "continental", "tectonic": "divergent"},
    },

    # ── Arid hot ────────────────────────────────────────────────────────────
    "arid_hot_dunes": {
        "bbox": (30, 18, -10, 35),
        "mask": {"elev_min": 50, "elev_max": 800},
        "region": "Sahara central / Algerian sand seas",
        "climate": {"class": "arid_hot", "koppen": ["BWh"], "lat_band": [1, 2]},
        "geology": {"class": "sedimentary_basin", "crust": "continental", "tectonic": "stable"},
    },
    "arid_hot_craton": {
        "bbox": (28, 20, 0, 30),
        "mask": {"elev_min": 500, "elev_max": 3000},
        "region": "Hoggar / Tibesti volcanic plateau",
        "climate": {"class": "arid_hot", "koppen": ["BWh"], "lat_band": [1, 2]},
        "geology": {"class": "stable_craton", "crust": "continental", "tectonic": "stable"},
    },
    "arid_hot_orogeny": {
        "bbox": (35, 28, -115, -106),
        "mask": {"elev_min": 500, "elev_max": 4000},
        "region": "Sonoran / Sierra Madre",
        "climate": {"class": "arid_hot", "koppen": ["BWh", "BSh"], "lat_band": [1, 2]},
        "geology": {"class": "active_orogeny", "crust": "continental", "tectonic": "convergent"},
    },

    # ── Arid cold ───────────────────────────────────────────────────────────
    "arid_cold_plateau": {
        "bbox": (36, 30, 80, 95),
        "mask": {"elev_min": 3500, "elev_max": 5500},
        "region": "Tibetan Plateau",
        "climate": {"class": "arid_cold", "koppen": ["BWk", "ET"], "lat_band": [2, 3]},
        "geology": {"class": "active_orogeny", "crust": "continental", "tectonic": "convergent"},
    },
    "arid_cold_steppe": {
        "bbox": (50, 40, 80, 110),
        "mask": {"elev_min": 500, "elev_max": 2000},
        "region": "Gobi / Mongolian steppe",
        "climate": {"class": "arid_cold", "koppen": ["BWk", "BSk"], "lat_band": [2, 3]},
        "geology": {"class": "stable_craton", "crust": "continental", "tectonic": "stable"},
    },
    "arid_cold_salt": {
        "bbox": (-19, -21, -68, -67),
        "mask": {"elev_min": 3500, "elev_max": 3800},
        "region": "Salar de Uyuni",
        "climate": {"class": "arid_cold", "koppen": ["BWk"], "lat_band": [2]},
        "geology": {"class": "sedimentary_basin", "crust": "continental", "tectonic": "stable",
                    "lithology": "evaporite"},
    },

    # ── Temperate ───────────────────────────────────────────────────────────
    "temperate_humid_orogeny": {
        "bbox": (48, 45, 6, 14),
        "mask": {"elev_min": 200, "elev_max": 4500},
        "region": "Alps",
        "climate": {"class": "temperate_humid", "koppen": ["Cfb", "Dfb"], "lat_band": [2]},
        "geology": {"class": "active_orogeny", "crust": "continental", "tectonic": "convergent"},
    },
    "temperate_humid_old_mountain": {
        "bbox": (40, 35, -85, -78),
        "mask": {"elev_min": 200, "elev_max": 2000},
        "region": "Appalachian Mountains",
        "climate": {"class": "temperate_humid", "koppen": ["Cfa", "Dfa"], "lat_band": [2]},
        "geology": {"class": "stable_craton", "crust": "continental", "tectonic": "stable",
                    "lithology": "metamorphic"},
    },
    "temperate_humid_coast": {
        "bbox": (52, 49, -10, 2),
        "mask": {"elev_min": 0, "elev_max": 600},
        "region": "British Isles",
        "climate": {"class": "temperate_humid", "koppen": ["Cfb"], "lat_band": [2]},
        "geology": {"class": "coastal_shelf", "crust": "continental", "tectonic": "stable"},
    },
    "temperate_med": {
        "bbox": (42, 36, 20, 28),
        "mask": {"elev_min": 0, "elev_max": 1500},
        "region": "Aegean / Greek mainland",
        "climate": {"class": "temperate_med", "koppen": ["Csa"], "lat_band": [2]},
        "geology": {"class": "active_orogeny", "crust": "continental", "tectonic": "convergent"},
    },

    # ── Continental ─────────────────────────────────────────────────────────
    "continental_steppe": {
        "bbox": (55, 48, 30, 60),
        "mask": {"elev_min": 100, "elev_max": 800},
        "region": "Russian / Ukrainian steppe",
        "climate": {"class": "continental", "koppen": ["Dfa", "Dfb", "BSk"], "lat_band": [2, 3]},
        "geology": {"class": "sedimentary_basin", "crust": "continental", "tectonic": "stable"},
    },
    "continental_shield": {
        "bbox": (60, 50, -100, -80),
        "mask": {"elev_min": 100, "elev_max": 1000},
        "region": "Canadian Shield",
        "climate": {"class": "continental", "koppen": ["Dfb", "Dfc"], "lat_band": [3]},
        "geology": {"class": "stable_craton", "crust": "continental", "tectonic": "stable"},
    },
    "continental_orogeny": {
        "bbox": (45, 36, -113, -104),
        "mask": {"elev_min": 1500, "elev_max": 4400},
        "region": "Rocky Mountains",
        "climate": {"class": "continental", "koppen": ["Dfb", "Dfc"], "lat_band": [2, 3]},
        "geology": {"class": "active_orogeny", "crust": "continental", "tectonic": "convergent"},
    },

    # ── Polar ───────────────────────────────────────────────────────────────
    "polar_tundra": {
        "bbox": (75, 60, -55, -20),
        "mask": {"elev_min": 150, "elev_max": 1500},   # bumped from 10 → 150 to exclude coastal water pixels
        "region": "Greenland coastal tundra",
        "climate": {"class": "polar_tundra", "koppen": ["ET"], "lat_band": [3, 4]},
        "geology": {"class": "stable_craton", "crust": "continental", "tectonic": "stable"},
    },
    "polar_icecap": {
        "bbox": (80, 65, -50, -30),
        "mask": {"elev_min": 1500, "elev_max": 3500},
        "region": "Greenland ice sheet interior",
        "climate": {"class": "polar_icecap", "koppen": ["EF"], "lat_band": [4]},
        "geology": {"class": "stable_craton", "crust": "continental", "tectonic": "stable",
                    "surface": "ice"},
    },

    # ── Volcanic / igneous ──────────────────────────────────────────────────
    "volcanic_hotspot_young": {
        "bbox": (66, 63, -25, -13),
        "mask": {"elev_min": 200, "elev_max": 2000},   # bumped from 50 → 200 to exclude coastline
        "region": "Iceland (basaltic hotspot + spreading)",
        "climate": {"class": "polar_tundra", "koppen": ["ET", "Cfc"], "lat_band": [3]},
        "geology": {"class": "hotspot_volcanic", "crust": "oceanic", "tectonic": "divergent",
                    "lithology": "basalt_young"},
    },
    "volcanic_weathered_red": {
        "bbox": (22, 17, 73, 80),
        "mask": {"elev_min": 300, "elev_max": 1200},
        "region": "Deccan Traps (ancient flood basalt)",
        "climate": {"class": "tropical_dry", "koppen": ["Aw", "BSh"], "lat_band": [1]},
        "geology": {"class": "stable_craton", "crust": "continental", "tectonic": "stable",
                    "lithology": "basalt_weathered"},
    },

    # ── Oceanic ─────────────────────────────────────────────────────────────
    "ocean_deep": {
        "bbox": (10, 0, -160, -140),
        "mask": {"elev_max": -3000},
        "region": "Pacific abyssal basin",
        "climate": {"class": "tropical_wet", "koppen": ["Af"], "lat_band": [0, 1]},
        "geology": {"class": "oceanic_basin", "crust": "oceanic", "tectonic": "stable"},
    },
    "ocean_shallow_reef": {
        "bbox": (24, 18, -82, -78),
        "mask": {"elev_min": -200, "elev_max": -10},
        "region": "Bahamas / Caribbean shallow shelf",
        "climate": {"class": "tropical_wet", "koppen": ["Af"], "lat_band": [1]},
        "geology": {"class": "coastal_shelf", "crust": "continental", "tectonic": "stable"},
    },
    "ocean_sediment": {
        "bbox": (2, -2, -52, -46),
        "mask": {"elev_min": -300, "elev_max": 0},
        "region": "Amazon river mouth plume",
        "climate": {"class": "tropical_wet", "koppen": ["Af"], "lat_band": [0]},
        "geology": {"class": "coastal_shelf", "crust": "continental", "tectonic": "stable",
                    "modifier": "sediment_laden"},
    },
}
