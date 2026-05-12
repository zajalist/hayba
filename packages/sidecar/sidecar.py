"""
Hayba visual sidecar — HTTP service the MCP server delegates vision work to.

Skeleton only. Routes return stub responses so the rest of the stack can wire
up against them without depending on the heavy ML stack being installed yet.
Replace the stubs with real CLIP / SpatialCLIP / detector calls when ready.

Run: uvicorn sidecar:app --host 127.0.0.1 --port 7821
Env: HAYBA_SIDECAR_URL on the MCP side defaults to http://localhost:7821.
"""

from __future__ import annotations

import base64
import os
from typing import Any

from fastapi import FastAPI
from pydantic import BaseModel

app = FastAPI(title="hayba-sidecar", version="0.1.0")

# ── models ───────────────────────────────────────────────────────────────────

class EmbedRequest(BaseModel):
    image_base64: str
    spatial: bool = False
    detect: bool = False

class EmbedResponse(BaseModel):
    embedding: list[float]
    dim: int

class ValidateRequest(BaseModel):
    image_base64: str
    # Caller supplies the heuristic candidates; the sidecar's job is to
    # confirm / deny visually rather than guess on its own.
    candidates: list[dict[str, Any]] = []

class ValidateResponse(BaseModel):
    confirmed: list[dict[str, Any]]
    rejected: list[dict[str, Any]]

# ── routes ───────────────────────────────────────────────────────────────────

@app.get("/health")
def health() -> dict[str, Any]:
    return {
        "ok": True,
        "service": "hayba-sidecar",
        "version": "0.1.0",
        "model_loaded": False,  # TODO: flip once a real model is wired
    }

@app.post("/embed", response_model=EmbedResponse)
def embed(req: EmbedRequest) -> EmbedResponse:
    # TODO: load OpenCLIP / SpatialCLIP and embed the decoded image.
    # For now: return a zero vector of the expected dim so callers can stub
    # against a stable shape without crashing.
    _ = base64.b64decode(req.image_base64 or "", validate=False)
    dim = 512 if not req.spatial else 768
    return EmbedResponse(embedding=[0.0] * dim, dim=dim)

@app.post("/validate", response_model=ValidateResponse)
def validate(req: ValidateRequest) -> ValidateResponse:
    # TODO: run a detector + spatial CLIP confirmation on each candidate.
    # Skeleton just passes everything through as "confirmed" so scene_validate_physics
    # deep_check:true is a no-op upgrade rather than a degradation.
    return ValidateResponse(confirmed=req.candidates, rejected=[])

# ── entrypoint ───────────────────────────────────────────────────────────────

if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("HAYBA_SIDECAR_PORT", "7821"))
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="info")
