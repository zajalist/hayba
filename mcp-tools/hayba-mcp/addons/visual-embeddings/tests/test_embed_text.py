"""The text half of CLIP.

`_Clip` has held a tokenizer since it was written and nothing ever called it,
so this sidecar could answer "what does this picture look like" and never
"which of these pictures is the mossy boulder". Asset selection stayed on
filenames and descriptions with an image-text model loaded beside it.

These tests do not need the weights: what matters at this seam is that the
endpoint exists, rejects what it should reject before touching a multi-GB
model, and returns vectors in the same normalised space as /embed.
"""
import numpy as np
import pytest
from fastapi.testclient import TestClient

from hayba_sidecar.server import app

client = TestClient(app)


class _FakeClip:
    """Deterministic stand-in. Real CLIP is 1.7GB of weights; the contract is
    testable without them and the shape is what this seam promises."""

    dim = 8

    def encode_text(self, texts):
        out = np.zeros((len(texts), self.dim), dtype=np.float32)
        for i, t in enumerate(texts):
            for j, ch in enumerate(t[: self.dim]):
                out[i, j] = (ord(ch) % 17) + 1
        norms = np.linalg.norm(out, axis=-1, keepdims=True)
        norms[norms == 0] = 1.0
        return out / norms


@pytest.fixture
def fake_clip(monkeypatch):
    monkeypatch.setattr("hayba_sidecar.server.get_clip", lambda: _FakeClip())


def test_embeds_each_phrase(fake_clip):
    r = client.post("/embed_text", json={"texts": ["mossy boulder", "pine tree"]})

    assert r.status_code == 200
    body = r.json()
    assert len(body["embeddings"]) == 2
    assert body["dim"] == _FakeClip.dim


def test_vectors_come_back_normalised(fake_clip):
    r = client.post("/embed_text", json={"texts": ["a rusted iron gate"]})

    v = np.array(r.json()["embeddings"][0])
    # /embed normalises its image vectors, so a caller can use a plain dot
    # product as the cosine. If only one side were normalised the scores would
    # be quietly wrong rather than obviously broken.
    assert np.linalg.norm(v) == pytest.approx(1.0, abs=1e-5)


def test_rejects_an_empty_request_before_loading_the_model(fake_clip):
    # Loading CLIP to embed nothing costs seconds and gigabytes.
    assert client.post("/embed_text", json={"texts": []}).status_code == 400


def test_caps_the_batch(fake_clip):
    r = client.post("/embed_text", json={"texts": ["x"] * 257})

    assert r.status_code == 400
    assert "cap is 256" in r.json()["detail"]


def test_similar_phrases_score_higher_than_unrelated_ones(fake_clip):
    r = client.post("/embed_text", json={"texts": ["boulder", "bouldes", "zzzzzz"]})
    a, b, c = (np.array(v) for v in r.json()["embeddings"])

    # With the fake this is a property of the stand-in, not of CLIP. It is here
    # to prove the ENDPOINT preserves relative geometry rather than, say,
    # re-normalising each vector into uselessness.
    assert float(a @ b) > float(a @ c)
