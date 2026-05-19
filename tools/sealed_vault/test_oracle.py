from tools.sealed_vault.invariant import assert_solvable, SolvabilityError


def _solvable_fixture():
    # rooms 0..3; entrance=0 boss=3. edge (2,3) locked by key 1, key in room 1.
    return dict(
        rooms=[0, 1, 2, 3], entrance=0, boss=3,
        edges=[(0, 1, -1), (1, 2, -1), (2, 3, 1)],   # (u, v, lock_id)
        rank={0: 0, 1: 1, 2: 2, 3: 3},
        keys={1: 1},                                  # key_id -> room
    )


def _unsolvable_fixture():
    f = _solvable_fixture()
    f["keys"] = {1: 3}    # key sealed in the boss room behind its own lock
    return f


def test_solvable_passes():
    assert assert_solvable(_solvable_fixture()) is None


def test_unsolvable_raises():
    import pytest
    with pytest.raises(SolvabilityError):
        assert_solvable(_unsolvable_fixture())
