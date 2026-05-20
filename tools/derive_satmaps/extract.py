"""SatMap extractor — DEM-paired satellite color extraction.

Per Gemini's research:
  1. Crop a high-res satellite image to a specific region (no ocean, no
     irrelevant pixels) → pair each pixel with its matching DEM elevation.
  2. Bin pixels by elevation.
  3. For each bin, extract the MODE (most common color) — not the median or
     mean (which produce mud). We approximate mode with k-means (k=4) and
     take the centroid of the LARGEST cluster.
  4. Build a 1D LUT: vertical strip, top = highest elevation, bottom =
     lowest. Interpolate between bin modes in sRGB (per the research, OkLab
     is too smooth for geological strata).

Data sources (cached in `tools/derive_satmaps/cache/`):
  * `bluemarble_aug.png` — NASA Blue Marble Next Generation, August (PD).
  * `etopo1.tif`         — NOAA ETOPO1 (PD).

Per-biome cropping uses lat/lon bboxes with optional elevation masks so
each SatMap captures only the surface palette of that region.

Run:
    cd tools/derive_satmaps
    python extract.py [biome_name]   # optional — extract a single biome
"""
from __future__ import annotations

import sys
from pathlib import Path

import colorsys
import json

import numpy as np
import rasterio
from PIL import Image
from scipy.cluster.vq import kmeans2

from biomes import LIBRARY

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

CACHE_DIR = Path(__file__).parent / "cache"
OUT_DIR   = Path(__file__).parent.parent.parent / "apps" / "hayba-explorer" / "src" / "assets" / "satmaps"

LUT_WIDTH  = 256
LUT_HEIGHT = 1024
N_ELEV_BINS = 40        # Gemini: 20-50 stops typical for production SatMaps
K_PER_BIN   = 8         # k-means k inside each elevation bin; each cluster's
                        # centroid is one of the mode colors for that band
MAX_PIXELS_PER_BIN = 10_000

# Saturation boost factor (HSV-space). Satellite imagery is desaturated by
# atmospheric Rayleigh scattering — boosting saturation 1.4× brings the
# colors closer to what the artist would have seen on the ground.
SATURATION_BOOST = 1.5
VALUE_GAMMA = 0.92      # slight gamma push to keep mids vivid after sat-boost

# Common target raster size for paired DEM+color analysis. NASA BMNG is
# 5400×2700 (when downloaded at that resolution), ETOPO1 is 21600×10800. We
# resample ETOPO1 down to BMNG's grid for pixel-by-pixel pairing.
TARGET_W = 5400
TARGET_H = 2700


# ── Biome specifications ────────────────────────────────────────────────────
# bbox = (lat_max, lat_min, lon_min, lon_max) — top, bottom, left, right of
# an equirectangular crop.
# mask: optional dict with elev_min / elev_max (meters) to filter pixels.
# is_water: if True, the elevation mask uses depth (negative elev). Otherwise
# elevation must be ≥ 0 by default (land-only).

# Scientifically-tagged library (climate × geology) imported from biomes.py.
# Each entry has bbox + mask + climate + geology metadata so the renderer
# can match SatMaps to per-cell sim state at sample time.
BIOMES: dict[str, dict] = LIBRARY


# ── Data loading ────────────────────────────────────────────────────────────

def load_inputs() -> tuple[np.ndarray, np.ndarray]:
    """Load Blue Marble (color RGB) + ETOPO1 (elevation, meters) resampled to
    a common (TARGET_H, TARGET_W) equirectangular grid."""
    bm_path = CACHE_DIR / "bluemarble_aug.png"
    etopo_path = CACHE_DIR / "etopo1.tif"
    if not bm_path.exists() or not etopo_path.exists():
        raise SystemExit(
            f"Missing cached inputs. Run preview / bake setup first.\n"
            f"  Expected: {bm_path}\n"
            f"  Expected: {etopo_path}"
        )
    color = np.array(Image.open(bm_path).resize((TARGET_W, TARGET_H), Image.LANCZOS))[..., :3]
    with rasterio.open(etopo_path) as src:
        elev = src.read(1, out_shape=(TARGET_H, TARGET_W), resampling=rasterio.enums.Resampling.bilinear)
    return color, elev.astype(np.float32)


def latlon_to_yx(lat: float, lon: float, h: int = TARGET_H, w: int = TARGET_W) -> tuple[int, int]:
    """Equirectangular projection — lat ∈ [-90, 90], lon ∈ [-180, 180]."""
    y = int(round((90.0 - lat) / 180.0 * h))
    x = int(round((lon + 180.0) / 360.0 * w))
    return max(0, min(h - 1, y)), max(0, min(w - 1, x))


# ── Mode-per-bin extraction ─────────────────────────────────────────────────

def boost_saturation(rgb_0_255: np.ndarray) -> np.ndarray:
    """Push saturation up (HSV space) to counter atmospheric desaturation
    inherent in satellite imagery. Applies to a (..., 3) RGB array in 0..255."""
    flat = rgb_0_255.reshape(-1, 3) / 255.0
    out = np.empty_like(flat)
    for i, (r, g, b) in enumerate(flat):
        h, s, v = colorsys.rgb_to_hsv(r, g, b)
        s = min(1.0, s * SATURATION_BOOST)
        v = v ** VALUE_GAMMA
        out[i] = colorsys.hsv_to_rgb(h, s, v)
    return np.clip(out * 255.0, 0, 255).reshape(rgb_0_255.shape)


def mode_colors(pixels: np.ndarray, k: int = K_PER_BIN) -> tuple[np.ndarray, np.ndarray]:
    """Run k-means with k clusters, return (centers, weights) sorted by
    cluster size descending. centers: (k_actual, 3) RGB float, saturation-
    boosted to counter atmospheric desaturation. weights: (k_actual,)
    summing to 1.0 — fraction of pixels in each cluster."""
    n = len(pixels)
    if n < k:
        center = pixels.mean(axis=0)
        return boost_saturation(center[None, :]), np.ones(1)
    sample = pixels
    if n > MAX_PIXELS_PER_BIN:
        rng = np.random.default_rng(seed=42)
        sample = pixels[rng.choice(n, MAX_PIXELS_PER_BIN, replace=False)]
    centers, labels = kmeans2(sample.astype(np.float64), k, minit="++", seed=42)
    sizes = np.bincount(labels, minlength=k).astype(np.float64)
    order = np.argsort(sizes)[::-1]
    centers = boost_saturation(centers[order])
    sizes = sizes[order]
    return centers, sizes / sizes.sum()


def extract_biome(name: str, spec: dict, color: np.ndarray, elev: np.ndarray) -> np.ndarray | None:
    """Return a (LUT_HEIGHT, LUT_WIDTH, 3) RGB SatMap for this biome, or None
    if there were no valid pixels in the cropped+masked region."""
    bbox = spec["bbox"]
    y_top,  x_left  = latlon_to_yx(bbox[0], bbox[2])
    y_bot,  x_right = latlon_to_yx(bbox[1], bbox[3])
    if y_bot <= y_top or x_right <= x_left:
        print(f"[{name:>14}] degenerate bbox — SKIPPED")
        return None

    color_crop = color[y_top:y_bot, x_left:x_right]      # (h, w, 3)
    elev_crop  = elev [y_top:y_bot, x_left:x_right]      # (h, w)

    # Build mask
    mask_cfg = spec.get("mask", {})
    is_water = spec.get("is_water", False)
    mask = np.ones(color_crop.shape[:2], dtype=bool)
    if "elev_min" in mask_cfg:
        mask &= elev_crop >= mask_cfg["elev_min"]
    if "elev_max" in mask_cfg:
        mask &= elev_crop <= mask_cfg["elev_max"]
    # If neither bound is specified, default to land-only (elev >= 0)
    if "elev_min" not in mask_cfg and "elev_max" not in mask_cfg and not is_water:
        mask &= elev_crop >= 0

    n_valid = int(mask.sum())
    if n_valid < 200:
        print(f"[{name:>14}] only {n_valid} valid pixels — SKIPPED")
        return None

    pixels = color_crop[mask]                  # (n_valid, 3)
    elevs  = elev_crop[mask]                   # (n_valid,)

    # Per-bin: extract up to K_PER_BIN modes (centers, weights). bin_modes[i]
    # is either a list of (color, weight) tuples or None for empty bins.
    e_min = float(elevs.min())
    e_max = float(elevs.max())
    e_span = max(e_max - e_min, 1.0)

    bin_modes: list[list[tuple[np.ndarray, float]] | None] = [None] * N_ELEV_BINS
    for i in range(N_ELEV_BINS):
        lo = e_min + i / N_ELEV_BINS * e_span
        hi = e_min + (i + 1) / N_ELEV_BINS * e_span
        b_mask = (elevs >= lo) & (elevs <= hi if i == N_ELEV_BINS - 1 else elevs < hi)
        bin_pixels = pixels[b_mask]
        if len(bin_pixels) < 5:
            continue
        centers, weights = mode_colors(bin_pixels)
        bin_modes[i] = list(zip(centers, weights))

    # Fill empty bins by carrying forward from the nearest non-empty bin
    bin_modes = inpaint_bin_modes(bin_modes)

    return build_lut_banded(bin_modes)


def inpaint_bin_modes(bins: list) -> list:
    """Fill any None entries by copying from the nearest non-None neighbour."""
    n = len(bins)
    last_non_none = next((b for b in bins if b is not None), None)
    if last_non_none is None:
        return bins
    out: list = [None] * n
    for i in range(n):
        if bins[i] is not None:
            out[i] = bins[i]
            last_non_none = bins[i]
        else:
            out[i] = last_non_none
    # Backward pass for leading Nones
    next_non_none = None
    for i in range(n - 1, -1, -1):
        if out[i] is None:
            out[i] = next_non_none
        else:
            next_non_none = out[i]
    return out


def build_lut_banded(bin_modes: list) -> np.ndarray:
    """Build a Gaea-style banded LUT — SHARP horizontal strata (one band per
    elevation bin) with HORIZONTAL color variation within each band
    (multiple k-means modes distributed across the LUT width by deterministic
    pseudo-noise, weighted by cluster size). Top row = highest elevation."""
    # Reverse so row 0 = highest elevation (peaks at top, Gaea convention)
    modes_top_down = list(reversed(bin_modes))
    n = len(modes_top_down)
    rows_per_bin = LUT_HEIGHT // n
    leftover = LUT_HEIGHT - rows_per_bin * n  # distribute extra rows to top bins

    img = np.zeros((LUT_HEIGHT, LUT_WIDTH, 3), dtype=np.float64)
    rng = np.random.default_rng(seed=12345)
    y = 0
    for i, modes in enumerate(modes_top_down):
        h = rows_per_bin + (1 if i < leftover else 0)
        if modes is None:
            y += h
            continue
        # Build a horizontal arrangement: each x in [0, LUT_WIDTH) picks one
        # of the k modes, with probability proportional to its cluster size.
        weights = np.array([w for _, w in modes], dtype=np.float64)
        weights /= weights.sum()
        cum = np.cumsum(weights)
        # Deterministic per-bin pseudo-noise for which mode each column picks
        col_choice = np.searchsorted(cum, rng.random(LUT_WIDTH))
        col_choice = np.clip(col_choice, 0, len(modes) - 1)
        # Tiny per-column tonal jitter (±4) to break up flat-color streaks
        jitter = rng.normal(0.0, 3.0, size=(LUT_WIDTH, 3))
        for x in range(LUT_WIDTH):
            color = modes[col_choice[x]][0]
            img[y:y+h, x, :] = color + jitter[x]
        y += h
    return np.clip(img, 0, 255).astype(np.uint8)


# ── Driver ──────────────────────────────────────────────────────────────────

def main(only: str | None = None) -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    print("Loading Blue Marble + ETOPO1 …")
    color, elev = load_inputs()
    print(f"Resampled to {color.shape[1]}×{color.shape[0]} @ ~{360/color.shape[1]*111:.1f} km/pixel near equator\n")

    metadata: dict[str, dict] = {}
    for name, spec in BIOMES.items():
        if only and name != only:
            continue
        img = extract_biome(name, spec, color, elev)
        if img is None:
            continue
        out_path = OUT_DIR / f"{name}.png"
        Image.fromarray(img, "RGB").save(out_path)
        print(f"[{name:>22}] ✓ {out_path.name}")
        # Strip non-JSON-serializable bits before recording metadata
        metadata[name] = {
            "region": spec.get("region", ""),
            "climate": spec.get("climate", {}),
            "geology": spec.get("geology", {}),
            "elevation_band_m": [
                spec.get("mask", {}).get("elev_min"),
                spec.get("mask", {}).get("elev_max"),
            ],
        }

    if not only:
        meta_path = OUT_DIR / "satmaps.json"
        meta_path.write_text(json.dumps(metadata, indent=2, ensure_ascii=False))
        print(f"\nWrote metadata sidecar: {meta_path}")


if __name__ == "__main__":
    only = sys.argv[1] if len(sys.argv) > 1 else None
    main(only)
