"""Derive 6 Gaea-style SatMaps from NASA Blue Marble + ETOPO1 + Köppen-Geiger.

See README.md for input downloads. Outputs 256x256 RGB PNGs to
apps/hayba/src/assets/satmaps/.
"""
from __future__ import annotations

from pathlib import Path

import numpy as np
from PIL import Image
from scipy.ndimage import gaussian_filter

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
    """Mean-bin colors into a (n_bins, n_bins, 3) array. Empty bins = NaN."""
    h = np.clip((elev * 0.5 + 0.5) * (n_bins - 1), 0, n_bins - 1).astype(np.int32)
    s = np.clip(slope * (n_bins - 1), 0, n_bins - 1).astype(np.int32)
    sums   = np.zeros((n_bins, n_bins, 3), dtype=np.float64)
    counts = np.zeros((n_bins, n_bins),    dtype=np.int32)
    valid  = mask.flatten()
    flat_h = h.flatten()[valid]
    flat_s = s.flatten()[valid]
    flat_c = color.reshape(-1, 3)[valid].astype(np.float64)
    np.add.at(sums,   (flat_h, flat_s), flat_c)
    np.add.at(counts, (flat_h, flat_s), 1)
    out = np.full((n_bins, n_bins, 3), np.nan, dtype=np.float32)
    nonzero = counts > 0
    for c in range(3):
        out[..., c][nonzero] = (sums[..., c][nonzero] / counts[nonzero]).astype(np.float32)
    return out


def inpaint(clut: np.ndarray, max_iterations: int = 20, sigma: float = 2.0) -> np.ndarray:
    """Fill NaN bins in a (n_bins, n_bins, 3) CLUT by iterated Gaussian smoothing."""
    out = clut.copy()
    nan_mask = np.isnan(out[..., 0])
    if not nan_mask.any():
        return out
    valid = (~nan_mask).astype(np.float32)
    filled = np.nan_to_num(out, nan=0.0)
    for _ in range(max_iterations):
        for c in range(3):
            num = gaussian_filter(filled[..., c] * valid, sigma=sigma)
            den = gaussian_filter(valid, sigma=sigma)
            den = np.maximum(den, 1e-6)
            new_c = num / den
            filled[..., c] = np.where(nan_mask, new_c, filled[..., c])
        valid = np.ones_like(valid)
        if not np.isnan(filled).any():
            break
    return filled


def derive_satmap(name: str, classes: set[int]) -> None:
    raise NotImplementedError


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    for name, classes in BIOME_MAP.items():
        derive_satmap(name, classes)


if __name__ == "__main__":
    main()
