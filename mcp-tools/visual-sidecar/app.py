"""Hayba visual sidecar — SAM segmentation + world-position back-projection.

A small FastAPI service the MCP/agent calls to turn agent-grounded boxes into
geometry-hugging masks. SAM is lazy-loaded on the first segment call so the
process starts fast and `/health` works without the (multi-GB) weights present.

Run: `uvicorn app:app --port 7821`  (or ./run.ps1)
"""
from __future__ import annotations

import os
from fastapi import FastAPI

app = FastAPI(title="hayba-visual-sidecar", version="0.1.0")

# Lazy SAM predictor handle. None until _load_sam() runs on the first segment.
_SAM = None

# Where SAM weights are cached / looked up.
SAM_CACHE = os.environ.get("HAYBA_SAM_CACHE", os.path.expanduser("~/.cache/hayba-sam"))


def _load_sam():
    """Build + memoize the SAM predictor. Imported lazily so the heavy deps
    (torch, segment-anything) are only required when segmentation runs."""
    global _SAM
    if _SAM is not None:
        return _SAM
    from segment_anything import sam_model_registry, SamPredictor  # type: ignore
    import torch  # type: ignore

    os.makedirs(SAM_CACHE, exist_ok=True)
    ckpt = os.environ.get("HAYBA_SAM_CHECKPOINT", os.path.join(SAM_CACHE, "sam_vit_b_01ec64.pth"))
    model_type = os.environ.get("HAYBA_SAM_MODEL", "vit_b")
    sam = sam_model_registry[model_type](checkpoint=ckpt)
    sam.to("cuda" if torch.cuda.is_available() else "cpu")
    _SAM = SamPredictor(sam)
    return _SAM


@app.get("/health")
def health():
    return {"ok": True, "model_loaded": _SAM is not None}
