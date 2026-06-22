"""World-position triangle projection + UV-texture bake.

Triangle assignment is done in 3D (correct under any UV layout — mirrored or
overlapping UVs cannot bleed a mask onto a symmetric half). The UV pass is used
only to bake a display texture.

Shapes:
- worldpos_views: list of (H, W, 3) float arrays — per-pixel world XYZ; NaN = background.
- masks_views:    dict[label -> list of (H, W) bool] — one mask per view, parallel to worldpos_views.
- uv_views:       list of (H, W, 2) float arrays — per-pixel UV; NaN = background.
- mesh:           trimesh.Trimesh (LOD0).
"""
from __future__ import annotations

import json
import os
from collections import defaultdict

import numpy as np
import trimesh


def read_exr(path):
    """Read a float EXR to (H, W, C). Uses the freeimage backend (downloaded on
    demand). Returns None if the file is missing."""
    if not os.path.exists(path):
        return None
    import imageio.v2 as iio
    try:
        return np.asarray(iio.imread(path, format="EXR-FI"), dtype=np.float32)
    except Exception:
        return np.asarray(iio.imread(path), dtype=np.float32)


def read_worldpos_exr(path):
    """Read the world-position pass; background (alpha < 0.5, when present) → NaN.
    Returns (H, W, 3) world XYZ or None if missing."""
    arr = read_exr(path)
    if arr is None:
        return None
    if arr.ndim == 2:
        arr = arr[..., None].repeat(3, axis=2)
    rgb = arr[..., :3].copy()
    if arr.shape[-1] >= 4:
        rgb[arr[..., 3] < 0.5] = np.nan
    return rgb


def read_uv_exr(path):
    """Read the UV pass to (H, W, 2), or None if missing."""
    arr = read_exr(path)
    if arr is None:
        return None
    return arr[..., :2].astype(np.float32)


def load_mesh(mesh_json_path):
    """Build a trimesh.Trimesh from a `mesh_lod0.json` ({positions, indices})."""
    with open(mesh_json_path, "r") as f:
        d = json.load(f)
    verts = np.asarray(d["positions"], dtype=float)
    idx = np.asarray(d["indices"], dtype=np.int64).reshape(-1, 3)
    return trimesh.Trimesh(vertices=verts, faces=idx, process=False)


def assign_triangles(worldpos_views, masks_views, mesh, vote_threshold: int = 1):
    """Per part: snap each masked, valid world-position pixel to its nearest mesh
    triangle, tally per-triangle votes across views, resolve faces claimed by
    more than one part via argmax, and keep faces whose winning vote count meets
    `vote_threshold`. Returns dict[label -> set[int]] of triangle indices."""
    pq = trimesh.proximity.ProximityQuery(mesh)

    votes: dict[str, dict[int, int]] = defaultdict(lambda: defaultdict(int))
    for label, view_masks in masks_views.items():
        pts = []
        for i, m in enumerate(view_masks):
            if m is None or not np.any(m):
                continue
            wp = worldpos_views[i]
            ys, xs = np.nonzero(m)
            for y, x in zip(ys, xs):
                p = wp[y, x]
                if np.any(np.isnan(p)):
                    continue
                pts.append(p)
        if not pts:
            continue
        _closest, _dist, face_ids = pq.on_surface(np.asarray(pts, dtype=float))
        for f in np.asarray(face_ids).ravel():
            votes[label][int(f)] += 1

    # Resolve cross-part conflicts: each face goes to the part with the most votes.
    face_owner: dict[int, tuple[str, int]] = {}
    for label, fv in votes.items():
        for f, c in fv.items():
            if f not in face_owner or c > face_owner[f][1]:
                face_owner[f] = (label, c)

    out: dict[str, set[int]] = defaultdict(set)
    for f, (label, c) in face_owner.items():
        if c >= vote_threshold:
            out[label].add(f)
    return dict(out)


def _dilate1(tex: np.ndarray) -> np.ndarray:
    """1px 3x3 max-dilation to close UV seams (numpy-only, no scipy)."""
    out = tex.copy()
    for dy in (-1, 0, 1):
        for dx in (-1, 0, 1):
            out = np.maximum(out, np.roll(np.roll(tex, dy, axis=0), dx, axis=1))
    return out


def bake_uv_texture(uv_views, mask_views, res: int = 512) -> np.ndarray:
    """Paint a `res x res` uint8 display mask: for each masked, valid pixel, mark
    the texel at its UV. `mask_views` are the per-view masks for ONE part."""
    tex = np.zeros((res, res), dtype=np.uint8)
    for i, m in enumerate(mask_views):
        if m is None or not np.any(m):
            continue
        uv = uv_views[i]
        if uv is None:
            continue
        ys, xs = np.nonzero(m)
        for y, x in zip(ys, xs):
            u, v = uv[y, x, 0], uv[y, x, 1]
            if np.isnan(u) or np.isnan(v):
                continue
            tu = min(res - 1, max(0, int(u * res)))
            tv = min(res - 1, max(0, int(v * res)))
            tex[tv, tu] = 255
    return _dilate1(tex)
