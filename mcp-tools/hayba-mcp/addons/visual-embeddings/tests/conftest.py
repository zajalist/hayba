"""Shared test fixtures.

`imageio[freeimage]` installs the plugin wrapper, but the FreeImage binary
itself is downloaded on first use. On a runner with no network — or one where
the download is blocked — reading an EXR raises

    RuntimeError: `EXR-FI` can not handle the given uri

which looks exactly like a code bug and is not one. Fetch it once here, and if
that is not possible, skip the tests that genuinely need EXR with a reason
rather than letting them fail as though the projection code were broken.

Skipping is the honest option, not a convenient one: EXR reading is a real
requirement of the world-position back-projection, so a skip here means that
path is unverified on this machine and should say so.
"""
import pytest


def _exr_available() -> bool:
    try:
        import imageio.plugins.freeimage as fi
    except Exception:
        return False
    try:
        fi.download()
        return True
    except Exception:
        return False


EXR_OK = _exr_available()

requires_exr = pytest.mark.skipif(
    not EXR_OK,
    reason="FreeImage/EXR support unavailable — world-position back-projection is NOT covered here",
)
