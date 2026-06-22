"""Hayba visual sidecar — SAM segmentation + world-position back-projection.

A small FastAPI service the MCP/agent calls to turn agent-grounded boxes into
geometry-hugging masks. SAM is lazy-loaded on the first segment call so the
process starts fast and `/health` works without the (multi-GB) weights present.

Run: `uvicorn app:app --port 7821`  (or ./run.ps1)
"""
from __future__ import annotations

import os

import numpy as np
import imageio.v2 as iio
from fastapi import FastAPI

from projection import (
    assign_triangles, bake_uv_texture,
    read_worldpos_exr, read_uv_exr, load_mesh,
)

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


def _run_sam(image, box=None, points=None):
    """Refine an agent box/points into a binary mask via SAM. Monkeypatched in
    tests so projection can be exercised without the weights."""
    predictor = _load_sam()
    img = np.asarray(image)
    if img.ndim == 2:
        img = np.stack([img] * 3, axis=-1)
    img = img[..., :3]                       # drop alpha — SAM wants HxWx3 RGB
    if img.dtype != np.uint8:
        img = np.clip(img, 0, 255).astype(np.uint8)
    predictor.set_image(np.ascontiguousarray(img))
    box_arr = np.asarray(box, dtype=float) if box is not None else None
    pts = lbls = None
    if points:
        pts = np.asarray([[p[0], p[1]] for p in points], dtype=float)
        lbls = np.asarray([(p[2] if len(p) > 2 else 1) for p in points], dtype=int)
    masks, _scores, _ = predictor.predict(
        point_coords=pts, point_labels=lbls, box=box_arr, multimask_output=False
    )
    return np.asarray(masks[0], dtype=bool)


@app.post("/segment_project")
def segment_project(req: dict):
    """SAM-segment each agent box, back-project to triangles via the world-position
    pass, and bake a UV display texture. Never throws — errors return {ok:false}."""
    try:
        study_dir = req["study_dir"]
        parts = req["parts"]
        vote_threshold = int(req.get("vote_threshold", 1))
        res = int(req.get("res", 512))

        mesh = load_mesh(os.path.join(study_dir, "mesh_lod0.json"))
        n_faces = len(mesh.faces)

        # Union of referenced views, loaded once and shared across parts.
        view_ids = sorted({v["view"] for p in parts for v in p["views"]})
        local = {vi: i for i, vi in enumerate(view_ids)}
        color_imgs, wp_views, uv_views = [], [], []
        for vi in view_ids:
            color_imgs.append(iio.imread(os.path.join(study_dir, f"color_v{vi}.png")))
            wp_views.append(read_worldpos_exr(os.path.join(study_dir, f"worldpos_v{vi}.exr")))
            uv_views.append(read_uv_exr(os.path.join(study_dir, f"uv_v{vi}.exr")))

        # SAM each part's boxes → per-view masks aligned to the shared view list.
        masks_by_part, skipped = {}, []
        for p in parts:
            label = p["label"]
            masks = [None] * len(view_ids)
            for v in p["views"]:
                i = local[v["view"]]
                m = _run_sam(color_imgs[i], box=v.get("box"), points=v.get("points"))
                masks[i] = m
            if not any(m is not None and m.any() for m in masks):
                skipped.append(label)
            masks_by_part[label] = masks

        tri = assign_triangles(wp_views, masks_by_part, mesh, vote_threshold)

        masks_dir = os.path.join(study_dir, "masks")
        os.makedirs(masks_dir, exist_ok=True)
        has_uv = any(uv is not None for uv in uv_views)

        results = []
        for p in parts:
            label = p["label"]
            tris = sorted(tri.get(label, set()))
            texture = None
            if has_uv:
                tex = bake_uv_texture(uv_views, masks_by_part[label], res=res)
                texture = os.path.join(masks_dir, f"{label}.png")
                iio.imwrite(texture, tex)
            results.append({
                "label": label,
                "texture": texture,
                "triangles": tris,
                "color": p.get("color", "#48A0FF"),
                "coverage": (len(tris) / n_faces) if n_faces else 0.0,
            })
        return {"ok": True, "masks": results, "skipped": skipped}
    except Exception as e:
        return {"ok": False, "error": f"{type(e).__name__}: {e}"}
