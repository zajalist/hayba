# PCGEx GNN — Plan 2: Model, RAG, and Training Pipeline

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the full GNN model architecture, RAG knowledge base, loss functions, and phase-aware training loop for the PCGEx graph generation system.

**Architecture:** A GAT-based encoder produces per-node 256-dim embeddings conditioned on a global target spec vector. Three task heads predict graph topology (edges), node parameters, and expected intermediate output states. A separate RAG embedder converts graphs to 256-dim vectors for similarity retrieval. The training loop is phase-aware: Phase 1 uses supervised completion losses only; Phase 2 adds execution reward and runtime penalty.

**Tech Stack:** Python 3.11+, PyTorch 2.x, torch-geometric (optional — plan uses manual GAT if unavailable), pytest, numpy

**Prerequisites:** Plan 1 complete. `D:/pcgex-gnn/src/data/processor.py` (`ProcessedSample`, `MAX_PARAMS=16`) and `D:/pcgex-gnn/src/domain/registry.py` (`Phase`) must exist.

---

## File Map

### New files in `D:/pcgex-gnn/`

| File | Responsibility |
|------|----------------|
| `src/models/__init__.py` | Package marker |
| `src/models/gat_encoder.py` | GAT backbone: node features + target spec → node embeddings + graph embedding |
| `src/models/topology_head.py` | Node embeddings → predicted adjacency matrix |
| `src/models/param_head.py` | Node embedding + target spec → param vector per node |
| `src/models/expected_state_head.py` | Node embedding → predicted output table features |
| `src/models/quality_scorer.py` | Graph embedding → scalar quality score |
| `src/models/pcgex_model.py` | Full model assembly + forward pass |
| `src/models/target_spec.py` | Encode target spec dict → 128-dim tensor |
| `src/rag/embedder.py` | Graph dict → 256-dim embedding via frozen GAT |
| `src/rag/kb.py` | In-memory KB: insert, cosine query, persist to JSON |
| `src/training/__init__.py` | Package marker |
| `src/training/losses.py` | L_topology, L_params, L_quality, L_state, L_runtime |
| `src/training/evaluate.py` | topology_f1, param_mae, state_divergence |
| `src/training/train.py` | Phase-aware training loop with early stopping |
| `tests/test_gat_encoder.py` | GAT encoder tests |
| `tests/test_topology_head.py` | Topology head tests |
| `tests/test_param_head.py` | Param head tests |
| `tests/test_expected_state_head.py` | Expected state head tests |
| `tests/test_quality_scorer.py` | Quality scorer tests |
| `tests/test_pcgex_model.py` | Full model forward pass tests |
| `tests/test_target_spec.py` | Target spec encoder tests |
| `tests/test_embedder.py` | RAG embedder tests |
| `tests/test_kb.py` | Knowledge base tests |
| `tests/test_losses.py` | Loss function tests |
| `tests/test_evaluate.py` | Evaluation metric tests |
| `tests/test_train.py` | Training loop smoke tests |

---

## Constants (used across all files)

```python
NODE_EMBED_DIM = 64        # type embedding dimension
GAT_HIDDEN_DIM = 256       # GAT output dimension per node
TARGET_SPEC_DIM = 128      # target spec encoding dimension
GAT_HEADS = 4              # multi-head attention heads
GAT_LAYERS = 3             # number of GAT layers
MAX_PARAMS = 16            # from processor.py
MAX_NODE_VOCAB = 512       # max distinct PCGEx node classes
```

---

## Task 1: Target Spec Encoder

**Files:**
- Create: `D:/pcgex-gnn/src/models/__init__.py`
- Create: `D:/pcgex-gnn/src/models/target_spec.py`
- Create: `D:/pcgex-gnn/tests/test_target_spec.py`

- [ ] **Step 1: Write the failing tests**

```python
# D:/pcgex-gnn/tests/test_target_spec.py
import torch
import pytest
from src.models.target_spec import encode_target_spec, TARGET_SPEC_DIM

SAMPLE_SPEC = {
    "geometry_type": "points",
    "count_range": [500, 2000],
    "required_attrs": ["density_weight", "slope_mask"],
    "density_bounds": [0.01, 0.05],
    "scale": "regional",
    "domain": "foliage",
}

def test_encode_returns_tensor():
    vec = encode_target_spec(SAMPLE_SPEC)
    assert isinstance(vec, torch.Tensor)

def test_encode_correct_shape():
    vec = encode_target_spec(SAMPLE_SPEC)
    assert vec.shape == (TARGET_SPEC_DIM,)

def test_encode_dtype_float32():
    vec = encode_target_spec(SAMPLE_SPEC)
    assert vec.dtype == torch.float32

def test_encode_different_geometry_types_differ():
    points_vec = encode_target_spec({**SAMPLE_SPEC, "geometry_type": "points"})
    splines_vec = encode_target_spec({**SAMPLE_SPEC, "geometry_type": "splines"})
    assert not torch.allclose(points_vec, splines_vec)

def test_encode_missing_optional_fields_does_not_crash():
    minimal = {"geometry_type": "points"}
    vec = encode_target_spec(minimal)
    assert vec.shape == (TARGET_SPEC_DIM,)

def test_encode_batch():
    specs = [SAMPLE_SPEC, {"geometry_type": "splines"}]
    from src.models.target_spec import encode_target_spec_batch
    batch = encode_target_spec_batch(specs)
    assert batch.shape == (2, TARGET_SPEC_DIM)
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd D:/pcgex-gnn && python -m pytest tests/test_target_spec.py -v 2>&1 | head -10
```
Expected: FAIL — `ModuleNotFoundError`

- [ ] **Step 3: Create package marker and implement encoder**

```python
# D:/pcgex-gnn/src/models/__init__.py
```

```python
# D:/pcgex-gnn/src/models/target_spec.py
from __future__ import annotations
import torch
import torch.nn.functional as F

TARGET_SPEC_DIM = 128

# Vocabulary maps for categorical fields
_GEOMETRY_TYPES = ["points", "splines", "unknown"]           # 3-dim onehot → padded to 16
_SCALES = ["local", "regional", "global", "unknown"]         # 4-dim onehot → padded to 8
_DOMAINS = ["foliage", "roads", "rivers", "dungeons",
            "cities", "unknown"]                              # 6-dim onehot → padded to 16

# Attribute bag-of-words vocabulary (grows from common PCGEx attrs)
_ATTR_VOCAB = [
    "density_weight", "slope_mask", "cluster_id", "road_width",
    "elevation", "normal", "color", "biome_tag", "path_length",
    "distance_to_edge", "curvature", "flow", "height_band",
]  # 13 attrs → padded to 64

def _onehot(value: str, vocab: list[str], pad_to: int) -> list[float]:
    vec = [0.0] * len(vocab)
    idx = vocab.index(value) if value in vocab else vocab.index("unknown") if "unknown" in vocab else 0
    vec[idx] = 1.0
    vec += [0.0] * (pad_to - len(vocab))
    return vec

def _attr_bow(attrs: list[str], pad_to: int) -> list[float]:
    vec = [0.0] * len(_ATTR_VOCAB)
    for attr in attrs:
        if attr in _ATTR_VOCAB:
            vec[_ATTR_VOCAB.index(attr)] = 1.0
    vec += [0.0] * (pad_to - len(_ATTR_VOCAB))
    return vec

def encode_target_spec(spec: dict) -> torch.Tensor:
    """Encode a target spec dict into a TARGET_SPEC_DIM float32 tensor."""
    geom = _onehot(spec.get("geometry_type", "unknown"), _GEOMETRY_TYPES, pad_to=16)       # 16
    count_range = spec.get("count_range", [0, 0])
    count = [float(count_range[0]) / 10000.0, float(count_range[1]) / 10000.0]             # 2
    density = spec.get("density_bounds", [0.0, 0.0])
    dens = [float(density[0]), float(density[1])]                                           # 2
    attrs = _attr_bow(spec.get("required_attrs", []), pad_to=64)                            # 64
    scale = _onehot(spec.get("scale", "unknown"), _SCALES, pad_to=8)                       # 8
    domain = _onehot(spec.get("domain", "unknown"), _DOMAINS, pad_to=16)                   # 16
    # Total so far: 16+2+2+64+8+16 = 108 → pad to 128
    raw = geom + count + dens + attrs + scale + domain
    raw += [0.0] * (TARGET_SPEC_DIM - len(raw))
    return torch.tensor(raw[:TARGET_SPEC_DIM], dtype=torch.float32)

def encode_target_spec_batch(specs: list[dict]) -> torch.Tensor:
    """Encode a list of target spec dicts → [B × TARGET_SPEC_DIM]."""
    return torch.stack([encode_target_spec(s) for s in specs])
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd D:/pcgex-gnn && python -m pytest tests/test_target_spec.py -v
```
Expected: 6/6 PASS

- [ ] **Step 5: Commit**

```bash
cd D:/pcgex-gnn && git add src/models/__init__.py src/models/target_spec.py tests/test_target_spec.py && git commit -m "feat: add target spec encoder — dict to 128-dim conditioning tensor"
```

---

## Task 2: GAT Encoder

**Files:**
- Create: `D:/pcgex-gnn/src/models/gat_encoder.py`
- Create: `D:/pcgex-gnn/tests/test_gat_encoder.py`

The GAT encoder takes node features from `ProcessedSample` and a target spec vector, produces per-node embeddings and a global graph embedding via mean pooling.

- [ ] **Step 1: Write the failing tests**

```python
# D:/pcgex-gnn/tests/test_gat_encoder.py
import torch
import pytest
from src.models.gat_encoder import GATEncoder, GAT_HIDDEN_DIM

N_NODES = 4
INPUT_DIM = 18   # matches ProcessedSample.node_features shape[1] = 1 + MAX_PARAMS + 1
TARGET_DIM = 128

def make_inputs(n=N_NODES):
    node_features = torch.randn(n, INPUT_DIM)
    adjacency = torch.zeros(n, n)
    adjacency[0, 1] = 1.0
    adjacency[1, 2] = 1.0
    adjacency[2, 3] = 1.0
    target_spec = torch.randn(TARGET_DIM)
    return node_features, adjacency, target_spec

def test_output_node_embeddings_shape():
    enc = GATEncoder(input_dim=INPUT_DIM, target_spec_dim=TARGET_DIM)
    nf, adj, ts = make_inputs()
    node_embeds, graph_embed = enc(nf, adj, ts)
    assert node_embeds.shape == (N_NODES, GAT_HIDDEN_DIM)

def test_output_graph_embedding_shape():
    enc = GATEncoder(input_dim=INPUT_DIM, target_spec_dim=TARGET_DIM)
    nf, adj, ts = make_inputs()
    node_embeds, graph_embed = enc(nf, adj, ts)
    assert graph_embed.shape == (GAT_HIDDEN_DIM,)

def test_output_dtype_float32():
    enc = GATEncoder(input_dim=INPUT_DIM, target_spec_dim=TARGET_DIM)
    nf, adj, ts = make_inputs()
    node_embeds, graph_embed = enc(nf, adj, ts)
    assert node_embeds.dtype == torch.float32
    assert graph_embed.dtype == torch.float32

def test_single_node_graph():
    enc = GATEncoder(input_dim=INPUT_DIM, target_spec_dim=TARGET_DIM)
    nf = torch.randn(1, INPUT_DIM)
    adj = torch.zeros(1, 1)
    ts = torch.randn(TARGET_DIM)
    node_embeds, graph_embed = enc(nf, adj, ts)
    assert node_embeds.shape == (1, GAT_HIDDEN_DIM)
    assert graph_embed.shape == (GAT_HIDDEN_DIM,)

def test_graph_embed_is_mean_of_node_embeds():
    enc = GATEncoder(input_dim=INPUT_DIM, target_spec_dim=TARGET_DIM)
    enc.eval()
    nf, adj, ts = make_inputs()
    node_embeds, graph_embed = enc(nf, adj, ts)
    expected = node_embeds.mean(dim=0)
    assert torch.allclose(graph_embed, expected, atol=1e-5)

def test_different_adjacency_produces_different_output():
    enc = GATEncoder(input_dim=INPUT_DIM, target_spec_dim=TARGET_DIM)
    enc.eval()
    nf = torch.randn(3, INPUT_DIM)
    ts = torch.randn(TARGET_DIM)
    adj1 = torch.zeros(3, 3); adj1[0, 1] = 1.0
    adj2 = torch.zeros(3, 3); adj2[1, 2] = 1.0
    out1, _ = enc(nf, adj1, ts)
    out2, _ = enc(nf, adj2, ts)
    assert not torch.allclose(out1, out2)
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd D:/pcgex-gnn && python -m pytest tests/test_gat_encoder.py -v 2>&1 | head -10
```
Expected: FAIL — `ModuleNotFoundError`

- [ ] **Step 3: Implement GAT encoder**

```python
# D:/pcgex-gnn/src/models/gat_encoder.py
"""
GAT encoder: node_features [N×input_dim] + target_spec [128] → node_embeds [N×256] + graph_embed [256]

Implements multi-head graph attention manually (no external library dependency).
Target spec is broadcast-concatenated to every node before each GAT layer so all
attention computations are conditioned on the generation goal.
"""
from __future__ import annotations
import torch
import torch.nn as nn
import torch.nn.functional as F

GAT_HIDDEN_DIM = 256
GAT_HEADS = 4
GAT_LAYERS = 3


class GATLayer(nn.Module):
    """Single multi-head graph attention layer."""

    def __init__(self, in_dim: int, out_dim: int, heads: int):
        super().__init__()
        assert out_dim % heads == 0
        self.heads = heads
        self.head_dim = out_dim // heads
        self.W = nn.Linear(in_dim, out_dim, bias=False)
        self.a = nn.Parameter(torch.empty(heads, 2 * self.head_dim))
        nn.init.xavier_uniform_(self.a.unsqueeze(0))
        self.norm = nn.LayerNorm(out_dim)

    def forward(self, x: torch.Tensor, adj: torch.Tensor) -> torch.Tensor:
        """
        x:   [N × in_dim]
        adj: [N × N] (1 where edge exists, 0 otherwise)
        returns: [N × out_dim]
        """
        N = x.size(0)
        h = self.W(x).view(N, self.heads, self.head_dim)   # [N, H, D]

        # Compute attention scores for all pairs
        h_i = h.unsqueeze(1).expand(N, N, self.heads, self.head_dim)  # [N, N, H, D]
        h_j = h.unsqueeze(0).expand(N, N, self.heads, self.head_dim)  # [N, N, H, D]
        pair = torch.cat([h_i, h_j], dim=-1)                          # [N, N, H, 2D]

        e = F.leaky_relu((pair * self.a).sum(dim=-1), negative_slope=0.2)  # [N, N, H]

        # Mask out non-edges (keep self-loops)
        mask = (adj + torch.eye(N, device=adj.device)).bool()          # [N, N]
        e = e.masked_fill(~mask.unsqueeze(-1), float('-inf'))

        alpha = F.softmax(e, dim=1)                                    # [N, N, H]

        # Aggregate
        out = (alpha.unsqueeze(-1) * h_j).sum(dim=1)                  # [N, H, D]
        out = out.view(N, -1)                                          # [N, H*D]
        return self.norm(F.elu(out))


class GATEncoder(nn.Module):
    """
    3-layer GAT encoder with target spec conditioning.
    Target spec is concatenated to node features before each layer.
    """

    def __init__(self, input_dim: int = 18, target_spec_dim: int = 128,
                 hidden_dim: int = GAT_HIDDEN_DIM, n_layers: int = GAT_LAYERS,
                 heads: int = GAT_HEADS):
        super().__init__()
        self.target_spec_dim = target_spec_dim

        # Each layer input = previous output + target_spec_dim
        layer_dims = []
        in_d = input_dim + target_spec_dim
        for _ in range(n_layers):
            layer_dims.append((in_d, hidden_dim))
            in_d = hidden_dim + target_spec_dim

        self.layers = nn.ModuleList([
            GATLayer(in_d, out_d, heads) for in_d, out_d in layer_dims
        ])

    def forward(self, node_features: torch.Tensor,
                adjacency: torch.Tensor,
                target_spec: torch.Tensor) -> tuple[torch.Tensor, torch.Tensor]:
        """
        node_features: [N × input_dim]
        adjacency:     [N × N]
        target_spec:   [TARGET_SPEC_DIM]
        returns: (node_embeds [N × GAT_HIDDEN_DIM], graph_embed [GAT_HIDDEN_DIM])
        """
        N = node_features.size(0)
        # Broadcast target spec to all nodes
        spec_expanded = target_spec.unsqueeze(0).expand(N, -1)   # [N × spec_dim]

        x = torch.cat([node_features, spec_expanded], dim=-1)
        for i, layer in enumerate(self.layers):
            x = layer(x, adjacency)
            if i < len(self.layers) - 1:
                x = torch.cat([x, spec_expanded], dim=-1)

        graph_embed = x.mean(dim=0)
        return x, graph_embed
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd D:/pcgex-gnn && python -m pytest tests/test_gat_encoder.py -v
```
Expected: 6/6 PASS

- [ ] **Step 5: Commit**

```bash
cd D:/pcgex-gnn && git add src/models/gat_encoder.py tests/test_gat_encoder.py && git commit -m "feat: add GAT encoder with target spec conditioning"
```

---

## Task 3: Topology Head

**Files:**
- Create: `D:/pcgex-gnn/src/models/topology_head.py`
- Create: `D:/pcgex-gnn/tests/test_topology_head.py`

- [ ] **Step 1: Write the failing tests**

```python
# D:/pcgex-gnn/tests/test_topology_head.py
import torch
import pytest
from src.models.topology_head import TopologyHead

N = 4
EMBED_DIM = 256

def make_embeds(n=N):
    return torch.randn(n, EMBED_DIM)

def test_output_shape():
    head = TopologyHead(embed_dim=EMBED_DIM)
    embeds = make_embeds()
    adj_logits = head(embeds)
    assert adj_logits.shape == (N, N)

def test_output_dtype():
    head = TopologyHead(embed_dim=EMBED_DIM)
    adj_logits = head(make_embeds())
    assert adj_logits.dtype == torch.float32

def test_probabilities_in_zero_one():
    head = TopologyHead(embed_dim=EMBED_DIM)
    probs = torch.sigmoid(head(make_embeds()))
    assert (probs >= 0.0).all()
    assert (probs <= 1.0).all()

def test_single_node():
    head = TopologyHead(embed_dim=EMBED_DIM)
    adj = head(torch.randn(1, EMBED_DIM))
    assert adj.shape == (1, 1)

def test_no_self_loops_by_default():
    """Diagonal of predicted adjacency should be zero (no self-loops)."""
    head = TopologyHead(embed_dim=EMBED_DIM)
    adj_logits = head(make_embeds())
    diag = torch.diag(adj_logits)
    assert torch.all(diag == 0.0)
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd D:/pcgex-gnn && python -m pytest tests/test_topology_head.py -v 2>&1 | head -10
```
Expected: FAIL

- [ ] **Step 3: Implement topology head**

```python
# D:/pcgex-gnn/src/models/topology_head.py
"""
Topology head: node_embeddings [N×D] → edge_logits [N×N]

Pairwise dot product (scaled by sqrt(D)) between all pairs of node embeddings.
Diagonal is zeroed to prevent self-loops.
Caller applies sigmoid to get edge probabilities.
"""
from __future__ import annotations
import math
import torch
import torch.nn as nn


class TopologyHead(nn.Module):
    def __init__(self, embed_dim: int = 256):
        super().__init__()
        self.scale = math.sqrt(embed_dim)
        # Learnable projection before dot product
        self.proj = nn.Linear(embed_dim, embed_dim, bias=False)

    def forward(self, node_embeddings: torch.Tensor) -> torch.Tensor:
        """
        node_embeddings: [N × embed_dim]
        returns: edge_logits [N × N], diagonal zeroed (no self-loops)
        """
        proj = self.proj(node_embeddings)             # [N × D]
        logits = torch.matmul(proj, proj.T) / self.scale  # [N × N]
        # Zero diagonal — no self-loops
        mask = torch.eye(logits.size(0), device=logits.device, dtype=torch.bool)
        logits = logits.masked_fill(mask, 0.0)
        return logits
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd D:/pcgex-gnn && python -m pytest tests/test_topology_head.py -v
```
Expected: 5/5 PASS

- [ ] **Step 5: Commit**

```bash
cd D:/pcgex-gnn && git add src/models/topology_head.py tests/test_topology_head.py && git commit -m "feat: add topology head — pairwise dot product edge predictor"
```

---

## Task 4: Param Head

**Files:**
- Create: `D:/pcgex-gnn/src/models/param_head.py`
- Create: `D:/pcgex-gnn/tests/test_param_head.py`

- [ ] **Step 1: Write the failing tests**

```python
# D:/pcgex-gnn/tests/test_param_head.py
import torch
import pytest
from src.models.param_head import ParamHead, MAX_PARAMS

N = 4
EMBED_DIM = 256
TARGET_DIM = 128

def make_inputs(n=N):
    return torch.randn(n, EMBED_DIM), torch.randn(TARGET_DIM)

def test_output_shape():
    head = ParamHead(embed_dim=EMBED_DIM, target_spec_dim=TARGET_DIM)
    embeds, target = make_inputs()
    params = head(embeds, target)
    assert params.shape == (N, MAX_PARAMS)

def test_output_dtype():
    head = ParamHead(embed_dim=EMBED_DIM, target_spec_dim=TARGET_DIM)
    embeds, target = make_inputs()
    assert head(embeds, target).dtype == torch.float32

def test_single_node():
    head = ParamHead(embed_dim=EMBED_DIM, target_spec_dim=TARGET_DIM)
    params = head(torch.randn(1, EMBED_DIM), torch.randn(TARGET_DIM))
    assert params.shape == (1, MAX_PARAMS)

def test_different_target_specs_produce_different_params():
    head = ParamHead(embed_dim=EMBED_DIM, target_spec_dim=TARGET_DIM)
    head.eval()
    embeds = torch.randn(2, EMBED_DIM)
    t1, t2 = torch.randn(TARGET_DIM), torch.randn(TARGET_DIM)
    p1 = head(embeds, t1)
    p2 = head(embeds, t2)
    assert not torch.allclose(p1, p2)
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd D:/pcgex-gnn && python -m pytest tests/test_param_head.py -v 2>&1 | head -10
```
Expected: FAIL

- [ ] **Step 3: Implement param head**

```python
# D:/pcgex-gnn/src/models/param_head.py
"""
Param head: [node_embed | target_spec] → param_vector [MAX_PARAMS] per node

One shared MLP for all node types. The node embedding already encodes type information
from the GAT's learned type embedding, so a single head generalises across node families.
"""
from __future__ import annotations
import torch
import torch.nn as nn

MAX_PARAMS = 16   # matches processor.py MAX_PARAMS


class ParamHead(nn.Module):
    def __init__(self, embed_dim: int = 256, target_spec_dim: int = 128,
                 hidden_dim: int = 128):
        super().__init__()
        in_dim = embed_dim + target_spec_dim
        self.mlp = nn.Sequential(
            nn.Linear(in_dim, hidden_dim),
            nn.ReLU(),
            nn.Linear(hidden_dim, hidden_dim),
            nn.ReLU(),
            nn.Linear(hidden_dim, MAX_PARAMS),
        )

    def forward(self, node_embeddings: torch.Tensor,
                target_spec: torch.Tensor) -> torch.Tensor:
        """
        node_embeddings: [N × embed_dim]
        target_spec:     [target_spec_dim]
        returns: param_vectors [N × MAX_PARAMS]
        """
        N = node_embeddings.size(0)
        spec = target_spec.unsqueeze(0).expand(N, -1)   # [N × spec_dim]
        x = torch.cat([node_embeddings, spec], dim=-1)   # [N × (embed+spec)]
        return self.mlp(x)
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd D:/pcgex-gnn && python -m pytest tests/test_param_head.py -v
```
Expected: 4/4 PASS

- [ ] **Step 5: Commit**

```bash
cd D:/pcgex-gnn && git add src/models/param_head.py tests/test_param_head.py && git commit -m "feat: add param head — per-node parameter prediction MLP"
```

---

## Task 5: Expected State Head

**Files:**
- Create: `D:/pcgex-gnn/src/models/expected_state_head.py`
- Create: `D:/pcgex-gnn/tests/test_expected_state_head.py`

The expected state head predicts what each node's output table should look like. Output matches `_encode_stage_features` in `processor.py`: `[geom_type_logits(3), point_count(1), attr_count(1), runtime_ms(1)]` = 6 values total.

- [ ] **Step 1: Write the failing tests**

```python
# D:/pcgex-gnn/tests/test_expected_state_head.py
import torch
import pytest
from src.models.expected_state_head import ExpectedStateHead, STATE_FEATURE_DIM

N = 4
EMBED_DIM = 256

def test_output_shape():
    head = ExpectedStateHead(embed_dim=EMBED_DIM)
    embeds = torch.randn(N, EMBED_DIM)
    out = head(embeds)
    assert out.shape == (N, STATE_FEATURE_DIM)

def test_output_dtype():
    head = ExpectedStateHead(embed_dim=EMBED_DIM)
    assert head(torch.randn(N, EMBED_DIM)).dtype == torch.float32

def test_state_feature_dim_is_6():
    assert STATE_FEATURE_DIM == 6

def test_single_node():
    head = ExpectedStateHead(embed_dim=EMBED_DIM)
    out = head(torch.randn(1, EMBED_DIM))
    assert out.shape == (1, STATE_FEATURE_DIM)

def test_point_count_and_attr_count_non_negative():
    """Predicted point_count and attr_count should be non-negative (ReLU applied)."""
    head = ExpectedStateHead(embed_dim=EMBED_DIM)
    head.eval()
    out = head(torch.randn(20, EMBED_DIM))
    # Channels 3 (point_count) and 4 (attr_count) and 5 (runtime_ms) should be >= 0
    assert (out[:, 3] >= 0).all()
    assert (out[:, 4] >= 0).all()
    assert (out[:, 5] >= 0).all()
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd D:/pcgex-gnn && python -m pytest tests/test_expected_state_head.py -v 2>&1 | head -10
```
Expected: FAIL

- [ ] **Step 3: Implement expected state head**

```python
# D:/pcgex-gnn/src/models/expected_state_head.py
"""
Expected state head: node_embedding [N×D] → predicted output table features [N×6]

Output layout (matches processor._encode_stage_features):
  [0:3] geometry_type logits (softmax → probabilities for points/splines/unknown)
  [3]   predicted point_count (ReLU — non-negative, scaled by /1000)
  [4]   predicted attr_count  (ReLU — non-negative)
  [5]   predicted runtime_ms  (ReLU — non-negative)

During loss computation, channel 0:3 uses CrossEntropy against the observed
geometry type; channels 3-5 use SmoothL1 against observed values.
"""
from __future__ import annotations
import torch
import torch.nn as nn
import torch.nn.functional as F

STATE_FEATURE_DIM = 6  # geom_logits(3) + point_count(1) + attr_count(1) + runtime(1)


class ExpectedStateHead(nn.Module):
    def __init__(self, embed_dim: int = 256, hidden_dim: int = 128):
        super().__init__()
        self.mlp = nn.Sequential(
            nn.Linear(embed_dim, hidden_dim),
            nn.ReLU(),
            nn.Linear(hidden_dim, STATE_FEATURE_DIM),
        )

    def forward(self, node_embeddings: torch.Tensor) -> torch.Tensor:
        """
        node_embeddings: [N × embed_dim]
        returns: [N × STATE_FEATURE_DIM]
          - raw[:, 0:3] = geometry type logits (use softmax/cross-entropy at loss time)
          - raw[:, 3:]  = non-negative scalars (point_count, attr_count, runtime_ms)
        """
        raw = self.mlp(node_embeddings)                        # [N × 6]
        geom_logits = raw[:, :3]                               # left as logits for CE loss
        scalars = F.relu(raw[:, 3:])                           # non-negative
        return torch.cat([geom_logits, scalars], dim=-1)
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd D:/pcgex-gnn && python -m pytest tests/test_expected_state_head.py -v
```
Expected: 5/5 PASS

- [ ] **Step 5: Commit**

```bash
cd D:/pcgex-gnn && git add src/models/expected_state_head.py tests/test_expected_state_head.py && git commit -m "feat: add expected state head — per-node output table predictor"
```

---

## Task 6: Quality Scorer

**Files:**
- Create: `D:/pcgex-gnn/src/models/quality_scorer.py`
- Create: `D:/pcgex-gnn/tests/test_quality_scorer.py`

- [ ] **Step 1: Write the failing tests**

```python
# D:/pcgex-gnn/tests/test_quality_scorer.py
import torch
import pytest
from src.models.quality_scorer import QualityScorer

EMBED_DIM = 256

def test_output_shape_scalar():
    scorer = QualityScorer(embed_dim=EMBED_DIM)
    graph_embed = torch.randn(EMBED_DIM)
    score = scorer(graph_embed)
    assert score.shape == ()   # scalar

def test_output_in_zero_one():
    scorer = QualityScorer(embed_dim=EMBED_DIM)
    for _ in range(20):
        score = scorer(torch.randn(EMBED_DIM))
        assert 0.0 <= score.item() <= 1.0

def test_output_dtype_float32():
    scorer = QualityScorer(embed_dim=EMBED_DIM)
    assert scorer(torch.randn(EMBED_DIM)).dtype == torch.float32

def test_batch_input():
    scorer = QualityScorer(embed_dim=EMBED_DIM)
    batch = torch.randn(8, EMBED_DIM)
    scores = scorer(batch)
    assert scores.shape == (8,)
    assert (scores >= 0.0).all() and (scores <= 1.0).all()
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd D:/pcgex-gnn && python -m pytest tests/test_quality_scorer.py -v 2>&1 | head -10
```
Expected: FAIL

- [ ] **Step 3: Implement quality scorer**

```python
# D:/pcgex-gnn/src/models/quality_scorer.py
"""
Quality scorer: graph_embedding [D] or [B×D] → quality score [0,1] scalar or [B] vector.

Used during Phase 2+ training as the automated quantitative scorer.
Phase 1: score comes directly from human labels.
Phase 2+: this scorer provides pseudo-labels for unlabeled candidates in the search loop.
"""
from __future__ import annotations
import torch
import torch.nn as nn


class QualityScorer(nn.Module):
    def __init__(self, embed_dim: int = 256, hidden_dim: int = 64):
        super().__init__()
        self.mlp = nn.Sequential(
            nn.Linear(embed_dim, hidden_dim),
            nn.ReLU(),
            nn.Linear(hidden_dim, 1),
            nn.Sigmoid(),
        )

    def forward(self, graph_embedding: torch.Tensor) -> torch.Tensor:
        """
        graph_embedding: [D] or [B × D]
        returns: scalar or [B] vector of quality scores in [0, 1]
        """
        batched = graph_embedding.dim() == 2
        if not batched:
            graph_embedding = graph_embedding.unsqueeze(0)   # [1 × D]
        out = self.mlp(graph_embedding).squeeze(-1)           # [B]
        return out if batched else out.squeeze(0)             # scalar if unbatched
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd D:/pcgex-gnn && python -m pytest tests/test_quality_scorer.py -v
```
Expected: 4/4 PASS

- [ ] **Step 5: Commit**

```bash
cd D:/pcgex-gnn && git add src/models/quality_scorer.py tests/test_quality_scorer.py && git commit -m "feat: add quality scorer — graph embedding to quality score"
```

---

## Task 7: Full Model Assembly

**Files:**
- Create: `D:/pcgex-gnn/src/models/pcgex_model.py`
- Create: `D:/pcgex-gnn/tests/test_pcgex_model.py`

- [ ] **Step 1: Write the failing tests**

```python
# D:/pcgex-gnn/tests/test_pcgex_model.py
import torch
import pytest
from src.models.pcgex_model import PCGExModel, ModelOutputs
from src.models.gat_encoder import GAT_HIDDEN_DIM
from src.models.expected_state_head import STATE_FEATURE_DIM
from src.models.param_head import MAX_PARAMS

N = 4
INPUT_DIM = 18
TARGET_DIM = 128

def make_inputs(n=N):
    node_features = torch.randn(n, INPUT_DIM)
    adjacency = torch.zeros(n, n)
    adjacency[0, 1] = 1.0; adjacency[1, 2] = 1.0
    target_spec = torch.randn(TARGET_DIM)
    rag_context = torch.randn(3, GAT_HIDDEN_DIM)   # 3 retrieved graph embeddings
    return node_features, adjacency, target_spec, rag_context

def test_forward_returns_model_outputs():
    model = PCGExModel(input_dim=INPUT_DIM)
    nf, adj, ts, rag = make_inputs()
    out = model(nf, adj, ts, rag)
    assert isinstance(out, ModelOutputs)

def test_topology_logits_shape():
    model = PCGExModel(input_dim=INPUT_DIM)
    out = model(*make_inputs())
    assert out.topology_logits.shape == (N, N)

def test_param_predictions_shape():
    model = PCGExModel(input_dim=INPUT_DIM)
    out = model(*make_inputs())
    assert out.param_predictions.shape == (N, MAX_PARAMS)

def test_expected_states_shape():
    model = PCGExModel(input_dim=INPUT_DIM)
    out = model(*make_inputs())
    assert out.expected_states.shape == (N, STATE_FEATURE_DIM)

def test_quality_score_shape():
    model = PCGExModel(input_dim=INPUT_DIM)
    out = model(*make_inputs())
    assert out.quality_score.shape == ()   # scalar

def test_node_embeddings_shape():
    model = PCGExModel(input_dim=INPUT_DIM)
    out = model(*make_inputs())
    assert out.node_embeddings.shape == (N, GAT_HIDDEN_DIM)

def test_no_rag_context():
    """RAG context is optional — passing None should not crash."""
    model = PCGExModel(input_dim=INPUT_DIM)
    nf, adj, ts, _ = make_inputs()
    out = model(nf, adj, ts, rag_context=None)
    assert out.topology_logits.shape == (N, N)
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd D:/pcgex-gnn && python -m pytest tests/test_pcgex_model.py -v 2>&1 | head -10
```
Expected: FAIL

- [ ] **Step 3: Implement full model**

```python
# D:/pcgex-gnn/src/models/pcgex_model.py
"""
PCGExModel: full model assembly.

Forward pass:
  1. GATEncoder: node_features + target_spec → node_embeds, graph_embed
  2. Cross-attention with RAG context (optional)
  3. TopologyHead: node_embeds → edge_logits
  4. ParamHead: node_embeds + target_spec → param_predictions
  5. ExpectedStateHead: node_embeds → expected_states
  6. QualityScorer: graph_embed → quality_score
"""
from __future__ import annotations
from dataclasses import dataclass
from typing import Optional

import torch
import torch.nn as nn
import torch.nn.functional as F

from src.models.gat_encoder import GATEncoder, GAT_HIDDEN_DIM
from src.models.topology_head import TopologyHead
from src.models.param_head import ParamHead
from src.models.expected_state_head import ExpectedStateHead
from src.models.quality_scorer import QualityScorer


@dataclass
class ModelOutputs:
    topology_logits: torch.Tensor      # [N × N] — apply sigmoid for edge probs
    param_predictions: torch.Tensor    # [N × MAX_PARAMS]
    expected_states: torch.Tensor      # [N × STATE_FEATURE_DIM]
    quality_score: torch.Tensor        # scalar
    node_embeddings: torch.Tensor      # [N × GAT_HIDDEN_DIM]
    graph_embedding: torch.Tensor      # [GAT_HIDDEN_DIM]


class RAGCrossAttention(nn.Module):
    """Single-head cross-attention: node_embeds attend to RAG graph embeddings."""

    def __init__(self, dim: int = GAT_HIDDEN_DIM):
        super().__init__()
        self.q = nn.Linear(dim, dim, bias=False)
        self.k = nn.Linear(dim, dim, bias=False)
        self.v = nn.Linear(dim, dim, bias=False)
        self.scale = dim ** -0.5
        self.norm = nn.LayerNorm(dim)

    def forward(self, node_embeds: torch.Tensor,
                rag_context: torch.Tensor) -> torch.Tensor:
        """
        node_embeds: [N × D]
        rag_context: [K × D]
        returns: [N × D] — nodes enriched by attending to retrieved graphs
        """
        Q = self.q(node_embeds)                                    # [N × D]
        K = self.k(rag_context)                                    # [K × D]
        V = self.v(rag_context)                                    # [K × D]
        scores = torch.matmul(Q, K.T) * self.scale                # [N × K]
        weights = F.softmax(scores, dim=-1)
        attended = torch.matmul(weights, V)                        # [N × D]
        return self.norm(node_embeds + attended)                   # residual


class PCGExModel(nn.Module):
    def __init__(self, input_dim: int = 18, target_spec_dim: int = 128):
        super().__init__()
        self.encoder = GATEncoder(input_dim=input_dim, target_spec_dim=target_spec_dim)
        self.rag_attention = RAGCrossAttention(dim=GAT_HIDDEN_DIM)
        self.topology_head = TopologyHead(embed_dim=GAT_HIDDEN_DIM)
        self.param_head = ParamHead(embed_dim=GAT_HIDDEN_DIM, target_spec_dim=target_spec_dim)
        self.state_head = ExpectedStateHead(embed_dim=GAT_HIDDEN_DIM)
        self.quality_scorer = QualityScorer(embed_dim=GAT_HIDDEN_DIM)

    def forward(self,
                node_features: torch.Tensor,
                adjacency: torch.Tensor,
                target_spec: torch.Tensor,
                rag_context: Optional[torch.Tensor] = None) -> ModelOutputs:
        """
        node_features: [N × input_dim]
        adjacency:     [N × N]
        target_spec:   [TARGET_SPEC_DIM]
        rag_context:   [K × GAT_HIDDEN_DIM] or None
        """
        node_embeds, graph_embed = self.encoder(node_features, adjacency, target_spec)

        if rag_context is not None and rag_context.size(0) > 0:
            node_embeds = self.rag_attention(node_embeds, rag_context)
            graph_embed = node_embeds.mean(dim=0)

        return ModelOutputs(
            topology_logits=self.topology_head(node_embeds),
            param_predictions=self.param_head(node_embeds, target_spec),
            expected_states=self.state_head(node_embeds),
            quality_score=self.quality_scorer(graph_embed),
            node_embeddings=node_embeds,
            graph_embedding=graph_embed,
        )
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd D:/pcgex-gnn && python -m pytest tests/test_pcgex_model.py -v
```
Expected: 7/7 PASS

- [ ] **Step 5: Commit**

```bash
cd D:/pcgex-gnn && git add src/models/pcgex_model.py tests/test_pcgex_model.py && git commit -m "feat: add full PCGExModel assembly with RAG cross-attention"
```

---

## Task 8: RAG Embedder

**Files:**
- Create: `D:/pcgex-gnn/src/rag/embedder.py`
- Create: `D:/pcgex-gnn/tests/test_embedder.py`

- [ ] **Step 1: Write the failing tests**

```python
# D:/pcgex-gnn/tests/test_embedder.py
import torch
import pytest
from src.rag.embedder import GraphEmbedder
from src.models.gat_encoder import GAT_HIDDEN_DIM

SAMPLE_GRAPH = {
    "nodes": [
        {"id": "n0", "class": "PCGExSampleNearestPoint",
         "params": {"MaxPointsPerQuery": 8, "SearchRadius": 500.0},
         "position": {"x": 0, "y": 0}},
        {"id": "n1", "class": "PCGExCluster",
         "params": {"MinClusterSize": 3, "MaxClusterSize": 20},
         "position": {"x": 250, "y": 0}},
    ],
    "edges": [
        {"from_node": "n0", "from_pin": "Out", "to_node": "n1", "to_pin": "In"}
    ],
    "domain": "foliage",
}

def test_embed_returns_tensor():
    embedder = GraphEmbedder()
    vec = embedder.embed(SAMPLE_GRAPH)
    assert isinstance(vec, torch.Tensor)

def test_embed_correct_shape():
    embedder = GraphEmbedder()
    vec = embedder.embed(SAMPLE_GRAPH)
    assert vec.shape == (GAT_HIDDEN_DIM,)

def test_embed_dtype_float32():
    embedder = GraphEmbedder()
    assert embedder.embed(SAMPLE_GRAPH).dtype == torch.float32

def test_embed_batch():
    embedder = GraphEmbedder()
    graphs = [SAMPLE_GRAPH, SAMPLE_GRAPH]
    vecs = embedder.embed_batch(graphs)
    assert vecs.shape == (2, GAT_HIDDEN_DIM)

def test_same_graph_same_embedding_in_eval():
    """In eval mode, same graph produces identical embedding."""
    embedder = GraphEmbedder()
    embedder.eval()
    v1 = embedder.embed(SAMPLE_GRAPH)
    v2 = embedder.embed(SAMPLE_GRAPH)
    assert torch.allclose(v1, v2)
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd D:/pcgex-gnn && python -m pytest tests/test_embedder.py -v 2>&1 | head -10
```
Expected: FAIL

- [ ] **Step 3: Implement RAG embedder**

```python
# D:/pcgex-gnn/src/rag/embedder.py
"""
GraphEmbedder: converts a graph dict → 256-dim embedding vector.

Uses GATEncoder with a neutral target spec (all zeros). During RAG retrieval,
embeddings from the KB are compared against a query embedding derived from the
current intent+sketch. The GATEncoder weights are frozen after Phase 1.
"""
from __future__ import annotations
import torch
from src.models.gat_encoder import GATEncoder, GAT_HIDDEN_DIM
from src.models.target_spec import TARGET_SPEC_DIM
from src.data.processor import process_sample
import tempfile
import json
from pathlib import Path


def _graph_to_processed(graph: dict):
    """Convert a graph dict to a ProcessedSample using the existing processor."""
    # Write to a temp dir so process_sample can read it
    with tempfile.TemporaryDirectory() as tmpdir:
        d = Path(tmpdir)
        (d / "graph.json").write_text(json.dumps(graph))
        (d / "stage_outputs.json").write_text(json.dumps({}))
        (d / "meta.json").write_text(json.dumps({"domain": graph.get("domain", "unknown"),
                                                  "source": "rag", "mutations_applied": []}))
        (d / "runtime.json").write_text(json.dumps({"total_ms": 0.0,
                                                     "per_node_ms": {}, "normalized_ms": 0.0}))
        return process_sample(d)


class GraphEmbedder(torch.nn.Module):
    """Wraps GATEncoder to produce graph-level 256-dim embeddings."""

    def __init__(self, input_dim: int = 18, target_spec_dim: int = TARGET_SPEC_DIM):
        super().__init__()
        self.encoder = GATEncoder(input_dim=input_dim, target_spec_dim=target_spec_dim)
        # Neutral target spec for embedding (used when no goal context available)
        self.register_buffer("_neutral_spec",
                             torch.zeros(target_spec_dim, dtype=torch.float32))

    @torch.no_grad()
    def embed(self, graph: dict) -> torch.Tensor:
        """Convert one graph dict → [GAT_HIDDEN_DIM] embedding."""
        sample = _graph_to_processed(graph)
        _, graph_embed = self.encoder(
            sample.node_features,
            sample.adjacency,
            self._neutral_spec,
        )
        return graph_embed

    @torch.no_grad()
    def embed_batch(self, graphs: list[dict]) -> torch.Tensor:
        """Convert list of graph dicts → [B × GAT_HIDDEN_DIM]."""
        return torch.stack([self.embed(g) for g in graphs])

    def freeze(self) -> None:
        """Freeze encoder weights after Phase 1 training."""
        for p in self.encoder.parameters():
            p.requires_grad_(False)

    def unfreeze(self) -> None:
        for p in self.encoder.parameters():
            p.requires_grad_(True)
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd D:/pcgex-gnn && python -m pytest tests/test_embedder.py -v
```
Expected: 5/5 PASS

- [ ] **Step 5: Commit**

```bash
cd D:/pcgex-gnn && git add src/rag/embedder.py tests/test_embedder.py && git commit -m "feat: add RAG graph embedder using frozen GAT encoder"
```

---

## Task 9: RAG Knowledge Base

**Files:**
- Create: `D:/pcgex-gnn/src/rag/kb.py`
- Create: `D:/pcgex-gnn/tests/test_kb.py`

- [ ] **Step 1: Write the failing tests**

```python
# D:/pcgex-gnn/tests/test_kb.py
import json
import tempfile
import torch
import pytest
from pathlib import Path
from src.rag.kb import KnowledgeBase
from src.models.gat_encoder import GAT_HIDDEN_DIM

def make_embed(seed: int) -> torch.Tensor:
    torch.manual_seed(seed)
    return torch.randn(GAT_HIDDEN_DIM)

def test_insert_and_size():
    kb = KnowledgeBase()
    assert kb.size() == 0
    kb.insert("s1", make_embed(0), domain="foliage", metadata={"quality": 1.0})
    assert kb.size() == 1

def test_query_returns_top_k():
    kb = KnowledgeBase()
    for i in range(5):
        kb.insert(f"s{i}", make_embed(i), domain="foliage")
    query = make_embed(0)   # should be most similar to s0
    results = kb.query(query, k=3)
    assert len(results) == 3
    assert results[0]["sample_id"] == "s0"

def test_query_returns_similarity_scores():
    kb = KnowledgeBase()
    kb.insert("s0", make_embed(0), domain="foliage")
    results = kb.query(make_embed(0), k=1)
    assert "similarity" in results[0]
    assert results[0]["similarity"] == pytest.approx(1.0, abs=1e-5)

def test_query_domain_filter():
    kb = KnowledgeBase()
    kb.insert("f1", make_embed(0), domain="foliage")
    kb.insert("r1", make_embed(1), domain="roads")
    results = kb.query(make_embed(0), k=5, domain_filter="foliage")
    assert all(r["domain"] == "foliage" for r in results)

def test_persist_and_reload(tmp_path):
    kb = KnowledgeBase()
    kb.insert("s0", make_embed(0), domain="foliage", metadata={"quality": 1.0})
    path = str(tmp_path / "kb.json")
    kb.save(path)
    kb2 = KnowledgeBase.load(path)
    assert kb2.size() == 1
    results = kb2.query(make_embed(0), k=1)
    assert results[0]["sample_id"] == "s0"

def test_duplicate_insert_overwrites():
    kb = KnowledgeBase()
    kb.insert("s0", make_embed(0), domain="foliage")
    kb.insert("s0", make_embed(1), domain="roads")  # same id, different embed
    assert kb.size() == 1
    assert kb._entries["s0"]["domain"] == "roads"
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd D:/pcgex-gnn && python -m pytest tests/test_kb.py -v 2>&1 | head -10
```
Expected: FAIL

- [ ] **Step 3: Implement knowledge base**

```python
# D:/pcgex-gnn/src/rag/kb.py
"""
KnowledgeBase: stores graph embeddings for RAG retrieval.

Each entry: { sample_id, embedding [GAT_HIDDEN_DIM], domain, metadata }
Query: cosine similarity search, optional domain filter, returns top-K entries.
Persistence: serialize embeddings as lists in JSON (human-readable, portable).
"""
from __future__ import annotations
import json
from pathlib import Path
from typing import Optional
import torch
import torch.nn.functional as F


class KnowledgeBase:
    def __init__(self):
        # _entries: sample_id → { embedding: Tensor, domain: str, metadata: dict }
        self._entries: dict[str, dict] = {}

    def size(self) -> int:
        return len(self._entries)

    def insert(self, sample_id: str, embedding: torch.Tensor,
               domain: str = "unknown", metadata: Optional[dict] = None) -> None:
        """Insert or overwrite an entry."""
        self._entries[sample_id] = {
            "embedding": embedding.detach().clone(),
            "domain": domain,
            "metadata": metadata or {},
        }

    def query(self, query_embedding: torch.Tensor, k: int = 5,
              domain_filter: Optional[str] = None) -> list[dict]:
        """
        Return top-k entries by cosine similarity.
        Each result: { sample_id, similarity, domain, metadata }
        """
        candidates = {
            sid: entry for sid, entry in self._entries.items()
            if domain_filter is None or entry["domain"] == domain_filter
        }
        if not candidates:
            return []

        ids = list(candidates.keys())
        embeds = torch.stack([candidates[sid]["embedding"] for sid in ids])  # [M × D]
        q = F.normalize(query_embedding.unsqueeze(0), dim=-1)                # [1 × D]
        e = F.normalize(embeds, dim=-1)                                       # [M × D]
        sims = (q @ e.T).squeeze(0)                                           # [M]

        k = min(k, len(ids))
        top_k_idx = sims.topk(k).indices.tolist()

        return [
            {
                "sample_id": ids[i],
                "similarity": sims[i].item(),
                "domain": candidates[ids[i]]["domain"],
                "metadata": candidates[ids[i]]["metadata"],
            }
            for i in top_k_idx
        ]

    def get_embeddings_tensor(self, domain_filter: Optional[str] = None) -> torch.Tensor:
        """Return all embeddings as [M × D] tensor, optionally filtered by domain."""
        entries = [e for e in self._entries.values()
                   if domain_filter is None or e["domain"] == domain_filter]
        if not entries:
            return torch.zeros(0, next(iter(self._entries.values()))["embedding"].shape[0]
                               if self._entries else 256)
        return torch.stack([e["embedding"] for e in entries])

    def save(self, path: str) -> None:
        """Persist to JSON."""
        data = {}
        for sid, entry in self._entries.items():
            data[sid] = {
                "embedding": entry["embedding"].tolist(),
                "domain": entry["domain"],
                "metadata": entry["metadata"],
            }
        Path(path).write_text(json.dumps(data, indent=2))

    @classmethod
    def load(cls, path: str) -> "KnowledgeBase":
        """Load from JSON."""
        kb = cls()
        raw = json.loads(Path(path).read_text())
        for sid, entry in raw.items():
            kb._entries[sid] = {
                "embedding": torch.tensor(entry["embedding"], dtype=torch.float32),
                "domain": entry["domain"],
                "metadata": entry.get("metadata", {}),
            }
        return kb
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd D:/pcgex-gnn && python -m pytest tests/test_kb.py -v
```
Expected: 6/6 PASS

- [ ] **Step 5: Commit**

```bash
cd D:/pcgex-gnn && git add src/rag/kb.py tests/test_kb.py && git commit -m "feat: add RAG knowledge base with cosine similarity search"
```

---

## Task 10: Loss Functions

**Files:**
- Create: `D:/pcgex-gnn/src/training/__init__.py`
- Create: `D:/pcgex-gnn/src/training/losses.py`
- Create: `D:/pcgex-gnn/tests/test_losses.py`

- [ ] **Step 1: Write the failing tests**

```python
# D:/pcgex-gnn/tests/test_losses.py
import torch
import pytest
from src.training.losses import (
    topology_loss, param_loss, quality_loss, state_loss, runtime_loss,
)

N = 4

def test_topology_loss_shape():
    pred = torch.randn(N, N)
    true = (torch.rand(N, N) > 0.5).float()
    loss = topology_loss(pred, true)
    assert loss.shape == ()   # scalar

def test_topology_loss_zero_when_perfect():
    logits = torch.full((N, N), 10.0)  # high logits → sigmoid ≈ 1
    true = torch.ones(N, N)
    loss = topology_loss(logits, true)
    assert loss.item() < 0.1

def test_param_loss_scalar():
    pred = torch.randn(N, 16)
    true = torch.randn(N, 16)
    loss = param_loss(pred, true)
    assert loss.shape == ()

def test_quality_loss_scalar():
    # quality_loss: CrossEntropy over 3 classes (Bad=0, Interesting=1, Good=2)
    pred_logits = torch.randn(4, 3)    # batch of 4 quality predictions
    true_labels = torch.tensor([0, 1, 2, 0])
    loss = quality_loss(pred_logits, true_labels)
    assert loss.shape == ()

def test_state_loss_scalar():
    pred = torch.randn(N, 6)
    true = torch.randn(N, 6)
    loss = state_loss(pred, true)
    assert loss.shape == ()

def test_runtime_loss_zero_under_budget():
    norm_ms = torch.tensor(30.0)
    budget_ms = 50.0
    loss = runtime_loss(norm_ms, budget_ms)
    assert loss.item() == pytest.approx(0.0)

def test_runtime_loss_positive_over_budget():
    norm_ms = torch.tensor(80.0)
    budget_ms = 50.0
    loss = runtime_loss(norm_ms, budget_ms)
    assert loss.item() > 0.0

def test_runtime_loss_scales_linearly_over_budget():
    loss_60 = runtime_loss(torch.tensor(60.0), 50.0)
    loss_70 = runtime_loss(torch.tensor(70.0), 50.0)
    # 70ms over budget by 20; 60ms over budget by 10 → ratio should be ~2
    assert loss_70.item() / loss_60.item() == pytest.approx(2.0, abs=0.01)
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd D:/pcgex-gnn && python -m pytest tests/test_losses.py -v 2>&1 | head -10
```
Expected: FAIL

- [ ] **Step 3: Create package marker and implement losses**

```python
# D:/pcgex-gnn/src/training/__init__.py
```

```python
# D:/pcgex-gnn/src/training/losses.py
"""
Loss functions for PCGEx GNN training.

Phase 1: topology_loss + param_loss + quality_loss + state_loss
Phase 2: adds runtime_loss

Default weights (overridable in train.py):
  λ_topology=1.0, λ_params=1.0, λ_quality=0.5, λ_state=1.5, λ_runtime=0.8
"""
from __future__ import annotations
import torch
import torch.nn.functional as F


def topology_loss(pred_logits: torch.Tensor, true_adj: torch.Tensor) -> torch.Tensor:
    """
    BCE loss between predicted edge logits and true adjacency matrix.
    pred_logits: [N × N] raw logits (before sigmoid)
    true_adj:    [N × N] binary float (1 = edge exists)
    """
    return F.binary_cross_entropy_with_logits(pred_logits, true_adj)


def param_loss(pred_params: torch.Tensor, true_params: torch.Tensor) -> torch.Tensor:
    """
    SmoothL1 loss between predicted and true parameter vectors.
    pred_params: [N × MAX_PARAMS]
    true_params: [N × MAX_PARAMS]
    """
    return F.smooth_l1_loss(pred_params, true_params)


def quality_loss(pred_logits: torch.Tensor, true_labels: torch.Tensor) -> torch.Tensor:
    """
    CrossEntropy over 3 quality classes: Bad=0, Interesting=1, Good=2.
    pred_logits: [B × 3] — raw logits for each class
    true_labels: [B] — int64 class indices
    """
    return F.cross_entropy(pred_logits, true_labels)


def state_loss(pred_states: torch.Tensor, true_states: torch.Tensor) -> torch.Tensor:
    """
    SmoothL1 between predicted and actual output table features.
    pred_states: [N × STATE_FEATURE_DIM]
    true_states: [N × STATE_FEATURE_DIM]

    Note: geometry type channels (0:3) are treated as raw values here.
    A separate CE loss for geometry type classification can be computed by the
    training loop if needed, by slicing channels 0:3.
    """
    return F.smooth_l1_loss(pred_states, true_states)


def runtime_loss(normalized_runtime_ms: torch.Tensor, domain_budget_ms: float) -> torch.Tensor:
    """
    Penalizes graphs that exceed the domain runtime budget.
    normalized_runtime_ms: scalar — ms per 1000 output points
    domain_budget_ms: float — per-domain budget threshold

    Loss = ReLU(normalized_ms - budget) / budget
    Zero when under budget; scales linearly above budget.
    """
    over = F.relu(normalized_runtime_ms - domain_budget_ms)
    return over / domain_budget_ms


def total_loss(
    topology_logits: torch.Tensor, true_adj: torch.Tensor,
    pred_params: torch.Tensor, true_params: torch.Tensor,
    quality_logits: torch.Tensor, quality_labels: torch.Tensor,
    pred_states: torch.Tensor, true_states: torch.Tensor,
    normalized_runtime_ms: torch.Tensor, domain_budget_ms: float,
    phase: int,
    lam_topology: float = 1.0, lam_params: float = 1.0,
    lam_quality: float = 0.5, lam_state: float = 1.5,
    lam_runtime: float = 0.8,
) -> torch.Tensor:
    """
    Combined loss. Phase 1: no runtime term. Phase 2+: all terms.
    """
    loss = (
        lam_topology * topology_loss(topology_logits, true_adj)
        + lam_params  * param_loss(pred_params, true_params)
        + lam_quality * quality_loss(quality_logits, quality_labels)
        + lam_state   * state_loss(pred_states, true_states)
    )
    if phase >= 2:
        loss = loss + lam_runtime * runtime_loss(normalized_runtime_ms, domain_budget_ms)
    return loss
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd D:/pcgex-gnn && python -m pytest tests/test_losses.py -v
```
Expected: 9/9 PASS

- [ ] **Step 5: Commit**

```bash
cd D:/pcgex-gnn && git add src/training/__init__.py src/training/losses.py tests/test_losses.py && git commit -m "feat: add loss functions — topology BCE, param SmoothL1, quality CE, state, runtime"
```

---

## Task 11: Evaluation Metrics

**Files:**
- Create: `D:/pcgex-gnn/src/training/evaluate.py`
- Create: `D:/pcgex-gnn/tests/test_evaluate.py`

- [ ] **Step 1: Write the failing tests**

```python
# D:/pcgex-gnn/tests/test_evaluate.py
import torch
import pytest
from src.training.evaluate import topology_f1, param_mae, state_divergence

N = 4

def test_topology_f1_perfect():
    adj = torch.zeros(N, N); adj[0, 1] = 1.0; adj[1, 2] = 1.0
    logits = adj * 10.0 - (1 - adj) * 10.0   # high for edges, low for non-edges
    f1 = topology_f1(logits, adj)
    assert f1 == pytest.approx(1.0, abs=0.01)

def test_topology_f1_zero_edges_predicted():
    adj = torch.zeros(N, N); adj[0, 1] = 1.0
    logits = torch.full((N, N), -10.0)
    f1 = topology_f1(logits, adj)
    assert f1 == pytest.approx(0.0, abs=0.01)

def test_topology_f1_in_zero_one():
    logits = torch.randn(N, N)
    adj = (torch.rand(N, N) > 0.7).float()
    f1 = topology_f1(logits, adj)
    assert 0.0 <= f1 <= 1.0

def test_param_mae_perfect():
    params = torch.randn(N, 16)
    mae = param_mae(params, params)
    assert mae == pytest.approx(0.0, abs=1e-5)

def test_param_mae_positive():
    pred = torch.zeros(N, 16)
    true = torch.ones(N, 16)
    mae = param_mae(pred, true)
    assert mae == pytest.approx(1.0, abs=1e-5)

def test_state_divergence_zero_when_identical():
    states = torch.randn(N, 6)
    div = state_divergence(states, states)
    assert div == pytest.approx(0.0, abs=1e-5)

def test_state_divergence_positive_when_different():
    pred = torch.randn(N, 6)
    true = torch.randn(N, 6)
    div = state_divergence(pred, true)
    assert div > 0.0
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd D:/pcgex-gnn && python -m pytest tests/test_evaluate.py -v 2>&1 | head -10
```
Expected: FAIL

- [ ] **Step 3: Implement evaluation metrics**

```python
# D:/pcgex-gnn/src/training/evaluate.py
"""
Evaluation metrics for PCGEx GNN.

topology_f1:      F1 score for edge prediction (threshold at 0.5)
param_mae:        Mean absolute error over predicted vs true params
state_divergence: Mean relative divergence between predicted and actual output states
"""
from __future__ import annotations
import torch
import torch.nn.functional as F


def topology_f1(pred_logits: torch.Tensor, true_adj: torch.Tensor,
                threshold: float = 0.5) -> float:
    """
    F1 score for edge prediction.
    pred_logits: [N × N] raw logits
    true_adj:    [N × N] binary float
    """
    pred_binary = (torch.sigmoid(pred_logits) >= threshold).float()
    true_binary = (true_adj >= threshold).float()

    tp = (pred_binary * true_binary).sum().item()
    fp = (pred_binary * (1 - true_binary)).sum().item()
    fn = ((1 - pred_binary) * true_binary).sum().item()

    precision = tp / (tp + fp + 1e-8)
    recall = tp / (tp + fn + 1e-8)
    f1 = 2 * precision * recall / (precision + recall + 1e-8)
    return float(f1)


def param_mae(pred_params: torch.Tensor, true_params: torch.Tensor) -> float:
    """Mean absolute error over all predicted param values."""
    return F.l1_loss(pred_params, true_params).item()


def state_divergence(pred_states: torch.Tensor, true_states: torch.Tensor) -> float:
    """
    Mean relative divergence: ||pred - true|| / (||true|| + 1e-8), averaged over nodes.
    Matches the threshold used in the debug loop (divergence < 0.15 → ok).
    """
    norms = true_states.norm(dim=-1, keepdim=True) + 1e-8          # [N × 1]
    rel_diff = (pred_states - true_states).norm(dim=-1, keepdim=True) / norms
    return rel_diff.mean().item()
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd D:/pcgex-gnn && python -m pytest tests/test_evaluate.py -v
```
Expected: 7/7 PASS

- [ ] **Step 5: Commit**

```bash
cd D:/pcgex-gnn && git add src/training/evaluate.py tests/test_evaluate.py && git commit -m "feat: add evaluation metrics — topology F1, param MAE, state divergence"
```

---

## Task 12: Phase-Aware Training Loop

**Files:**
- Create: `D:/pcgex-gnn/src/training/train.py`
- Create: `D:/pcgex-gnn/tests/test_train.py`

- [ ] **Step 1: Write the failing tests**

```python
# D:/pcgex-gnn/tests/test_train.py
"""
Smoke tests for the training loop. Verify that training runs without error
and that loss decreases over a small number of steps on synthetic data.
"""
import json
import torch
import pytest
from pathlib import Path
from src.models.pcgex_model import PCGExModel
from src.models.target_spec import encode_target_spec
from src.training.train import TrainConfig, Trainer, TrainBatch

N_NODES = 3
INPUT_DIM = 18
TARGET_DIM = 128

def make_batch() -> TrainBatch:
    """Synthetic training batch with 1 sample."""
    return TrainBatch(
        node_features=torch.randn(N_NODES, INPUT_DIM),
        adjacency=torch.zeros(N_NODES, N_NODES),
        target_spec=torch.randn(TARGET_DIM),
        rag_context=torch.randn(2, 256),
        true_adj=torch.zeros(N_NODES, N_NODES),
        true_params=torch.randn(N_NODES, 16),
        quality_label=torch.tensor(2),         # Good
        true_states=torch.randn(N_NODES, 6),
        normalized_runtime_ms=torch.tensor(30.0),
        domain_budget_ms=50.0,
    )

def test_trainer_phase1_step_runs():
    model = PCGExModel(input_dim=INPUT_DIM)
    config = TrainConfig(phase=1, lr=1e-3)
    trainer = Trainer(model, config)
    batch = make_batch()
    loss = trainer.step(batch)
    assert isinstance(loss, float)
    assert loss > 0.0

def test_trainer_phase2_step_runs():
    model = PCGExModel(input_dim=INPUT_DIM)
    config = TrainConfig(phase=2, lr=1e-3)
    trainer = Trainer(model, config)
    batch = make_batch()
    loss = trainer.step(batch)
    assert isinstance(loss, float)
    assert loss > 0.0

def test_loss_decreases_over_steps():
    """Loss should trend downward over 50 steps on the same batch (overfit check)."""
    torch.manual_seed(42)
    model = PCGExModel(input_dim=INPUT_DIM)
    config = TrainConfig(phase=1, lr=1e-2)
    trainer = Trainer(model, config)
    batch = make_batch()

    losses = [trainer.step(batch) for _ in range(50)]
    # Compare first 10 vs last 10
    assert sum(losses[:10]) > sum(losses[-10:]), "Loss should decrease over 50 steps"

def test_trainer_saves_and_loads_checkpoint(tmp_path):
    model = PCGExModel(input_dim=INPUT_DIM)
    config = TrainConfig(phase=1, lr=1e-3)
    trainer = Trainer(model, config)
    trainer.step(make_batch())

    ckpt_path = str(tmp_path / "checkpoint.pt")
    trainer.save_checkpoint(ckpt_path)

    model2 = PCGExModel(input_dim=INPUT_DIM)
    trainer2 = Trainer(model2, config)
    trainer2.load_checkpoint(ckpt_path)

    # Both models should produce identical output after loading
    model.eval(); model2.eval()
    batch = make_batch()
    with torch.no_grad():
        out1 = model(batch.node_features, batch.adjacency, batch.target_spec)
        out2 = model2(batch.node_features, batch.adjacency, batch.target_spec)
    assert torch.allclose(out1.quality_score, out2.quality_score)
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd D:/pcgex-gnn && python -m pytest tests/test_train.py -v 2>&1 | head -10
```
Expected: FAIL

- [ ] **Step 3: Implement training loop**

```python
# D:/pcgex-gnn/src/training/train.py
"""
Phase-aware training loop for PCGExModel.

Phase 1 (Bootstrap): topology + params + quality + state losses
Phase 2+ (Joint):    + runtime loss
Phase 3 (Finetune):  freeze encoder, train heads only

Usage:
  model = PCGExModel()
  trainer = Trainer(model, TrainConfig(phase=1, lr=1e-3))
  for batch in dataloader:
      loss = trainer.step(batch)
"""
from __future__ import annotations
from dataclasses import dataclass, field
from typing import Optional

import torch
import torch.optim as optim

from src.models.pcgex_model import PCGExModel
from src.training.losses import total_loss
from src.training.evaluate import topology_f1, param_mae, state_divergence


@dataclass
class TrainConfig:
    phase: int = 1
    lr: float = 1e-3
    weight_decay: float = 1e-4
    lam_topology: float = 1.0
    lam_params: float = 1.0
    lam_quality: float = 0.5
    lam_state: float = 1.5
    lam_runtime: float = 0.8
    # Quality head: 3-class logits output (Bad/Interesting/Good)
    # quality_label is int (0/1/2); model.quality_scorer outputs scalar [0,1]
    # We use a separate 3-class quality head for CE loss — see QualityHead below


@dataclass
class TrainBatch:
    node_features: torch.Tensor      # [N × 18]
    adjacency: torch.Tensor          # [N × N]
    target_spec: torch.Tensor        # [128]
    rag_context: Optional[torch.Tensor]  # [K × 256] or None
    true_adj: torch.Tensor           # [N × N]
    true_params: torch.Tensor        # [N × 16]
    quality_label: torch.Tensor      # scalar int64 (0=Bad, 1=Interesting, 2=Good)
    true_states: torch.Tensor        # [N × 6]
    normalized_runtime_ms: torch.Tensor  # scalar float
    domain_budget_ms: float


class Trainer:
    """Wraps model + optimizer + loss computation for one training step."""

    def __init__(self, model: PCGExModel, config: TrainConfig):
        self.model = model
        self.config = config
        # Separate 3-class quality head (MLP on graph embedding → 3 logits)
        embed_dim = 256
        self.quality_head = torch.nn.Sequential(
            torch.nn.Linear(embed_dim, 64),
            torch.nn.ReLU(),
            torch.nn.Linear(64, 3),
        )

        all_params = list(model.parameters()) + list(self.quality_head.parameters())

        # Phase 3: freeze encoder, train heads only
        if config.phase >= 3:
            model.encoder.requires_grad_(False)
            all_params = [p for p in all_params if p.requires_grad]

        self.optimizer = optim.Adam(all_params, lr=config.lr,
                                    weight_decay=config.weight_decay)

    def step(self, batch: TrainBatch) -> float:
        """Run one forward+backward step. Returns loss value as float."""
        self.model.train()
        self.quality_head.train()
        self.optimizer.zero_grad()

        outputs = self.model(
            batch.node_features,
            batch.adjacency,
            batch.target_spec,
            batch.rag_context,
        )

        # Quality CE loss: quality_head on graph_embedding → 3 logits
        quality_logits = self.quality_head(outputs.graph_embedding).unsqueeze(0)  # [1 × 3]
        quality_labels = batch.quality_label.unsqueeze(0)                          # [1]

        loss = total_loss(
            topology_logits=outputs.topology_logits,
            true_adj=batch.true_adj,
            pred_params=outputs.param_predictions,
            true_params=batch.true_params,
            quality_logits=quality_logits,
            quality_labels=quality_labels,
            pred_states=outputs.expected_states,
            true_states=batch.true_states,
            normalized_runtime_ms=batch.normalized_runtime_ms,
            domain_budget_ms=batch.domain_budget_ms,
            phase=self.config.phase,
            lam_topology=self.config.lam_topology,
            lam_params=self.config.lam_params,
            lam_quality=self.config.lam_quality,
            lam_state=self.config.lam_state,
            lam_runtime=self.config.lam_runtime,
        )

        loss.backward()
        self.optimizer.step()
        return loss.item()

    def evaluate(self, batch: TrainBatch) -> dict:
        """Compute evaluation metrics on one batch (no gradient)."""
        self.model.eval()
        with torch.no_grad():
            outputs = self.model(
                batch.node_features, batch.adjacency,
                batch.target_spec, batch.rag_context,
            )
        return {
            "topology_f1": topology_f1(outputs.topology_logits, batch.true_adj),
            "param_mae": param_mae(outputs.param_predictions, batch.true_params),
            "state_divergence": state_divergence(outputs.expected_states, batch.true_states),
            "quality_score": outputs.quality_score.item(),
        }

    def save_checkpoint(self, path: str) -> None:
        torch.save({
            "model_state": self.model.state_dict(),
            "quality_head_state": self.quality_head.state_dict(),
            "optimizer_state": self.optimizer.state_dict(),
            "phase": self.config.phase,
        }, path)

    def load_checkpoint(self, path: str) -> None:
        ckpt = torch.load(path, map_location="cpu")
        self.model.load_state_dict(ckpt["model_state"])
        self.quality_head.load_state_dict(ckpt["quality_head_state"])
        self.optimizer.load_state_dict(ckpt["optimizer_state"])
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd D:/pcgex-gnn && python -m pytest tests/test_train.py -v
```
Expected: 4/4 PASS

If `test_loss_decreases_over_steps` fails intermittently (random seed sensitivity), run again with `--count=3` to confirm it's flaky, then tighten the seed.

- [ ] **Step 5: Commit**

```bash
cd D:/pcgex-gnn && git add src/training/train.py tests/test_train.py && git commit -m "feat: add phase-aware training loop with checkpoint save/load"
```

---

## Final Integration Check

- [ ] **Run full test suite**

```bash
cd D:/pcgex-gnn && python -m pytest tests/ -v --tb=short 2>&1 | tail -20
```
Expected: all tests PASS (Plan 1 + Plan 2 tests together, ~70+ tests)

- [ ] **Verify no import cycles**

```bash
cd D:/pcgex-gnn && python -c "from src.models.pcgex_model import PCGExModel; from src.rag.kb import KnowledgeBase; from src.training.train import Trainer; print('All imports OK')"
```
Expected: `All imports OK`

- [ ] **Final commit**

```bash
cd D:/pcgex-gnn && git add . && git commit -m "chore: Plan 2 complete — GNN model, RAG, and training pipeline ready"
```
