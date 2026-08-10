# Getting started — Visual Sidecar

Sibling of [`docs/getting-started.md`](getting-started.md). Covers Tier 2 in
more depth: what the sidecar is, how to install it for GPU vs. CPU, and how
the "model preset" and per-capability toggles actually work.

## What it is

One FastAPI process, source at
[`mcp-tools/hayba-mcp/addons/visual-embeddings`](../mcp-tools/hayba-mcp/addons/visual-embeddings),
listening on `localhost:7821` by default. It serves CLIP image embeddings
(always on), SpatialCLIP depth-aware embeddings (opt-in), OWL-ViT
open-vocabulary detection (opt-in), and SAM segmentation with world-position
back-projection for the PLUMB Semantic Studio. Source:
[`addons/visual-embeddings/README.md`](../mcp-tools/hayba-mcp/addons/visual-embeddings/README.md).

There used to be a second, differently-scoped sidecar at
`mcp-tools/visual-sidecar/`, also on port 7821. It was merged into this one —
see [ADR-0006](adr/0006-one-visual-sidecar.md). If you find docs or scripts
referencing the old path, they're stale; this is the only sidecar now.

The UE plugin does **not** launch this process for you. You start it by hand
(see Run, below); the plugin only calls into it once it's listening.

## Install

From `mcp-tools/hayba-mcp/addons/visual-embeddings`:

```bash
# GPU (CUDA, recommended)
uv sync --extra gpu

# CPU only
uv sync --extra cpu

# Add OWL-ViT detection to either
uv sync --extra cpu --extra owlvit
```

The `gpu` and `cpu` extras both pull `torch>=2.3`; the difference is which
CUDA/CPU wheel `uv` resolves. This choice is made once, at install time — it
is **not** the same thing as the in-editor "Model Preset" described below,
which only decides which already-installed capabilities are turned on and
never changes what got installed.

Base dependencies (`fastapi`, `uvicorn`, `pillow`, `numpy`, `trimesh`,
`rtree`, `scipy`, `imageio[freeimage]`) are deliberately torch-free — every
model loader imports its heavy dependency inside the function that needs it,
so the process starts, and `/health` answers honestly, even with zero model
weights installed. Source: `pyproject.toml` header comment.

## Run

```bash
uv run hayba-visual-sidecar
```

Environment variables (from the addon's README):

| Var | Default | Purpose |
|---|---|---|
| `HAYBA_SIDECAR_PORT` | `7821` | TCP port |
| `HAYBA_ENABLE_SPATIAL_CLIP` | unset | Set `1` to enable the spatial endpoint |
| `HAYBA_ENABLE_OWL_VIT` | unset | Set `1` to enable the detection endpoint |
| `HAYBA_SPATIAL_CLIP_CHECKPOINT` | unset | Path to the spatial adapter `.pt` |
| `HAYBA_SAM_CACHE` | `~/.cache/hayba-sam` | Where SAM weights are looked up |
| `HAYBA_SAM_CHECKPOINT` | `<cache>/sam_vit_b_01ec64.pth` | Explicit checkpoint path |
| `HAYBA_SAM_MODEL` | `vit_b` | SAM model type |

SAM weights are lazy-loaded on the first `/segment_project` call; `models.sam`
in `/health` reports whether segmentation *could* run (import resolves +
checkpoint on disk), `model_loaded` reports whether it has actually been
warmed up.

Verify it's alive:

```bash
curl http://localhost:7821/health
# {"ok":true,"models":{"clip":true,"spatial_clip":false,"owl_vit":false,"sam":false},"model_loaded":false}
```

## Profile selection

There are two separate, only loosely connected knobs. Neither one installs
anything or starts the process for you.

### 1. UE Project Settings → Plugins → Hayba MCP Toolkit → Visual Sidecar

This is `UHaybaMCPDeveloperSettings`, source
[`unreal/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/HaybaMCPDeveloperSettings.h`](../unreal/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/HaybaMCPDeveloperSettings.h).
It exposes:

- `ModelPreset` — enum `Minimal` / `Balanced` / `Full` (default `Minimal`).
- `bEnableSpatialCLIP`, `bEnableOWLViT` — bool toggles.
- `bEnableContinuousCapture` — bool, streams the viewport to the sidecar
  continuously. Default off; the plugin's own tooltip warns it causes
  "ongoing GPU load."
- `VRAMEstimate` — a read-only computed string, e.g. `"~2000 MB VRAM"`.

Changing any of these recomputes `VRAMEstimate` via
`RecomputeVRAMEstimate()` (`HaybaMCPDeveloperSettings.cpp`):

| Preset | Base | + SpatialCLIP | + OWL-ViT |
|---|---|---|---|
| Minimal | 1000 MB | +200 MB | +600 MB |
| Balanced | 2000 MB | +200 MB | +600 MB |
| Full | 12000 MB | +200 MB | +600 MB |

This matches the "Model presets" table in the addon's README (Minimal ≈1 GB
CLIP-only, Balanced ≈2 GB with SpatialCLIP, Full ≈12 GB+ with OWL-ViT too).

**Important:** this panel is a display/estimate only. It does not install
extras, does not set environment variables on the Python process, and does
not start or stop it. It exists so you can see the VRAM cost of a
configuration before you commit to running it.

### 2. What actually turns a capability on

Per the toggle tooltips in
[`HaybaMCPSettingsPanel.cpp`](../unreal/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/HaybaMCPSettingsPanel.cpp):

> "Requires the sidecar to be started with `HAYBA_ENABLE_SPATIAL_CLIP=1`."
> "Requires the sidecar to be started with `HAYBA_ENABLE_OWL_VIT=1`."

So to actually get SpatialCLIP or OWL-ViT, you need both: the corresponding
`uv sync --extra ...` at install time, and the matching environment variable
set when you run `uv run hayba-visual-sidecar`. The Project Settings toggles
tell the *client* which calls to attempt; they don't configure the *server*.

The toolbar Settings panel (a different UI from Project Settings) also has a
plain "Sidecar URL" field, defaulting to `http://localhost:7821`, for pointing
the plugin at a sidecar running somewhere other than localhost.

## Test

```bash
uv sync --extra cpu --extra test
uv run pytest
```

## Caution

Continuous capture mode causes ongoing GPU load — leave it off unless you're
actively iterating on it.
