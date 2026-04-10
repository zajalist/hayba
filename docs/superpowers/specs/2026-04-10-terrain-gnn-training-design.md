# Terrain GNN Training System Design

**Date:** 2026-04-10
**Status:** Approved for Implementation

## Overview

A new standalone Python repository (`terrain-gnn`) that trains a multimodal Graph Neural Network to understand Gaea terrain graphs. The model learns the relationship between graph topology, node parameters, and the visual 2D heightmap produced at each stage of the graph. Once trained, it serves as an inference server that Hayba's DSPy pipeline calls to generate optimized graph+parameter plans given a terrain intent.

The Hayba side simplifies to a DSPy pipeline: natural language → structured intent features → HTTP call to the GNN inference server → graph JSON returned.

---

## Problem Statement

The current brainstorm tool builds graphs by RAG-matching archetype descriptions. Parameters are heuristic guesses — not grounded in what those params actually produce visually. The result is graphs that are structurally plausible but visually mediocre compared to expert-crafted terrains like the Kyrgyz Valley Tutorial.

The GNN solves this by training on the actual visual output of each node at each parameter value. It learns:
- What each node type does visually
- How parameter values affect the heightmap shape
- How nodes interact — Erosion2 downstream of Mountain at these params produces these cliff patterns
- What real alpine/volcanic/desert terrain looks like vs what Gaea produces

---

## Repository Structure

```
terrain-gnn/
  data/
    raw/                   # generated samples (graph + per-node stage tensors)
    labeled/               # symlink or copy after labeling
    processed/             # tensorized .pt files for training
    real_dems/             # real-world DEM tiles (GeoTIFF → normalized PNG)
  src/
    models/
      cnn_encoder.py       # ResNet-18 backbone, 6-channel input, 512-dim output
      gnn_encoder.py       # GAT over graph topology + node params
      attention.py         # cross-attention: graph node vectors ↔ stage embeddings
      node_delta_mlp.py    # per-node-type MLP predicting expected visual delta
      terrain_model.py     # full model assembly + forward pass
    data/
      generator.py         # talks to Gaea via SwarmHost HTTP, cooks stage-by-stage
      dem_downloader.py    # downloads + tiles real DEMs from USGS/Copernicus
      processor.py         # raw .npz + graph JSON → tensorized training examples
      augmentation.py      # Gaea-native augmentation: slope/height masks per stage
    labeling/
      server.py            # FastAPI labeling UI server
      static/
        index.html         # labeling interface
        app.js             # filmstrip + graph viz + label submission
    training/
      train.py             # full training loop with phase scheduling
      evaluate.py          # metrics: use-case F1, quality MAE, delta cosine sim
      losses.py            # FocalLoss, SmoothL1, InfoNCE, L_delta, L_gradient
    inference/
      server.py            # FastAPI inference server (called by Hayba DSPy)
      export.py            # exports trained model to ONNX
  scripts/
    generate_data.py       # CLI: generate N variants for an archetype
    label_data.py          # CLI: launches labeling UI at localhost:8765
    train.py               # CLI: runs full training pipeline
    serve.py               # CLI: starts inference server at localhost:8766
  requirements.txt
  README.md
```

---

## 1. Training Data

### Sample Structure

Each sample is one cooked terrain graph stored as:

```
data/raw/<sample-id>/
  meta.json              # { type: "generated"|"real", intent, source, archetype }
  graph.json             # nodes (type + params) + edges — generated samples only
  stage_00_<node>.npz    # 512×512×6 float32 tensor
  stage_01_<node>.npz
  ...
  stage_N_final.npz
  color.jpg              # final color export (for labeling UI display only)
  label.json             # written during labeling: { use_cases[], quality, notes, reference_file? }
```

### Per-Stage Tensor Format: 512×512×6

Fixed 6 channels at every node stage. Missing channels are zero-padded:

| Channel | Source | Always present? |
|---------|--------|-----------------|
| 0 | Heightmap (normalized 0-1) | Yes |
| 1 | Slope magnitude (∇height via numpy.gradient) | Yes — derived |
| 2 | Curvature (second derivative) | Yes — derived |
| 3 | Wear | Only from Erosion2, ThermalShaper output ports |
| 4 | Deposits | Only from Erosion2 output port |
| 5 | Flow | Only from Erosion2, FlowMap output ports |

Channels 1 and 2 are always computable from channel 0 — no extra Gaea export needed. Channels 3-5 are exported from Gaea's output ports when the node provides them, zeroed otherwise.

**Scope:** Shape only. No texture/color nodes (SatMap, ColorErosion, SuperColor) in training graphs for this phase. Color export is only for the labeling UI.

### Real DEM Samples

Real-world heightmap tiles sourced from USGS 3DEP, Copernicus DEM 30m, and NASA SRTM. Used at ~5-10% of total training volume.

- Downloaded as GeoTIFF, cropped to 512×512 tiles, normalized 0-1
- Channels 1+2 (slope, curvature) derived via numpy; channels 3-5 zeroed
- One stage only (the DEM itself) — no graph, no stage sequence
- Labeled with biome use-case tags only, no quality score
- Used for CNN pretraining and contrastive loss alignment

### Data Generation Pipeline

`generator.py` talks to Gaea's SwarmHost HTTP API (already running as part of Hayba):

```
For each archetype × N param mutations:
  1. Build graph JSON — mutate params ±30% from archetype defaults
     Mutation types: param perturbation, node swap, node addition, seed variation
  2. Load graph into Gaea via SwarmHost POST /graph/load
  3. For each node in topological order:
     a. Cook up to this node (SwarmHost partial cook)
     b. Export heightmap PNG → compute slope + curvature in Python
     c. If node outputs Wear/Deposits/Flow → export those ports via SwarmHost
     d. Stack all 6 channels into 512×512×6 float32 .npz
  4. Export final color.jpg (for labeling UI)
  5. Write meta.json + graph.json to data/raw/<sample-id>/
```

**Volume targets:**

| Source | Samples | When |
|--------|---------|------|
| 16 existing .terrain files (parsed) | ~160 stage sequences | Immediate — bootstrap |
| 10 variants × 30 archetypes | 300 generated samples | First run |
| Each labeling session | +N labeled samples | Ongoing |
| Real DEMs | 200-500 tiles | One-time download |

GNN activates when labeled good-quality set reaches **100 samples**. Below that, Hayba falls back to archetype RAG.

### Gaea-Native Augmentation

At each stage, Gaea can export additional mask views via its output ports. These are not data augmentation in the synthetic sense — they are physically meaningful derivatives of the terrain shape:

- Slope node output → additional slope mask view
- Height node output → altitude band mask
- Curvature node output → convex/concave classification

These are optionally appended as extra channels beyond the base 6 if present, expanding the tensor depth. The model architecture uses a configurable `in_channels` parameter to accommodate variable depth (default 6, extended when Gaea produces extras).

---

## 2. Model Architecture

### Overview

```
Input:
  ├── Graph: node_type_embeddings + param_vectors + adjacency matrix
  └── Stage sequence: [stage_0 ... stage_N]  (each 512×512×C, C≥6)

                    ┌─────────────────────┐
Stage sequence ───► │   CNN Encoder        │ ─► [N × 512] stage embeddings
(shared weights)    │   ResNet-18 backbone │
                    │   6-channel input    │
                    └─────────────────────┘
                              │
                    ┌─────────▼───────────┐
Graph ────────────► │   GNN Encoder        │ ─► [N × 256] node embeddings
                    │   GAT, 3 layers      │       + [256] global graph embedding
                    └─────────────────────┘
                              │
                    ┌─────────▼───────────┐
                    │   Cross-Attention    │ ─► [N × 256] fused node embeddings
                    │   Q: node vectors    │    (each node knows its visual output)
                    │   K/V: stage embeds  │
                    └─────────────────────┘
                              │
              ┌───────────────┼──────────────────┐
              ▼               ▼                  ▼
     Use-case head      Quality head       (future)
     Multi-label        Scalar 0-1         Param optimizer
     sigmoid            regression         per-node MLP
```

### CNN Encoder

- Backbone: ResNet-18 pretrained on ImageNet, first conv layer replaced to accept C input channels (C≥6)
- Input: 512×512×C → Output: 512-dim embedding vector per stage
- Shared weights across all stages — the same encoder processes every node's heightmap
- Pretrained in Phase 1 on real DEMs with a lightweight reconstruction decoder (decoder discarded after pretraining)

### GNN Encoder (Graph Attention Network)

- 3 GAT layers with multi-head attention (4 heads)
- Node input features: `[type_embedding(64) | normalized_params(32) | depth_in_graph(1)]` → 97-dim
- Edge features: `[port_type_onehot(8)]` (In/Mask/Reference/SnowMap/etc.)
- Output: per-node 256-dim vectors + global mean-pool 256-dim graph embedding

### Cross-Attention

- Query: GNN node vectors `[N × 256]`
- Key/Value: CNN stage embeddings `[N × 512]`
- Node-to-stage alignment: each node attends to its own visual output and its neighbors'
- Output: fused `[N × 256]` — each node representation is grounded in what it looked like

### Node Delta MLP

One small MLP per node type family. Families map Gaea node categories to reduce the number of MLP heads:
- **primitives**: Mountain, Ridge, Perlin, MultiFractal, Voronoi, Range, MountainSide
- **erosion**: Erosion2, EasyErosion, ThermalShaper, Thermal2
- **weather**: Snow, Snowfield, Glacier, Weathering
- **filter**: Height, Slope, Adjust, Blur, Clamp, Roughen, Deflate, Fold, Curvature, Invert, Autolevel
- **transform**: Combine, Transform
- **data**: SatMap, TextureBase, ColorErosion, FlowMap, SuperColor, GroundTexture

```
Input:  [node_type_embedding(64) | normalized_params(32)]
Output: predicted_visual_delta in CNN embedding space (512-dim)
```

Used in L_delta training loss and during inference for parameter optimization without cooking.

---

## 3. Loss Functions

```
L_total = L_cls + λ₁·L_quality + λ₂·L_contrastive + λ₃·L_delta
```

Default λ values: λ₁=1.0, λ₂=0.5, λ₃=2.0

### L_cls — Use-case Classification
```
L_cls = FocalLoss(σ(predicted_tags), true_tags)
```
Focal Loss with γ=2 handles class imbalance across biome tags (alpine over-represented early on).

### L_quality — Quality Regression
```
L_quality = SmoothL1(predicted_quality, true_quality)
```
Labels: Bad=0.0, Interesting=0.5, Good=1.0. SmoothL1 tolerates label noise from subjective judgements.

### L_contrastive — Real DEM Alignment (InfoNCE)
```
L_contrastive = InfoNCE(
    anchor:    CNN_embed(generated_final_stage),
    positives: CNN_embed(real_DEM, same_biome),
    negatives: CNN_embed(real_DEM, different_biome)
)
```
Pulls generated terrain embeddings toward real DEMs of the same biome. Anchors the model's quality intuition to geological reality, not just inter-Gaea comparisons.

### L_delta — Stage Delta Loss
```
For each consecutive stage pair (stage_i → stage_{i+1}):
  observed_delta  = CNN_embed(stage_{i+1}) - CNN_embed(stage_i)
  predicted_delta = NodeDeltaMLP(node_type_embedding, normalized_params)
  L_delta = Σᵢ || observed_delta - predicted_delta ||²
```
Forces the model to learn what each individual node does visually as a function of its parameters. Enables inference-time parameter optimization: NodeDeltaMLP runs forward on candidate params without cooking to predict the visual effect.

### L_gradient — CNN Pretraining Regularization (Phase 1 only)
```
L_gradient = || ∇(heightmap) - ∇(decoded_heightmap) ||²
```
Applied during CNN pretraining on real DEMs. A lightweight decoder reconstructs the heightmap from its embedding, penalized on gradient (slope) error rather than pixel error. Forces embeddings to preserve terrain slope structure. Decoder is discarded after Phase 1.

---

## 4. Training Schedule

### Phase 1 — CNN Pretraining
- **Data:** Real DEM tiles only (~200-500 samples)
- **Loss:** L_gradient (reconstruction)
- **Goal:** Encoder learns geologically meaningful heightmap feature representations
- **Duration:** ~50 epochs
- **Labels required:** None — self-supervised

### Phase 2 — Joint Training
- **Data:** All generated samples with quality labels
- **Loss:** L_cls + λ₁·L_quality + λ₂·L_contrastive + λ₃·L_delta
- **Goal:** Full model learns use-case, quality prediction, and per-node visual effects
- **Triggers:** When labeled set ≥ 100 good samples
- **Duration:** ~200 epochs with early stopping on validation quality MAE

### Phase 3 — Fine-tuning
- **Data:** Labeled set only (your reviewed samples, high confidence)
- **Loss:** L_cls + L_quality
- **Goal:** Align predictions with your specific quality preferences
- **Triggers:** Manually, after significant new labeled batches

---

## 5. Labeling UI

Launched via `python scripts/label_data.py` → opens `http://localhost:8765`

### Layout

```
┌─────────────────────────────────────────────────────────────────┐
│  Sample 14/300  [alpine-v03]  Archetype: Snowy Alpine Peaks     │
│                                              [ Skip ] [ Back ]  │
├──────────────────────────┬──────────────────────────────────────┤
│                          │  Node Graph (reproduced)             │
│   color.jpg              │                                      │
│   (final render)         │  Mountain → Perlin → Combine         │
│                          │  → Erosion2 → ThermalShaper          │
│   512×512 display        │  → Glacier → Autolevel               │
│                          │  → Snowfield → Unreal                │
│                          │                                      │
│                          │  [click node to highlight filmstrip] │
├──────────────────────────┴──────────────────────────────────────┤
│  Stage filmstrip (horizontal scroll, click to enlarge):         │
│  [Mountain] [Combine] [Erosion2] [ThermalShaper] [Glacier] ...  │
│  stage_0     stage_2   stage_3    stage_4         stage_5       │
├─────────────────────────────────────────────────────────────────┤
│  Use cases (multi-select):                                      │
│  [alpine✓] [snow✓] [glacial] [volcanic] [desert] [forest] ...  │
│                                                                 │
│  Quality:  ● Bad   ○ Interesting   ○ Good                       │
│                                                                 │
│  Notes:    [what went wrong / right __________________ ]        │
│                                                                 │
│  Reference .terrain:  [ Attach file ]  kyrgyz-valley.terrain   │
│                                                                 │
│  [ Submit & Next → ]                                            │
└─────────────────────────────────────────────────────────────────┘
```

### Reference File Processing

When you attach a `.terrain` file alongside a label:

1. **Parse** — extract full graph (nodes + params + edges) using the existing `.terrain` parser
2. **Enrich archetype** — merge node params and reasoning into the matched archetype in `archetypes.json`
3. **Store as gold standard** — save parsed graph to `data/labeled/<sample-id>/reference_graph.json`
4. **Add to training set** — the reference graph + its intermediate stages (generated on demand) become additional high-quality training examples

### Label Storage

`label.json` written on submit:
```json
{
  "use_cases": ["alpine", "snow"],
  "quality": 0.0,
  "notes": "Ridges too round — erosion duration too high",
  "reference_file": "C:/Users/.../Kyrgyz Valley Tutorial.terrain",
  "labeled_at": "2026-04-10T20:00:00Z"
}
```

---

## 6. Bad Pattern Gate (Hayba Integration)

After labeling, the label processor extracts bad patterns and writes to `bad-patterns.json` in the Hayba knowledge base. Before `hayba_create_terrain` cooks:

1. Load `bad-patterns.json`
2. For each bad pattern, check incoming graph for matching node+param values within ±15% tolerance
3. If matched, warn the AI with the original context before cooking:

```
⚠️ Bad pattern match: bp-001
Node: Erosion2 — Duration: 0.45 (flagged threshold: > 0.4)
Original feedback: "Ridges too round — erosion duration too high for alpine"
Proceed anyway or adjust?
```

Bad patterns are extracted by Claude post-labeling: it reads the notes paragraph, identifies which node+param caused the issue, and writes a structured entry:
```json
{
  "id": "bp-001",
  "archetype": "Snowy Alpine Peaks",
  "node": "Erosion2",
  "param_snapshot": { "Duration": 0.45 },
  "threshold": "> 0.4",
  "mistake": "Erosion2.Duration > 0.4 on alpine rounds ridge peaks into foothills",
  "original_notes": "Ridges too round — erosion duration too high"
}
```

---

## 7. Inference Server (Hayba DSPy Integration)

### Server

`python scripts/serve.py` → FastAPI at `localhost:8766`

```
POST /infer
{
  "intent": {
    "biome": "alpine", "scale": "regional",
    "geology": ["glacial", "erosion"], "mood": "dramatic"
  },
  "archetype_context": { ... }   // RAG results from Hayba brainstorm
}

Response:
{
  "graph": { "nodes": [...], "edges": [...] },
  "confidence": 0.82,
  "use_cases_predicted": ["alpine", "snow", "glacial"],
  "active": true   // false if below 100-sample threshold
}
```

When `active: false`, Hayba falls back to pure RAG archetype graph.

### DSPy Pipeline (Hayba side — simplified)

```typescript
// In hayba_brainstorm_gaea, after RAG lookup:
const gnnResult = await fetch('http://localhost:8766/infer', {
  method: 'POST',
  body: JSON.stringify({ intent: extractedIntent, archetype_context: ragResults })
});

if (gnnResult.active) {
  // Use GNN-generated graph, surface RAG reasoning alongside it
} else {
  // Fall back to current archetype RAG path
}
```

DSPy optimizes the `intent extraction` step: the prompt that converts the user's natural language description into the structured intent object. Labeled examples (description → known good graph) serve as the DSPy training set. DSPy integration is deferred until sufficient labeled data exists.

---

## 8. New Files Summary

### New Repo: `terrain-gnn`

| Path | Purpose |
|------|---------|
| `src/models/cnn_encoder.py` | ResNet-18 6-channel CNN backbone |
| `src/models/gnn_encoder.py` | GAT graph encoder, 3 layers |
| `src/models/attention.py` | Cross-attention graph ↔ image |
| `src/models/node_delta_mlp.py` | Per-node-family visual delta predictor |
| `src/models/terrain_model.py` | Full model assembly |
| `src/data/generator.py` | Gaea stage-by-stage cook + export |
| `src/data/dem_downloader.py` | Real DEM download + tiling |
| `src/data/processor.py` | Raw data → training tensors |
| `src/labeling/server.py` | FastAPI labeling UI |
| `src/labeling/static/` | HTML/JS labeling interface |
| `src/training/train.py` | 3-phase training loop |
| `src/training/losses.py` | FocalLoss, InfoNCE, L_delta, L_gradient |
| `src/inference/server.py` | FastAPI inference server |
| `scripts/generate_data.py` | CLI: generate N variants |
| `scripts/label_data.py` | CLI: launch labeling UI |
| `scripts/train.py` | CLI: run training |
| `scripts/serve.py` | CLI: start inference server |

### Modified in Hayba Repo

| File | Change |
|------|--------|
| `src/tools/hayba-brainstorm-gaea.ts` | Add GNN inference call with RAG fallback |
| `src/tools/hayba-create-terrain.ts` | Add bad-pattern pre-flight check |
| `src/gaea/knowledge/bad-patterns.json` | New — bad pattern store |
| `src/dashboard/api.ts` | Add label processor trigger endpoint |

---

## 9. Execution Order

1. **Create `terrain-gnn` repo** — scaffold structure, requirements.txt
2. **DEM downloader** — build + run to populate `data/real_dems/`
3. **Data processor** — build GeoTIFF → 512×512×6 tensor pipeline
4. **CNN pretraining** — Phase 1 on real DEMs, L_gradient
5. **Generator** — build stage-by-stage Gaea cook pipeline
6. **Generate bootstrap data** — parse 16 .terrain files + generate 300 variants
7. **Labeling UI** — build FastAPI + HTML interface
8. **Label bootstrap data** — your first labeling session
9. **Joint training** — Phase 2 once ≥100 labeled samples
10. **Inference server** — build FastAPI server
11. **Hayba integration** — DSPy intent extraction + GNN call in brainstorm tool
12. **Bad pattern gate** — label processor + pre-flight check in create_terrain
