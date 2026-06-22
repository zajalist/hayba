# Hayba visual sidecar

Python/FastAPI service (`:7821`) that turns agent-grounded boxes into
geometry-hugging masks for the PLUMB Semantic Studio.

- **SAM only** — the agent (Claude via MCP) proposes part labels + a box/points
  per part per view; SAM refines those into precise per-view masks.
- **World-position back-projection** — masked pixels are read against the UE
  `worldpos_v*.exr` pass and snapped to LOD0 triangles via a BVH (3D-correct,
  mirrored-UV-safe). The `uv_v*.exr` pass bakes a display-only texture.

## Run

```powershell
./run.ps1          # uvicorn app:app --port 7821
```

`GET /health` → `{ ok, model_loaded }`. SAM weights are **lazy-loaded** on the
first `/segment_project` call; the process starts without them.

## Endpoints

- `GET /health` — liveness + whether SAM is loaded.
- `POST /segment_project` — `{ study_dir, parts:[{label,color,views:[{view,box|points}]}], vote_threshold? }`
  → `{ masks:[{label,texture,triangles,color,coverage}] }`. Errors → `{ ok:false, error }`.

## Config (env)

- `HAYBA_SAM_CACHE` — weights cache dir (default `~/.cache/hayba-sam`).
- `HAYBA_SAM_CHECKPOINT` — explicit checkpoint path.
- `HAYBA_SAM_MODEL` — registry key (default `vit_b`).

## Tests

```bash
python -m pytest -q          # health + projection (no heavy models needed)
```

`segment-anything` + `torch` are only imported at segmentation runtime, so the
unit tests run without them.
