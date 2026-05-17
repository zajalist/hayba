import base64
import io
import os

import uvicorn
from fastapi import FastAPI, HTTPException
from PIL import Image
from pydantic import BaseModel

from .models.clip_model import get_clip
from .models.owl_vit import get_owl_vit
from .models.spatial_clip import get_spatial_clip

app = FastAPI(title="hayba-visual-sidecar", version="0.1.0")


class EmbedRequest(BaseModel):
    image_base64: str
    spatial: bool = False
    detect: bool = False
    detect_queries: list[str] | None = None


@app.get("/health")
def health():
    return {
        "ok": True,
        "models": {
            "clip": True,
            "spatial_clip": os.getenv("HAYBA_ENABLE_SPATIAL_CLIP") == "1",
            "owl_vit": os.getenv("HAYBA_ENABLE_OWL_VIT") == "1",
        },
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


def main():
    port = int(os.getenv("HAYBA_SIDECAR_PORT", "7821"))
    uvicorn.run(app, host="127.0.0.1", port=port)


if __name__ == "__main__":
    main()
