"""The seam between this sidecar and its one Node adapter.

There used to be two FastAPI apps, both titled "hayba-visual-sidecar", both
defaulting to port 7821, serving disjoint endpoints:

    mcp-tools/visual-sidecar          /health  /segment_project
    addons/visual-embeddings          /health  /embed  /validate

`src/tools/visual/sidecar-client.ts` calls all three of /health, /embed and
/segment_project against a single base URL. So whichever process was running,
half the client was broken — and because the client derives `available` from
/health's `models` map, which the segmentation app did not return, running the
segmentation sidecar made the client report the sidecar *unavailable*.

Nothing caught it because the contract lived only in hand-mirrored TypeScript
interfaces. These tests are that contract, on this side of the seam.
"""
from fastapi.testclient import TestClient

from hayba_sidecar.server import app

client = TestClient(app)

# Every path sidecar-client.ts issues a request to. Keep in step with that file.
CLIENT_ENDPOINTS = {
    ("GET", "/health"),
    ("POST", "/embed"),
    ("POST", "/segment_project"),
}


def test_every_endpoint_the_client_calls_is_served():
    served = {
        (method, route.path)
        for route in app.routes
        for method in getattr(route, "methods", set())
    }
    missing = CLIENT_ENDPOINTS - served
    assert not missing, (
        f"sidecar-client.ts calls these, but this app does not serve them: {sorted(missing)}. "
        "A split sidecar is how the 7821 collision happened; do not reintroduce it."
    )


def test_health_reports_a_models_map():
    """The client computes `available = ok !== false && active_models.length > 0`.
    A /health without a `models` key therefore reads as unavailable, however
    healthy the process actually is."""
    body = client.get("/health").json()
    assert body.get("ok") is True
    assert isinstance(body.get("models"), dict), "/health must carry a models map"
    assert body["models"], "/health models map must not be empty"
    # Every capability this process can serve is declared, including SAM — whose
    # absence from the old /health is the specific bug this pins.
    assert "sam" in body["models"]
    assert "clip" in body["models"]
