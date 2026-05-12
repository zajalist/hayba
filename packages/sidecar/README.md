# hayba-sidecar

HTTP service the MCP server delegates vision work to (CLIP embeddings, spatial
verification for `scene_validate_physics deep_check:true`, etc.).

## Status

Skeleton. Routes return stable-shape stubs so the MCP side can be wired before
the ML stack is installed. Replace the stubs with real model calls.

## Run

```bash
cd packages/sidecar
pip install -r requirements.txt
python sidecar.py
```

Listens on `127.0.0.1:7821`. Override with `HAYBA_SIDECAR_PORT`.
MCP side discovers it via `HAYBA_SIDECAR_URL` (defaults to `http://localhost:7821`).

## Routes

| Route | Purpose | Status |
|---|---|---|
| `GET /health` | Liveness + model-loaded flag | implemented |
| `POST /embed` | CLIP / SpatialCLIP embedding | stub (zero vector) |
| `POST /validate` | Visually confirm/reject heuristic candidates | stub (passthrough) |
