# hayba-visual-sidecar

HaybaOS visual perception sidecar. Provides CLIP image embeddings (always on),
SpatialCLIP depth-aware embeddings (opt-in), and OWL-ViT open-vocabulary detection
(opt-in) for the UE editor viewport via FastAPI on `localhost:7821`.

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

## Endpoints

- `GET /health` — `{ok, models}` map
- `POST /embed` — body `{image_base64, spatial?, detect?, detect_queries?}` → `{embedding, dim, spatial_embedding?, detections?}`
- `POST /validate` — body `{image_base64, actor_bboxes}` → `{structurally_suspect}` (placeholder in v0.1)

## Verify

```
curl http://localhost:7821/health
# {"ok":true,"models":{"clip":true,"spatial_clip":false,"owl_vit":false}}
```

## Model presets (VRAM rough estimates)

| Preset | CLIP | Spatial | OWL-ViT | Total |
|---|---|---|---|---|
| Minimal | ViT-L-14 (~1 GB) | off | off | ~1 GB |
| Balanced | ViT-L-14 | on (+200 MB) | off | ~2 GB |
| Full | ViT-L-14 | on | on (+600 MB) | ~12 GB+ |
