
from fastapi.testclient import TestClient
from hayba_sidecar.server import app


def test_health():
    c = TestClient(app)
    r = c.get('/health')
    assert r.status_code == 200
    body = r.json()
    assert body['ok'] is True
    # SAM is lazy — not loaded until the first segment call
    assert body['model_loaded'] is False
