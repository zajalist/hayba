# hayba-visual-sidecar

The Hayba visual perception sidecar — **one** FastAPI process on
`localhost:7821`. It serves CLIP image embeddings (always on), SpatialCLIP
depth-aware embeddings (opt-in), OWL-ViT open-vocabulary detection (opt-in), and
SAM segmentation with world-position back-projection for the PLUMB Semantic
Studio.

> There used to be a second sidecar at `mcp-tools/visual-sidecar/`, also titled
> `hayba-visual-sidecar`, also defaulting to port 7821, serving
> `/segment_project` where this one served `/embed`. The single Node adapter
> (`src/tools/visual/sidecar-client.ts`) calls across both, so whichever process
> you started, half the client was broken. They are merged here. If you are
> adding an endpoint, add it to this app — `tests/test_client_contract.py`
> asserts that everything the client calls is actually served.

## Install

GPU (CUDA, recommended):
```
uv sync --extra gpu
```

CPU only:
```
uv sync --extra cpu
```

Add OWL-ViT:
```
uv sync --extra cpu --extra owlvit
```

## Run

```
uv run hayba-visual-sidecar
```

Environment variables:

| Var | Default | Purpose |
|---|---|---|
| `HAYBA_SIDECAR_PORT` | `7821` | TCP port |
| `HAYBA_ENABLE_SPATIAL_CLIP` | unset | Set `1` to enable spatial endpoint |
| `HAYBA_ENABLE_OWL_VIT` | unset | Set `1` to enable detection endpoint |
| `HAYBA_SPATIAL_CLIP_CHECKPOINT` | unset | Path to spatial adapter `.pt` |
| `HAYBA_SAM_CACHE` | `~/.cache/hayba-sam` | Where SAM weights are looked up |
| `HAYBA_SAM_CHECKPOINT` | `<cache>/sam_vit_b_01ec64.pth` | Explicit checkpoint path |
| `HAYBA_SAM_MODEL` | `vit_b` | SAM model type |

## Endpoints

- `GET /health` — `{ok, models, model_loaded}`. The client derives availability
  from a non-empty `models` map, so every capability must appear in it.
- `POST /embed` — body `{image_base64, spatial?, detect?, detect_queries?}` → `{embedding, dim, spatial_embedding?, detections?}`
- `POST /segment_project` — body `{study_dir, parts:[{label,color,views:[{view,box|points}]}], vote_threshold?}`
  → `{ok, masks:[{label,texture,triangles,color,coverage}], skipped}`. Errors return
  `{ok:false, error}` rather than raising — the caller is an agent that needs to
  read the reason.
- `POST /validate` — body `{image_base64, actor_bboxes}` → `{structurally_suspect}` (placeholder in v0.1)

SAM weights are **lazy-loaded** on the first `/segment_project` call, so the
process starts without them. `models.sam` reports whether segmentation *could*
run (import resolves + checkpoint on disk); `model_loaded` reports whether it has
been warmed up.

## Verify

```
curl http://localhost:7821/health
# {"ok":true,"models":{"clip":true,"spatial_clip":false,"owl_vit":false,"sam":false},"model_loaded":false}
```

## Test

```
uv sync --extra cpu --extra test
uv run pytest
```

## Model presets (VRAM rough estimates)

| Preset | CLIP | Spatial | OWL-ViT | Total |
|---|---|---|---|---|
| Minimal | ViT-L-14 (~1 GB) | off | off | ~1 GB |
| Balanced | ViT-L-14 | on (+200 MB) | off | ~2 GB |
| Full | ViT-L-14 | on | on (+600 MB) | ~12 GB+ |
