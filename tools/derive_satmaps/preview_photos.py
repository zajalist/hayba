"""Phase 1 of SatMap pipeline — download Wikimedia Commons reference photos
for each biome and save them to `tools/derive_satmaps/cache_photos/` so a
human can review the source images BEFORE the k-means extraction step.

Re-run after editing BIOMES (in extract.py) if you want different photos.

Usage:
    cd tools/derive_satmaps
    python preview_photos.py
"""
from __future__ import annotations

import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

from extract import BIOMES, CACHE_DIR, commons_search, fetch_image  # type: ignore

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")


def main() -> None:
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    print(f"Saving previews to {CACHE_DIR}\n")
    chosen: dict[str, str] = {}
    for name, query in BIOMES.items():
        attempt = 0
        while attempt < 3:
            try:
                print(f"[{name:>14}] searching: {query!r}")
                fn = commons_search(query)
                if fn is None:
                    print(f"[{name:>14}] no Wikimedia hit — SKIPPED")
                    break
                print(f"[{name:>14}]   -> {fn}")
                fetch_image(fn)  # cached side-effect
                chosen[name] = fn
                break
            except urllib.error.HTTPError as e:
                if e.code == 429:
                    wait = 5 * (attempt + 1)
                    print(f"[{name:>14}] rate-limited (429), waiting {wait}s")
                    time.sleep(wait)
                    attempt += 1
                else:
                    print(f"[{name:>14}] HTTP {e.code}: {e.reason}")
                    break
            except Exception as e:
                print(f"[{name:>14}] FAILED: {e}")
                break
        time.sleep(1.5)

    # Print a friendly summary so the human can grade each pick
    print("\n=== Summary ===")
    for name in BIOMES:
        if name in chosen:
            print(f"  {name:<14} ✓ {chosen[name]}")
        else:
            print(f"  {name:<14} ✗ (no photo)")
    print(f"\nReview the JPGs in {CACHE_DIR} then run `python extract.py` to derive SatMaps.")


if __name__ == "__main__":
    main()
