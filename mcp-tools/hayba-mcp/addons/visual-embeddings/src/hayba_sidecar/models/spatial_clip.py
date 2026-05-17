"""Spatial CLIP loader — adapter checkpoint enables coarse depth/spatial-aware embeddings.

Set HAYBA_SPATIAL_CLIP_CHECKPOINT to the path of a .pt adapter file. If unset or
the file is missing, encode() returns a zero vector and emits a warning so callers
can degrade gracefully.
"""
import os
import warnings

import numpy as np
import torch
from PIL import Image

from .clip_model import get_clip

_adapter = None
_warned = False


class _SpatialClip:
    def __init__(self, base_clip, adapter):
        self.base = base_clip
        self.adapter = adapter  # may be None

    @torch.no_grad()
    def encode(self, img: Image.Image):
        base_vec = self.base.encode_image(img)
        if self.adapter is None:
            return np.zeros_like(base_vec)
        # Adapter is a small MLP that lifts CLIP features into a depth/spatial
        # latent. Real implementation TBD.
        return self.adapter(torch.from_numpy(base_vec)).cpu().numpy()


def get_spatial_clip():
    global _adapter, _warned
    ckpt = os.getenv("HAYBA_SPATIAL_CLIP_CHECKPOINT")
    if ckpt and os.path.exists(ckpt):
        if _adapter is None:
            _adapter = torch.load(ckpt, map_location="cpu").eval()
    elif not _warned:
        warnings.warn(
            "HAYBA_SPATIAL_CLIP_CHECKPOINT not set or missing; spatial embeddings "
            "will be zero vectors."
        )
        _warned = True
    return _SpatialClip(get_clip(), _adapter)
