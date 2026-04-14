# PCGEx DSPy + GNN Graph Generation System — Design Spec

**Date:** 2026-04-14
**Status:** Approved for Implementation

## Overview

A domain-aware system that converts natural language prompts into optimized PCGEx graphs. DSPy translates the prompt into a structured intermediate representation (sketch + target spec). A per-domain GNN completes the graph topology, predicts parameters, and generates expected intermediate output states. A closed-loop execution debug system validates each node's output table against the GNN's predictions and self-corrects when possible. A beam search loop runs K candidates × R rounds to find the most optimized graph. A deterministic layout pass produces clean node positioning before writing to UE.

Each PCG domain (foliage, roads, rivers, etc.) is an independent model lifecycle — its own training data, labels, and model weights, progressing through three phases independently.

---

## Problem Statement

The current PCGEx graph generation flow is purely LLM-driven: Claude selects node types from the catalog and wires them heuristically. There is no:
- Learned knowledge of what parameter values actually produce good output
- Feedback loop from execution results back into graph decisions
- Graph optimization — the first graph generated is the one used
- Layout — node positions are arbitrary

The GNN solves this by learning from executed graph examples: what topologies work for which domains, what parameters produce target output distributions, and what each intermediate node stage should look like. The debug loop grounds inference in actual UE execution, catching divergences before they propagate.

---

## 1. System Architecture

```
User prompt
    │
    ▼
┌──────────────────────────────────────────┐
│  DSPy Pipeline (pcgex-gnn Python server) │
│  1. Domain Classifier                    │
│     → "foliage" | "roads" | "rivers"...  │
│  2. Intent Extractor (per-domain)        │
│     → { technique, biome, density,       │
│          purpose, scale }                │
│  3. Sketch Builder                       │
│     → ordered node type list             │
│       (validated against PCGEx catalog)  │
│  4. Target Spec Builder                  │
│     → { geometry_type, count_range,      │
│          required_attrs, density_bounds }│
└──────────────────┬───────────────────────┘
                   │ IR = { domain, sketch[], target{} }
                   ▼
┌──────────────────────────────────────────┐
│  RAG System                              │
│  Query: intent vector                    │
│  KB: PCGEx website examples +            │
│      per-domain labeled good graphs      │
│  → top-K=5 retrieved graph embeddings    │
│    passed as GNN context vectors         │
└──────────────────┬───────────────────────┘
                   │
                   ▼
┌──────────────────────────────────────────┐
│  Domain Registry                         │
│  foliage: phase=2, samples=140, weights  │
│  roads:   phase=1, samples=12, weights   │
│  rivers:  phase=0 → LLM fallback         │
└──────────┬───────────────────────────────┘
           │
    ┌──────┴──────┐
    ▼             ▼
Domain GNN    LLM Fallback
(phase ≥ 2)   (phase 0–1)
    │
    ▼
┌──────────────────────────────────────────┐
│  GNN Inference (per-domain model)        │
│  Input: sketch + target spec             │
│         + RAG context vectors            │
│                                          │
│  Stage 1 — Topology Completion           │
│    GAT over sketch nodes                 │
│    → predict edges + node order          │
│                                          │
│  Stage 2 — Parameter Prediction          │
│    Per-node MLP conditioned on           │
│    target spec + graph context           │
│    → param values per node               │
│                                          │
│  Stage 3 — Expected State Table          │
│    Per node: predicted output features   │
│    { point_count, attrs, value_ranges }  │
└──────────────────┬───────────────────────┘
                   │ K=5 candidate graphs
                   ▼
┌──────────────────────────────────────────┐
│  Search Loop (R=2 rounds at inference,   │
│               R=3 offline for training)  │
│  Execute all K candidates in UE          │
│  Score = w_quality·quality               │
│         - w_runtime·runtime_penalty      │
│         - w_divergence·state_divergence  │
│  Mutate top-M, re-generate               │
│  Return best scoring graph               │
└──────────────────┬───────────────────────┘
                   │
                   ▼
┌──────────────────────────────────────────┐
│  PCGEx Debug Loop (UE bridge)            │
│  Per node in topo order:                 │
│  execute → READ_NODE_OUTPUT              │
│  → encode features                       │
│  → compare vs expected state             │
│  → diverged < 0.40: re-predict params    │
│  → diverged ≥ 0.40: flag to user         │
└──────────────────┬───────────────────────┘
                   │
                   ▼
┌──────────────────────────────────────────┐
│  Layout Pass                             │
│  Sugiyama layered layout algorithm       │
│  Groups nodes by function family         │
│  Writes clean (x,y) positions to graph   │
└──────────────────────────────────────────┘
```

---

## 2. DSPy Pipeline

DSPy runs as part of the `pcgex-gnn` Python server. Hayba (TypeScript) calls it via HTTP alongside the GNN inference endpoint. Three DSPy modules, each optimized independently with labeled examples.

### 2.1 Domain Classifier
- Input: raw user prompt
- Output: domain string from a fixed registry (`foliage`, `roads`, `rivers`, `dungeons`, `cities`, ...)
- DSPy signature: `Predict("prompt -> domain")`
- Training examples: `(prompt, correct_domain)` pairs — generated synthetically from PCGEx website descriptions

### 2.2 Intent Extractor (per-domain)
- Input: prompt + domain
- Output: structured intent dict
```json
{
  "technique": "cluster_scatter",
  "biome": "alpine",
  "density": "sparse",
  "purpose": "foliage_placement",
  "scale": "regional"
}
```
- DSPy signature: `ChainOfThought("prompt, domain -> intent")`
- Optimized per-domain with labeled `(prompt, intent)` pairs

### 2.3 Sketch Builder
- Input: intent
- Output: ordered list of PCGEx node class names, validated against the catalog
```json
["PCGExSampleNearestPoint", "PCGExCluster", "PCGExPathfinding", "PCGExWriteIndex"]
```
- DSPy signature: `ChainOfThought("intent, available_node_types -> sketch")`
- Available node types injected from live catalog query

### 2.4 Target Spec Builder
- Input: intent
- Output: quantitative output expectations
```json
{
  "geometry_type": "points",
  "count_range": [500, 2000],
  "required_attrs": ["density_weight", "slope_mask"],
  "density_bounds": [0.01, 0.05],
  "scale": "regional"
}
```
- DSPy signature: `Predict("intent -> target_spec")`

All four DSPy modules are optimized using `BootstrapFewShot` with labeled examples. The labeled set grows from human-reviewed execution results.

---

## 3. GNN Architecture

Each domain has its own model instance. All share the same architecture.

```
Inputs:
  ├── Sketch nodes     [N × 73-dim node features]
  ├── Target spec      [128-dim global conditioning vector]
  └── RAG context      [K × 256-dim graph embeddings]

                    ┌────────────────────────────┐
Sketch + edges ───► │  GAT Encoder                │
                    │  3 layers, 4 heads           │
                    │  Node features:              │
                    │  [type_embed(64) |            │
                    │   depth_in_graph(1) |         │
                    │   domain_tag(8)]  → 73-dim    │
                    │  Edge features:               │
                    │  [pin_type_onehot(16)]        │
                    │  Target spec concatenated     │
                    │  to each node before each     │
                    │  GAT layer                    │
                    └──────────┬──────────────────┘
                               │ [N × 256] node embeddings
                               │
                    ┌──────────▼──────────────────┐
RAG context ──────► │  Cross-Attention             │
                    │  Q: node embeddings           │
                    │  K/V: RAG graph embeddings    │
                    │  → nodes attend to known      │
                    │    good graph patterns        │
                    └──────────┬──────────────────┘
                               │
           ┌───────────────────┼──────────────────┐
           ▼                   ▼                  ▼
  ┌─────────────────┐  ┌──────────────┐  ┌───────────────────┐
  │ Topology Head   │  │ Param Head   │  │ Expected State    │
  │ Pairwise dot    │  │ Per-node MLP │  │ Head              │
  │ product +       │  │ conditioned  │  │ Per-node MLP      │
  │ sigmoid         │  │ on target    │  │ → predicted       │
  │ → adjacency     │  │ spec vector  │  │ output features   │
  │   matrix        │  │ → param dict │  │ { count, attrs,   │
  └─────────────────┘  └──────────────┘  │   value_ranges }  │
                                          └───────────────────┘
```

**Node type embeddings:** Learned from scratch, initialized from PCGEx catalog. One 64-dim embedding per node class.

**Target spec vector (128-dim):** Dense encoding of:
```
[geometry_type_onehot(16) | count_range(2) | density_bounds(2) |
 required_attrs_bow(64) | scale_onehot(8) | domain_onehot(16) | padding(20)]
```
Concatenated to every node embedding before each GAT layer — every attention computation is conditioned on the goal.

**RAG cross-attention:** Each sketch node attends to how the same node type was used in retrieved good graphs, pulling its predicted connections and param ranges toward known-good patterns.

---

## 4. Training Pipeline (Per Domain)

### Phase 0 — LLM Fallback
- No model exists. All requests routed to LLM + catalog.
- Every executed graph queued for human labeling in UE5 viewport.
- **Advances to Phase 1** when 20 labeled samples exist.

### Phase 1 — Bootstrap
- **Data:** PCGEx website examples + automated mutations (±30% param perturbation, node swaps, node additions)
- **Labels:** Human quality ratings from UE5 viewport — Good / Interesting / Bad
- **Training:** Supervised graph completion — `(sketch + target) → (full graph + params)`

**Loss:**
```
L = L_topology + λ₁·L_params + λ₂·L_quality + λ₃·L_state
L_topology  = BCE(predicted_edges, true_edges)
L_params    = SmoothL1(predicted_params, true_params)
L_quality   = CrossEntropy(predicted_quality, human_label)
L_state     = SmoothL1(predicted_state_features, actual_output_table_features)

λ₁=1.0, λ₂=0.5, λ₃=1.5
```

- **Advances to Phase 2** when 100 good-quality labeled samples exist.

### Phase 2 — Joint Training with Execution Reward
- **New signal:** Quantitative scorer trained on labeled set — proxy metrics derived from what good graphs produce per domain (point count ranges, attribute presence, density distributions)
- **Search loop:** K=10, R=3 offline (data generation); K=5, R=2 at inference
- **Runtime loss** activates (requires designated benchmark machine):

**Full loss:**
```
L = L_topology + λ₁·L_params + λ₂·L_quality + λ₃·L_state
  + λ₄·L_execution + λ₅·L_runtime

L_execution = -reward(execution_output vs target_spec)
              reward = weighted sum of quantitative metric matches

L_runtime   = ReLU(normalized_runtime_ms - domain_budget_ms) / domain_budget_ms
              normalized_runtime = wall_clock_ms / (output_point_count / 1000)
              domain_budget_ms: configurable per domain

λ₄=1.0, λ₅=0.8
```

**Runtime measurement constraints:**
- All training data generation must run on the designated benchmark machine
- Fixed UE scalability settings (Epic quality, no background tasks)
- Runtime measurements from other machines are discarded
- Normalized by output size (ms per 1000 output points) so dense graphs are not unfairly penalized

### Phase 3 — Fine-tuning
- High-confidence Good labels only
- Freeze GAT backbone, fine-tune param head + expected state head + quality scorer
- Triggered manually after significant new labeled batches
- Aligns model to specific quality preferences per domain

---

## 5. Search Loop

### Inference Time (K=5, R=2)
```
Round 1:
  GNN generates K=5 candidate graphs from same IR
  Execute all 5 in UE
  Score each:
    score = w_quality·quality_score
           - w_runtime·runtime_penalty
           - w_divergence·avg_state_divergence
  Keep top-2 candidates

Round 2:
  Mutate top-2 (param perturbation ±15%, edge rewiring)
  GNN re-predicts params for mutated sketches
  Execute all mutations
  Score and return best overall
```

### Offline / Training Time (K=10, R=3)
Same loop, larger budget. All candidates stored as training examples regardless of score.

### Scoring Weights (per domain, configurable)
| Weight | Default | Notes |
|--------|---------|-------|
| w_quality | 1.0 | Human label or quantitative scorer |
| w_runtime | 0.3 | Lower priority than quality |
| w_divergence | 0.5 | Penalize graphs with many debug loop corrections |

---

## 6. PCGEx Debug Loop

Requires one new UE TCP command: `READ_NODE_OUTPUT` — returns output table features for a specific node after execution.

### Output Table Feature Encoding
```json
{
  "point_count": 1423,
  "geometry_type": "points",
  "attributes": ["density_weight", "slope_mask", "cluster_id"],
  "value_ranges": {
    "density_weight": [0.0, 1.0],
    "slope_mask": [0.12, 0.87]
  }
}
```

### Per-Node Decision Logic
```
divergence = ||actual_features - predicted_features|| / ||predicted_features||

divergence < 0.15  → continue (within tolerance)
divergence < 0.40  → GNN re-predicts params for this node only
                     one re-predict attempt, then continue regardless
divergence ≥ 0.40  → pause execution, flag to user:
                     { node_class, expected_features, actual_features,
                       suggested_fix, confidence }
```

Thresholds are configurable per domain. Foliage: 0.15 / 0.45. Roads: 0.10 / 0.35 (tighter — roads fail more catastrophically when wrong).

---

## 7. RAG System

### Knowledge Base Entries
Two entry types, same 256-dim embedding space:
- **Website examples** — scraped PCGEx graph patterns, parsed into `{ nodes, edges, domain_tags, description }`
- **Labeled good graphs** — execution results rated Good, stored per domain, auto-inserted on label

### Embedding Model
Lightweight GNN encoder (same GAT backbone, frozen after Phase 1). Maps `{ nodes, edges }` → 256-dim vector. Graphs with similar structure and domain land near each other.

### Retrieval
```
query_vector = encode({ intent_features + sketch_node_types })
→ cosine similarity search over KB
→ top-K=5 graph embeddings → passed to GNN cross-attention
```

### KB Growth
Every Good-labeled graph is automatically embedded and inserted. No manual curation.

---

## 8. Layout Pass

Runs after the best candidate is selected, before writing to UE. Deterministic, <1ms.

**Algorithm:** Sugiyama layered layout
1. Topological sort → assign each node to a column layer
2. Within each layer, sort nodes by function family:
   - `primitives` — point samplers, spline inputs, data sources
   - `filters` — attribute filters, spatial queries, masks
   - `processors` — cluster, pathfind, transform, combine
   - `outputs` — mesh spawner, spline builder, write attributes, debug
3. Minimize edge crossings within layers
4. Assign pixel positions: 250px horizontal spacing, 120px vertical spacing
5. Write `(x, y)` into graph JSON

---

## 9. Domain Registry

Stored as `pcgex-domain-registry.json` in the Hayba knowledge base:

```json
{
  "foliage": {
    "phase": 2,
    "labeled_samples": 140,
    "good_samples": 112,
    "weights_path": "models/foliage/v3.pt",
    "domain_budget_ms": 50,
    "divergence_thresholds": [0.15, 0.45],
    "scoring_weights": { "quality": 1.0, "runtime": 0.3, "divergence": 0.5 }
  },
  "roads": {
    "phase": 1,
    "labeled_samples": 12,
    "good_samples": 8,
    "weights_path": "models/roads/v1.pt",
    "domain_budget_ms": 200,
    "divergence_thresholds": [0.10, 0.35],
    "scoring_weights": { "quality": 1.0, "runtime": 0.2, "divergence": 0.7 }
  }
}
```

New domains are added to the registry manually. They start at phase=0 with no weights — all requests fall back to LLM generation while samples accumulate.

---

## 10. Data Generation Pipeline

```
For each domain × sketch pattern × N mutations:
  1. Build graph JSON (mutate params ±30%, swap/add nodes)
  2. Load into UE via TCP bridge
  3. For each node in topological order:
     a. Execute node
     b. READ_NODE_OUTPUT → encode output table features
     c. Record wall-clock time (benchmark machine only)
     d. Store as expected state ground truth
  4. Queue final graph for human labeling
  5. Write:
     data/raw/<domain>/<sample-id>/
       graph.json          nodes + edges + params
       stage_<N>_<class>.json  per-node output features
       meta.json           { domain, source, mutations_applied }
       runtime.json        { total_ms, per_node_ms, normalized_ms }
       label.json          written during labeling
```

**Volume targets per domain:**

| Source | Samples | When |
|--------|---------|------|
| PCGEx website examples + mutations | 50–100 | Immediate bootstrap |
| Human-labeled execution results | +N | Ongoing Phase 1 |
| Search loop candidates offline | +N×K×R | Phase 2+ |

---

## 11. New Files Summary

### New Repo: `pcgex-gnn`

| Path | Purpose |
|------|---------|
| `src/models/gat_encoder.py` | GAT backbone, shared across all domains |
| `src/models/topology_head.py` | Edge predictor (pairwise dot product + sigmoid) |
| `src/models/param_head.py` | Per-node param prediction MLP |
| `src/models/expected_state_head.py` | Per-node output feature predictor |
| `src/models/quality_scorer.py` | Phase 2+ quantitative scorer |
| `src/models/pcgex_model.py` | Full model assembly + forward pass |
| `src/data/generator.py` | UE TCP bridge stage-by-stage execution + capture |
| `src/data/processor.py` | Raw samples → training tensors |
| `src/data/mutations.py` | Param perturbation, node swap, node addition |
| `src/rag/embedder.py` | Graph → 256-dim embedding |
| `src/rag/kb.py` | Knowledge base: insert, cosine query, persist |
| `src/training/train.py` | Phase-aware training loop |
| `src/training/losses.py` | BCE, SmoothL1, CrossEntropy, L_execution, L_runtime |
| `src/training/evaluate.py` | Topology F1, param MAE, state divergence metrics |
| `src/inference/server.py` | FastAPI inference server (localhost:8767) |
| `src/inference/search.py` | K-candidate beam search + multi-objective scoring |
| `src/inference/debug_loop.py` | Expected state comparison + param re-prediction |
| `src/inference/layout.py` | Sugiyama layout algorithm |
| `src/domain/registry.py` | Domain manifest: load, update, phase transitions |
| `scripts/generate_data.py` | CLI: generate N variants for a domain |
| `scripts/train.py` | CLI: run training for a domain |
| `scripts/serve.py` | CLI: start inference server |
| `requirements.txt` | |

### Modified in Hayba Repo

| File | Change |
|------|--------|
| `src/tools/initiate-infrastructure-brainstorm.ts` | Add DSPy domain classification + sketch/target builder |
| `src/tools/create-pcg-graph.ts` | Route through GNN inference server if domain phase ≥ 2 |
| `src/tools/execute-pcg-graph.ts` | Add per-node debug loop with READ_NODE_OUTPUT |
| `src/tools/validate-pcg-graph.ts` | Surface expected state divergence warnings |
| `src/gaea/knowledge/pcgex-kb.json` | New — RAG knowledge base seed (website examples) |
| `src/gaea/knowledge/pcgex-domain-registry.json` | New — domain manifest |

### New UE Plugin TCP Command

| Command | Purpose |
|---------|---------|
| `READ_NODE_OUTPUT` | Returns encoded output table features for a node after execution |

---

## 12. Execution Order

1. Scaffold `pcgex-gnn` repo and `requirements.txt`
2. Build data generator (UE TCP bridge + per-node output capture)
3. Scrape PCGEx website examples → seed RAG knowledge base
4. Build mutation pipeline → generate bootstrap data for first domain (foliage)
5. Build labeling queue (UE5 viewport review flow)
6. Label bootstrap data → reach Phase 1 for foliage
7. Train Phase 1 model for foliage
8. Build inference server + search loop
9. Build debug loop (READ_NODE_OUTPUT TCP command + divergence logic)
10. Build layout pass
11. Integrate into Hayba (create-pcg-graph routing + DSPy pipeline)
12. Generate more data, label, advance foliage to Phase 2
13. Add roads domain — repeat from step 4
