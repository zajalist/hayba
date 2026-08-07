import base64
import io
import os

import uvicorn
from fastapi import FastAPI, HTTPException
from PIL import Image
from pydantic import BaseModel

from .models.clip_model import available as clip_available, get_clip
from .models.owl_vit import get_owl_vit
from .models.spatial_clip import get_spatial_clip
from .segment import sam_available, sam_loaded, segment_project as run_segment_project

app = FastAPI(title="hayba-visual-sidecar", version="0.1.0")


class EmbedRequest(BaseModel):
    image_base64: str
    spatial: bool = False
    detect: bool = False
    detect_queries: list[str] | None = None


@app.get("/health")
def health():
    """The client derives `available` from a non-empty `models` map, so every
    capability this process serves must appear here. The second sidecar returned
    `{ok, model_loaded}` with no `models` key at all, which made the client
    report the sidecar *unavailable* while it was running and healthy."""
    return {
        "ok": True,
        "models": {
            # Capability, not warm-up state: the import resolves and any weights
            # needed are on disk. "clip: true" used to be hardcoded, which meant
            # /health claimed CLIP on a process that could not import it.
            "clip": clip_available(),
            "spatial_clip": os.getenv("HAYBA_ENABLE_SPATIAL_CLIP") == "1" and clip_available(),
            "owl_vit": os.getenv("HAYBA_ENABLE_OWL_VIT") == "1",
            "sam": sam_available(),
        },
        # Warm-up state, not capability. Kept for parity with the old
        # segmentation sidecar's /health, which reported only this.
        "model_loaded": sam_loaded(),
    }


@app.post("/embed")
def embed(req: EmbedRequest):
    try:
        img = Image.open(io.BytesIO(base64.b64decode(req.image_base64))).convert("RGB")
    except Exception as e:
        raise HTTPException(400, f"bad image: {e}")

    clip = get_clip()
    vec = clip.encode_image(img).tolist()
    out: dict = {"embedding": vec, "dim": len(vec)}

    if req.spatial and os.getenv("HAYBA_ENABLE_SPATIAL_CLIP") == "1":
        spatial = get_spatial_clip()
        out["spatial_embedding"] = spatial.encode(img).tolist()

    if req.detect and os.getenv("HAYBA_ENABLE_OWL_VIT") == "1":
        owl = get_owl_vit()
        queries = req.detect_queries or ["building", "tree", "rock", "character", "vehicle"]
        out["detections"] = owl.detect(img, queries)

    return out


class ValidateRequest(BaseModel):
    image_base64: str
    actor_bboxes: list[dict]


@app.post("/validate")
def validate(req: ValidateRequest):
    """Placeholder for VLM-based structural validation.

    v0.1 returns an empty suspect list. Future versions will call a multimodal LLM
    to flag structurally-suspect geometry (floating actors, interpenetration that
    overlap-tests miss, scale mismatches, etc.).
    """
    return {"structurally_suspect": [], "version": "0.1-placeholder"}


@app.post("/segment_project")
def segment_project(req: dict):
    """SAM-segment agent-grounded boxes, back-project to triangles via the
    world-position pass, and bake a UV display texture. Never throws — errors
    come back as {ok:false}, because the caller is an agent that needs to read
    the reason, not a stack trace."""
    return run_segment_project(req)


def main():
    port = int(os.getenv("HAYBA_SIDECAR_PORT", "7821"))
    uvicorn.run(app, host="127.0.0.1", port=port)


if __name__ == "__main__":
    main()
