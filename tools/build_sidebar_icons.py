"""Rebuild the editor rail's 2x PNGs from its hand-authored SVG sources.

Run with ``python tools/build_sidebar_icons.py`` after installing CairoSVG.
The PNGs are checked in so plugin users do not need CairoSVG.
"""

from pathlib import Path

import cairosvg


ROOT = Path(__file__).resolve().parents[1]
ICONS = ROOT / "unreal" / "HaybaMCPToolkit" / "Resources" / "Icons"
NAMES = ("chat", "activity", "rules", "world", "library", "settings")


def main() -> None:
    for name in NAMES:
        cairosvg.svg2png(
            url=str(ICONS / f"{name}.svg"),
            write_to=str(ICONS / f"{name}@56.png"),
            output_width=56,
            output_height=56,
        )


if __name__ == "__main__":
    main()
