
import numpy as np
import trimesh
from hayba_sidecar.projection import assign_triangles, bake_uv_texture


def _quad():
    # unit quad in the z=0 plane: tri 0 = lower-right (below y=x), tri 1 = upper-left
    return trimesh.Trimesh(
        vertices=[[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0]],
        faces=[[0, 1, 2], [0, 2, 3]],
        process=False,
    )


def test_nearest_tri_voting():
    mesh = _quad()
    wp = np.full((2, 2, 3), np.nan)
    wp[1, 0] = [0.7, 0.2, 0.0]                 # inside tri 0
    masks = {'a': [np.array([[0, 0], [1, 0]], bool)]}   # only that pixel masked
    out = assign_triangles([wp], masks, mesh, vote_threshold=1)
    assert 0 in out['a'] and 1 not in out['a']


def test_threshold_rejects_single_view_noise():
    mesh = _quad()
    wp = np.full((2, 2, 3), np.nan)
    wp[1, 0] = [0.7, 0.2, 0.0]
    masks = {'a': [np.array([[0, 0], [1, 0]], bool)]}
    # one vote, threshold 2 → rejected
    out = assign_triangles([wp], masks, mesh, vote_threshold=2)
    assert out.get('a', set()) == set()


def test_cross_part_argmax():
    mesh = _quad()
    # two views both hitting tri 0; part 'a' votes twice, part 'b' once → tri 0 → 'a'
    wpA = np.full((2, 2, 3), np.nan); wpA[1, 0] = [0.7, 0.2, 0.0]
    wpB = np.full((2, 2, 3), np.nan); wpB[1, 0] = [0.8, 0.1, 0.0]
    masks = {
        'a': [np.array([[0, 0], [1, 0]], bool), np.array([[0, 0], [1, 0]], bool)],
        'b': [np.array([[0, 0], [1, 0]], bool), np.zeros((2, 2), bool)],
    }
    out = assign_triangles([wpA, wpB], masks, mesh, vote_threshold=1)
    assert 0 in out['a']
    assert 0 not in out.get('b', set())        # lost the argmax for tri 0


def test_bake_centre_texel():
    uv = np.full((2, 2, 2), np.nan)
    uv[0, 0] = [0.5, 0.5]
    masks = [np.array([[1, 0], [0, 0]], bool)]
    tex = bake_uv_texture([uv], masks, res=4)
    assert tex[2, 2] == 255                     # v*res=2, u*res=2
    assert tex.shape == (4, 4)
