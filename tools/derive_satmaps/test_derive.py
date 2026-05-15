import numpy as np
import pytest

from derive import bin_samples, inpaint, CLUT_SIZE


def test_bin_samples_outputs_correct_shape():
    color = np.zeros((10, 10, 3), dtype=np.uint8)
    elev  = np.zeros((10, 10), dtype=np.float32)
    slope = np.zeros((10, 10), dtype=np.float32)
    mask  = np.ones((10, 10), dtype=bool)
    out = bin_samples(color, elev, slope, mask)
    assert out.shape == (CLUT_SIZE, CLUT_SIZE, 3)


def test_inpaint_fills_all_nans():
    clut = np.full((CLUT_SIZE, CLUT_SIZE, 3), np.nan, dtype=np.float32)
    clut[128, 128] = [1.0, 0.5, 0.25]
    out = inpaint(clut)
    assert not np.isnan(out).any()
