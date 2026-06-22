import sys, os
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from fastapi.testclient import TestClient
from app import app


def test_health():
    c = TestClient(app)
    r = c.get('/health')
    assert r.status_code == 200
    body = r.json()
    assert body['ok'] is True
    # SAM is lazy — not loaded until the first segment call
    assert body['model_loaded'] is False
