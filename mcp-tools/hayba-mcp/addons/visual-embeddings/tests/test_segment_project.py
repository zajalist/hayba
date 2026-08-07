import json
import os

import numpy as np
import imageio.v2 as iio
from fastapi.testclient import TestClient

from hayba_sidecar import segment as segmod
from hayba_sidecar.server import app
from conftest import requires_exr


def _make_study(tmp):
    # unit quad: tri 0 = lower-right, tri 1 = upper-left
    with open(os.path.join(tmp, "mesh_lod0.json"), "w") as f:
        json.dump({"positions": [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]],
                   "indices": [0, 1, 2, 0, 2, 3]}, f)
    # one view: worldpos pass with a single valid pixel inside tri 0
    wp = np.zeros((2, 2, 4), np.float32)        # alpha 0 = background
    wp[1, 0] = [0.7, 0.2, 0.0, 1.0]             # valid point in tri 0
    iio.imwrite(os.path.join(tmp, "worldpos_v0.exr"), wp, format="EXR-FI")
    uv = np.zeros((2, 2, 3), np.float32)
    uv[1, 0] = [0.5, 0.5, 0.0]
    iio.imwrite(os.path.join(tmp, "uv_v0.exr"), uv, format="EXR-FI")
    iio.imwrite(os.path.join(tmp, "color_v0.png"), np.zeros((2, 2, 3), np.uint8))


@requires_exr
def test_segment_project(tmp_path, monkeypatch):
    tmp = str(tmp_path)
    _make_study(tmp)
    # deterministic SAM stub: mask the single valid pixel
    def stub(image, box=None, points=None):
        m = np.zeros((2, 2), bool); m[1, 0] = True; return m
    monkeypatch.setattr(segmod, "_run_sam", stub)

    c = TestClient(app)
    r = c.post("/segment_project", json={
        "study_dir": tmp,
        "parts": [{"label": "hull", "color": "#48A0FF", "views": [{"view": 0, "box": [0, 0, 1, 1]}]}],
        "vote_threshold": 1,
    })
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True
    m = body["masks"][0]
    assert m["label"] == "hull"
    assert 0 in m["triangles"] and 1 not in m["triangles"]
    assert m["texture"] and os.path.exists(m["texture"])
    assert m["coverage"] > 0


def test_segment_project_missing_dir_is_clean_error():
    c = TestClient(app)
    r = c.post("/segment_project", json={"study_dir": "/no/such/dir", "parts": []})
    assert r.status_code == 200
    assert r.json()["ok"] is False
