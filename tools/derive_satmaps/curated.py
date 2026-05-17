"""Curated SatMaps — Gaea-style 1D vertical ramps, OkLab-interpolated.

Each SatMap is a 256x256 PNG. **Pure 1D vertical ramp** — every column is
identical. y-axis: top = peak, bottom = sea level. No slope variation in
the SatMap itself; the shader handles slope (later, via blending two
SatMaps or a separate rock mask). This matches Gaea's library convention
where each SatMap is a curated color palette, not a slope-modulated 2D
LUT.

Color interpolation is done in **OkLab** (Ottosson 2020): perceptually
uniform, so a transition from saturated green to saturated brown stays
vivid instead of passing through muddy grey.

Run:
    cd tools/derive_satmaps
    python curated.py

Outputs to ../../apps/hayba-explorer/src/assets/satmaps/<name>.png.
"""
from __future__ import annotations

from pathlib import Path
from typing import Sequence

import numpy as np
from PIL import Image

OUT_DIR = Path(__file__).parent.parent.parent / "apps" / "hayba-explorer" / "src" / "assets" / "satmaps"
SIZE = 256


# ── sRGB ↔ OkLab conversions ────────────────────────────────────────────────

def srgb_to_linear(c: np.ndarray) -> np.ndarray:
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def linear_to_srgb(c: np.ndarray) -> np.ndarray:
    return np.where(c <= 0.0031308, 12.92 * c, 1.055 * (c ** (1 / 2.4)) - 0.055)


_M1 = np.array([
    [0.4122214708, 0.5363325363, 0.0514459929],
    [0.2119034982, 0.6806995451, 0.1073969566],
    [0.0883024619, 0.2817188376, 0.6299787005],
])
_M2 = np.array([
    [0.2104542553,  0.7936177850, -0.0040720468],
    [1.9779984951, -2.4285922050,  0.4505937099],
    [0.0259040371,  0.7827717662, -0.8086757660],
])
_M1_inv = np.linalg.inv(_M1)
_M2_inv = np.linalg.inv(_M2)


def linear_to_oklab(c: np.ndarray) -> np.ndarray:
    lms = c @ _M1.T
    lms_signed_cbrt = np.sign(lms) * np.abs(lms) ** (1 / 3)
    return lms_signed_cbrt @ _M2.T


def oklab_to_linear(c: np.ndarray) -> np.ndarray:
    lms_cbrt = c @ _M2_inv.T
    lms = lms_cbrt ** 3 * np.sign(lms_cbrt)
    return lms @ _M1_inv.T


def srgb255_to_oklab(rgb: tuple[int, int, int]) -> np.ndarray:
    arr = np.array(rgb, dtype=np.float64) / 255.0
    return linear_to_oklab(srgb_to_linear(arr))


def oklab_to_srgb255(lab: np.ndarray) -> np.ndarray:
    lin = oklab_to_linear(lab)
    lin = np.clip(lin, 0.0, 1.0)
    return np.clip(linear_to_srgb(lin) * 255.0, 0, 255)


# ── Land-only palettes ──────────────────────────────────────────────────────
# Each stop: (position 0..1 in vertical TOP-TO-BOTTOM order — 0 = peak,
# 1 = sea level). Saturated, distinct bands. No blue.

PALETTES: dict[str, list[tuple[float, tuple[int, int, int]]]] = {
    # Mid-latitude — peak snow at top → granite → alpine grass → forest → coastal beach
    "temperate": [
        (0.00, (252, 252, 252)),  # snowcap (top)
        (0.06, (224, 224, 224)),  # firn
        (0.14, (180, 174, 162)),  # granite
        (0.26, (138, 122, 102)),  # rocky scree
        (0.42, (146, 138,  86)),  # alpine meadow
        (0.58, ( 92, 124,  62)),  # upland mixed forest
        (0.76, ( 56, 110,  44)),  # mid forest
        (0.88, (104, 152,  72)),  # coastal meadow
        (0.96, (200, 178, 124)),  # dune grass
        (1.00, (236, 212, 152)),  # beach (bottom)
    ],

    # Equatorial — bright tropical, lush rainforest, bright beach
    "tropical": [
        (0.00, (248, 244, 240)),  # rare summit snow
        (0.06, (168, 152, 132)),  # exposed volcanic
        (0.16, (148, 122,  68)),  # highland laterite
        (0.32, ( 70, 118,  56)),  # cloud forest
        (0.55, ( 36, 116,  42)),  # rainforest
        (0.78, ( 64, 152,  60)),  # coastal jungle
        (0.92, (220, 200, 140)),  # palm coast
        (1.00, (250, 232, 180)),  # bright beach
    ],

    # Desert sandstone — bone summit → mesa → red dune → sand
    "arid": [
        (0.00, (228, 214, 188)),  # bone summit
        (0.10, (172, 144, 108)),  # baked ridge
        (0.26, (156,  74,  42)),  # iron slope
        (0.44, (196, 104,  56)),  # mesa
        (0.64, (228, 156,  88)),  # red dune
        (0.84, (236, 204, 142)),  # bright dune
        (1.00, (224, 202, 148)),  # playa
    ],

    # Mountain rock — Gaea-Rock library — warm greys + granite + snow
    "alpine": [
        (0.00, (252, 252, 252)),  # snow peak
        (0.10, (228, 228, 226)),  # firn
        (0.26, (196, 188, 178)),  # light granite
        (0.46, (170, 160, 148)),  # mixed grey rock
        (0.66, (166, 144, 122)),  # warm rock (mid slope)
        (0.86, (146, 132, 108)),  # talus
        (1.00, (138, 124, 102)),  # foot scree
    ],

    # Polar — pale, near-monochrome, slightly cool
    "tundra": [
        (0.00, (252, 252, 252)),  # ice cap
        (0.20, (240, 242, 242)),  # glacier
        (0.45, (224, 226, 224)),  # frost-dusted ridge
        (0.70, (208, 208, 204)),  # tundra
        (1.00, (192, 198, 200)),  # permafrost edge
    ],

    # Maritime — sea cliff → kelp coast → narrow beach
    "oceanic": [
        (0.00, (244, 244, 244)),  # rare summit cap
        (0.16, (180, 180, 174)),  # sea cliff
        (0.36, (138, 140, 110)),  # weathered upland
        (0.58, ( 96, 128,  78)),  # damp meadow
        (0.80, ( 58, 114,  72)),  # kelp/saltmarsh
        (1.00, (220, 200, 152)),  # narrow beach
    ],
}


def interpolate_oklab(
    stops: Sequence[tuple[float, tuple[int, int, int]]],
    n: int,
) -> np.ndarray:
    """Sample a 1D ramp at `n` evenly-spaced positions in [0, 1] by
    interpolating in OkLab."""
    xs = np.array([p for p, _ in stops], dtype=np.float64)
    labs = np.stack([srgb255_to_oklab(c) for _, c in stops], axis=0)
    t = np.linspace(0.0, 1.0, n)
    out_lab = np.empty((n, 3), dtype=np.float64)
    for c in range(3):
        out_lab[:, c] = np.interp(t, xs, labs[:, c])
    return oklab_to_srgb255(out_lab)


def render(stops: list[tuple[float, tuple[int, int, int]]]) -> np.ndarray:
    """Render a 256x256 vertical 1D ramp: y = elevation (top=peak), x = const."""
    column = interpolate_oklab(stops, SIZE)              # (SIZE, 3)
    img = np.tile(column[:, None, :], (1, SIZE, 1))      # every column identical
    return np.clip(img, 0, 255).astype(np.uint8)


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    for name, stops in PALETTES.items():
        arr = render(stops)
        out_path = OUT_DIR / f"{name}.png"
        Image.fromarray(arr, "RGB").save(out_path)
        print(f"[OK] {name}.png ({len(stops)} stops, OkLab, pure 1D)")


if __name__ == "__main__":
    main()
