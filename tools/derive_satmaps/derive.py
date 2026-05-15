"""Derive 6 Gaea-style SatMaps from NASA Blue Marble + ETOPO1 + Köppen-Geiger.

See README.md for input downloads. Outputs 256x256 RGB PNGs to
apps/hayba/src/assets/satmaps/.
"""
from __future__ import annotations

from pathlib import Path

import numpy as np
from PIL import Image

CACHE_DIR = Path(__file__).parent / "cache"
OUT_DIR = Path(__file__).parent.parent.parent / "apps" / "hayba" / "src" / "assets" / "satmaps"
CLUT_SIZE = 256

# Köppen class codes → our biome buckets. Beck et al. 2018 raster uses
# integer class codes 1..30. See koeppen-geiger.vu-wien.ac.at for the table.
BIOME_MAP: dict[str, set[int]] = {
    "tropical":  {1, 2, 3},                # Af, Am, Aw
    "arid":      {4, 5, 6, 7},             # BWh, BWk, BSh, BSk
    "temperate": {8, 9, 10, 14, 15, 16},   # C-class
    "alpine":    {25, 26, 27},             # ET subset above tree line
    "tundra":    {29, 30},                 # ET-low / EF
    "oceanic":   {11, 12, 13, 17, 18},     # mid-lat oceanic + maritime
}


def bin_samples(
    color: np.ndarray,         # (H, W, 3) uint8 RGB
    elev:  np.ndarray,         # (H, W)    float
    slope: np.ndarray,         # (H, W)    float in 0..1
    mask:  np.ndarray,         # (H, W)    bool
    n_bins: int = CLUT_SIZE,
) -> np.ndarray:
    """Median-bin colors into a (n_bins, n_bins, 3) array. Empty bins = NaN."""
    raise NotImplementedError


def inpaint(clut: np.ndarray) -> np.ndarray:
    """Fill NaN bins in a (n_bins, n_bins, 3) CLUT by iterated Gaussian smoothing."""
    raise NotImplementedError


def derive_satmap(name: str, classes: set[int]) -> None:
    raise NotImplementedError


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    for name, classes in BIOME_MAP.items():
        derive_satmap(name, classes)


if __name__ == "__main__":
    main()
