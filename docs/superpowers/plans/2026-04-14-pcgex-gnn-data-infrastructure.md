# PCGEx GNN — Plan 1: Data Infrastructure

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Scaffold the `pcgex-gnn` Python repo and build the full data generation pipeline — domain registry, UE TCP data generator with per-node output capture, mutation pipeline, PCGEx website scraper, and sample processor.

**Architecture:** New standalone Python repo at `D:/pcgex-gnn/`. Communicates with UE via the existing Hayba TCP bridge (extended with a new `READ_NODE_OUTPUT` command). Data flows: scraper → raw graph patterns → generator (execute in UE, capture per-node output tables) → processor (tensorize) → `data/processed/`. Domain registry tracks per-domain phase and sample counts.

**Tech Stack:** Python 3.11+, PyTorch 2.x, pytest, httpx (async HTTP), beautifulsoup4 (scraper), numpy, rich (CLI progress)

---

## File Map

### New repo: `D:/pcgex-gnn/`

| File | Responsibility |
|------|----------------|
| `requirements.txt` | All Python dependencies |
| `pytest.ini` | Test config, test discovery paths |
| `src/__init__.py` | Package marker |
| `src/domain/registry.py` | Load/save domain manifest, phase transition logic |
| `src/data/generator.py` | TCP bridge: load graph → execute node-by-node → READ_NODE_OUTPUT |
| `src/data/mutations.py` | Param perturbation, node swap, node addition |
| `src/data/scraper.py` | PCGEx website → raw graph pattern JSON |
| `src/data/processor.py` | Raw sample dirs → tensorized `.pt` files |
| `scripts/generate_data.py` | CLI: generate N variants for a domain |
| `tests/test_registry.py` | Unit tests for domain registry |
| `tests/test_mutations.py` | Unit tests for mutation functions |
| `tests/test_processor.py` | Unit tests for processor |
| `tests/test_generator.py` | Generator tests with mock TCP server |
| `tests/fixtures/sample_graph.json` | Minimal valid PCGEx graph for tests |
| `data/raw/.gitkeep` | |
| `data/processed/.gitkeep` | |
| `data/kb/.gitkeep` | |

### Modified in Hayba repo: `D:/hayba/`

| File | Change |
|------|--------|
| `packages/hayba/Plugins/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/HaybaMCPModule.cpp` | Add `READ_NODE_OUTPUT` TCP command handler |
| `packages/hayba/src/gaea/knowledge/pcgex-domain-registry.json` | New — domain manifest seed |

---

## Task 1: Scaffold Repo

**Files:**
- Create: `D:/pcgex-gnn/requirements.txt`
- Create: `D:/pcgex-gnn/pytest.ini`
- Create: `D:/pcgex-gnn/src/__init__.py`
- Create: `D:/pcgex-gnn/src/domain/__init__.py`
- Create: `D:/pcgex-gnn/src/data/__init__.py`
- Create: `D:/pcgex-gnn/tests/__init__.py`

- [ ] **Step 1: Create repo directory structure**

```bash
mkdir -p D:/pcgex-gnn/src/domain
mkdir -p D:/pcgex-gnn/src/data
mkdir -p D:/pcgex-gnn/src/rag
mkdir -p D:/pcgex-gnn/scripts
mkdir -p D:/pcgex-gnn/tests/fixtures
mkdir -p D:/pcgex-gnn/data/raw
mkdir -p D:/pcgex-gnn/data/processed
mkdir -p D:/pcgex-gnn/data/kb
touch D:/pcgex-gnn/src/__init__.py
touch D:/pcgex-gnn/src/domain/__init__.py
touch D:/pcgex-gnn/src/data/__init__.py
touch D:/pcgex-gnn/src/rag/__init__.py
touch D:/pcgex-gnn/tests/__init__.py
touch D:/pcgex-gnn/data/raw/.gitkeep
touch D:/pcgex-gnn/data/processed/.gitkeep
touch D:/pcgex-gnn/data/kb/.gitkeep
```

- [ ] **Step 2: Write requirements.txt**

```
# D:/pcgex-gnn/requirements.txt
torch>=2.2.0
numpy>=1.26.0
httpx>=0.27.0
fastapi>=0.110.0
uvicorn>=0.29.0
beautifulsoup4>=4.12.0
requests>=2.31.0
rich>=13.7.0
pytest>=8.0.0
pytest-asyncio>=0.23.0
dspy-ai>=2.4.0
```

- [ ] **Step 3: Write pytest.ini**

```ini
# D:/pcgex-gnn/pytest.ini
[pytest]
testpaths = tests
asyncio_mode = auto
python_files = test_*.py
python_functions = test_*
```

- [ ] **Step 4: Write test fixture — minimal valid PCGEx graph**

```json
// D:/pcgex-gnn/tests/fixtures/sample_graph.json
{
  "nodes": [
    {
      "id": "node_0",
      "class": "PCGExSampleNearestPoint",
      "params": { "MaxPointsPerQuery": 8, "SearchRadius": 500.0 },
      "position": { "x": 0, "y": 0 }
    },
    {
      "id": "node_1",
      "class": "PCGExCluster",
      "params": { "MinClusterSize": 3, "MaxClusterSize": 20 },
      "position": { "x": 250, "y": 0 }
    }
  ],
  "edges": [
    { "from_node": "node_0", "from_pin": "Out", "to_node": "node_1", "to_pin": "In" }
  ],
  "domain": "foliage"
}
```

- [ ] **Step 5: Commit scaffold**

```bash
cd D:/pcgex-gnn
git init
git add .
git commit -m "chore: scaffold pcgex-gnn repo structure"
```

---

## Task 2: Domain Registry

**Files:**
- Create: `D:/pcgex-gnn/src/domain/registry.py`
- Create: `D:/pcgex-gnn/tests/test_registry.py`
- Create: `D:/hayba/packages/hayba/src/gaea/knowledge/pcgex-domain-registry.json`

- [ ] **Step 1: Write the failing tests**

```python
# D:/pcgex-gnn/tests/test_registry.py
import json
import tempfile
from pathlib import Path
from src.domain.registry import DomainRegistry, DomainConfig, Phase

def make_registry(tmp_path: Path) -> DomainRegistry:
    manifest = {
        "foliage": {
            "phase": 1,
            "labeled_samples": 45,
            "good_samples": 30,
            "weights_path": None,
            "domain_budget_ms": 50,
            "divergence_thresholds": [0.15, 0.45],
            "scoring_weights": {"quality": 1.0, "runtime": 0.3, "divergence": 0.5}
        }
    }
    p = tmp_path / "registry.json"
    p.write_text(json.dumps(manifest))
    return DomainRegistry(str(p))

def test_load_domain(tmp_path):
    reg = make_registry(tmp_path)
    cfg = reg.get("foliage")
    assert cfg.phase == Phase.BOOTSTRAP
    assert cfg.labeled_samples == 45
    assert cfg.good_samples == 30
    assert cfg.domain_budget_ms == 50

def test_unknown_domain_returns_none(tmp_path):
    reg = make_registry(tmp_path)
    assert reg.get("dungeons") is None

def test_increment_labeled(tmp_path):
    reg = make_registry(tmp_path)
    reg.increment_labeled("foliage", is_good=True)
    cfg = reg.get("foliage")
    assert cfg.labeled_samples == 46
    assert cfg.good_samples == 31

def test_phase_transition_to_joint(tmp_path):
    # Phase transitions to JOINT when good_samples >= 100
    reg = make_registry(tmp_path)
    for _ in range(70):
        reg.increment_labeled("foliage", is_good=True)
    cfg = reg.get("foliage")
    assert cfg.phase == Phase.JOINT

def test_phase_transition_to_bootstrap(tmp_path):
    # New domain transitions from FALLBACK to BOOTSTRAP when labeled_samples >= 20
    manifest = {
        "roads": {
            "phase": 0,
            "labeled_samples": 19,
            "good_samples": 10,
            "weights_path": None,
            "domain_budget_ms": 200,
            "divergence_thresholds": [0.10, 0.35],
            "scoring_weights": {"quality": 1.0, "runtime": 0.2, "divergence": 0.7}
        }
    }
    p = tmp_path / "registry.json"
    p.write_text(json.dumps(manifest))
    reg = DomainRegistry(str(p))
    reg.increment_labeled("roads", is_good=False)
    assert reg.get("roads").phase == Phase.BOOTSTRAP

def test_persist_survives_reload(tmp_path):
    reg = make_registry(tmp_path)
    reg.increment_labeled("foliage", is_good=True)
    p = tmp_path / "registry.json"
    reg2 = DomainRegistry(str(p))
    assert reg2.get("foliage").labeled_samples == 46

def test_register_new_domain(tmp_path):
    reg = make_registry(tmp_path)
    reg.register("rivers", domain_budget_ms=100)
    cfg = reg.get("rivers")
    assert cfg.phase == Phase.FALLBACK
    assert cfg.labeled_samples == 0
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd D:/pcgex-gnn
python -m pytest tests/test_registry.py -v
```
Expected: FAIL — `ModuleNotFoundError: No module named 'src.domain.registry'`

- [ ] **Step 3: Implement domain registry**

```python
# D:/pcgex-gnn/src/domain/registry.py
from __future__ import annotations
import json
from dataclasses import dataclass, field, asdict
from enum import IntEnum
from pathlib import Path
from typing import Optional

class Phase(IntEnum):
    FALLBACK = 0
    BOOTSTRAP = 1
    JOINT = 2
    FINETUNE = 3

FALLBACK_TO_BOOTSTRAP_THRESHOLD = 20   # total labeled samples
BOOTSTRAP_TO_JOINT_THRESHOLD = 100     # good samples

@dataclass
class DomainConfig:
    phase: Phase
    labeled_samples: int
    good_samples: int
    weights_path: Optional[str]
    domain_budget_ms: int
    divergence_thresholds: list[float]
    scoring_weights: dict[str, float]

class DomainRegistry:
    def __init__(self, path: str):
        self._path = Path(path)
        self._data: dict[str, DomainConfig] = {}
        self._load()

    def _load(self) -> None:
        raw = json.loads(self._path.read_text())
        for name, d in raw.items():
            self._data[name] = DomainConfig(
                phase=Phase(d["phase"]),
                labeled_samples=d["labeled_samples"],
                good_samples=d["good_samples"],
                weights_path=d.get("weights_path"),
                domain_budget_ms=d["domain_budget_ms"],
                divergence_thresholds=d["divergence_thresholds"],
                scoring_weights=d["scoring_weights"],
            )

    def _save(self) -> None:
        raw = {}
        for name, cfg in self._data.items():
            raw[name] = {
                "phase": int(cfg.phase),
                "labeled_samples": cfg.labeled_samples,
                "good_samples": cfg.good_samples,
                "weights_path": cfg.weights_path,
                "domain_budget_ms": cfg.domain_budget_ms,
                "divergence_thresholds": cfg.divergence_thresholds,
                "scoring_weights": cfg.scoring_weights,
            }
        self._path.write_text(json.dumps(raw, indent=2))

    def get(self, domain: str) -> Optional[DomainConfig]:
        return self._data.get(domain)

    def increment_labeled(self, domain: str, is_good: bool) -> None:
        cfg = self._data[domain]
        cfg.labeled_samples += 1
        if is_good:
            cfg.good_samples += 1
        # Phase transitions
        if cfg.phase == Phase.FALLBACK and cfg.labeled_samples >= FALLBACK_TO_BOOTSTRAP_THRESHOLD:
            cfg.phase = Phase.BOOTSTRAP
        elif cfg.phase == Phase.BOOTSTRAP and cfg.good_samples >= BOOTSTRAP_TO_JOINT_THRESHOLD:
            cfg.phase = Phase.JOINT
        self._save()

    def register(self, domain: str, domain_budget_ms: int = 100) -> None:
        if domain in self._data:
            return
        self._data[domain] = DomainConfig(
            phase=Phase.FALLBACK,
            labeled_samples=0,
            good_samples=0,
            weights_path=None,
            domain_budget_ms=domain_budget_ms,
            divergence_thresholds=[0.15, 0.40],
            scoring_weights={"quality": 1.0, "runtime": 0.3, "divergence": 0.5},
        )
        self._save()
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd D:/pcgex-gnn
python -m pytest tests/test_registry.py -v
```
Expected: all 7 tests PASS

- [ ] **Step 5: Write domain registry seed file in Hayba**

```json
// D:/hayba/packages/hayba/src/gaea/knowledge/pcgex-domain-registry.json
{
  "foliage": {
    "phase": 0,
    "labeled_samples": 0,
    "good_samples": 0,
    "weights_path": null,
    "domain_budget_ms": 50,
    "divergence_thresholds": [0.15, 0.45],
    "scoring_weights": { "quality": 1.0, "runtime": 0.3, "divergence": 0.5 }
  },
  "roads": {
    "phase": 0,
    "labeled_samples": 0,
    "good_samples": 0,
    "weights_path": null,
    "domain_budget_ms": 200,
    "divergence_thresholds": [0.10, 0.35],
    "scoring_weights": { "quality": 1.0, "runtime": 0.2, "divergence": 0.7 }
  }
}
```

- [ ] **Step 6: Commit**

```bash
cd D:/pcgex-gnn
git add src/domain/registry.py tests/test_registry.py
git commit -m "feat: add domain registry with phase transition logic"

cd D:/hayba
git add packages/hayba/src/gaea/knowledge/pcgex-domain-registry.json
git commit -m "feat: add pcgex domain registry seed"
```

---

## Task 3: READ_NODE_OUTPUT TCP Command (UE Plugin)

**Files:**
- Modify: `D:/hayba/packages/hayba/Plugins/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/HaybaMCPModule.cpp`

This adds a new command to the existing TCP command handler. Read `HaybaMCPModule.cpp` first to find the existing command dispatch pattern, then add the new handler following it exactly.

- [ ] **Step 1: Read the existing TCP command handler structure**

Open `HaybaMCPModule.cpp` and find the section where commands are dispatched (look for a `HandleCommand` or similar function with a string switch/if-else on command name). Note the exact pattern used — request JSON field names, response JSON structure, error format.

- [ ] **Step 2: Add READ_NODE_OUTPUT handler**

Find the block where existing commands are registered/handled. Add the new command following the same pattern. The command reads the PCGEx node execution output table and returns encoded features.

The handler should:
1. Parse `node_id` (string) and `graph_asset_path` (string) from the request JSON
2. Find the PCGExComponent for the given asset in the UE world
3. Read the output point data for the specified node (use PCGEx's existing `GetOutputData` or equivalent API)
4. Encode and return the features as JSON

```cpp
// Add inside the existing command dispatch block, following the pattern of other commands.
// Replace "EXISTING_COMMAND_PATTERN" with whatever the codebase uses.

if (CommandName == TEXT("READ_NODE_OUTPUT"))
{
    FString NodeId = RequestJson->GetStringField(TEXT("node_id"));
    FString GraphAssetPath = RequestJson->GetStringField(TEXT("graph_asset_path"));

    TSharedPtr<FJsonObject> ResponseJson = MakeShared<FJsonObject>();

    // Find PCGExComponent for this graph
    UPCGComponent* PCGComp = FindPCGComponentForAsset(GraphAssetPath);
    if (!PCGComp)
    {
        ResponseJson->SetBoolField(TEXT("success"), false);
        ResponseJson->SetStringField(TEXT("error"), TEXT("PCGComponent not found for asset: ") + GraphAssetPath);
        SendJsonResponse(ClientSocket, ResponseJson);
        return;
    }

    // Get output data for node
    UPCGData* NodeOutputData = GetNodeOutputData(PCGComp, NodeId);
    if (!NodeOutputData)
    {
        ResponseJson->SetBoolField(TEXT("success"), false);
        ResponseJson->SetStringField(TEXT("error"), TEXT("No output data for node: ") + NodeId);
        SendJsonResponse(ClientSocket, ResponseJson);
        return;
    }

    // Encode features
    TSharedPtr<FJsonObject> Features = MakeShared<FJsonObject>();

    if (UPCGPointData* PointData = Cast<UPCGPointData>(NodeOutputData))
    {
        Features->SetStringField(TEXT("geometry_type"), TEXT("points"));
        Features->SetNumberField(TEXT("point_count"), PointData->GetPoints().Num());

        // Collect attribute names and value ranges
        TArray<TSharedPtr<FJsonValue>> AttrNames;
        TSharedPtr<FJsonObject> ValueRanges = MakeShared<FJsonObject>();

        const UPCGMetadata* Meta = PointData->ConstMetadata();
        if (Meta)
        {
            TArray<FName> AttrNamesList;
            Meta->GetAttributesByName(AttrNamesList);
            for (const FName& AttrName : AttrNamesList)
            {
                AttrNames.Add(MakeShared<FJsonValueString>(AttrName.ToString()));
                // Compute min/max for numeric attributes
                const FPCGMetadataAttributeBase* Attr = Meta->GetConstAttribute(AttrName);
                if (Attr && Attr->GetTypeId() == PCG_ATTRIBUTE_PROPERTY_FLOAT)
                {
                    float MinVal = TNumericLimits<float>::Max();
                    float MaxVal = TNumericLimits<float>::Lowest();
                    for (const FPCGPoint& Pt : PointData->GetPoints())
                    {
                        float Val = static_cast<const FPCGMetadataAttribute<float>*>(Attr)->GetValueFromItemKey(Pt.MetadataEntry);
                        MinVal = FMath::Min(MinVal, Val);
                        MaxVal = FMath::Max(MaxVal, Val);
                    }
                    TArray<TSharedPtr<FJsonValue>> Range;
                    Range.Add(MakeShared<FJsonValueNumber>(MinVal));
                    Range.Add(MakeShared<FJsonValueNumber>(MaxVal));
                    ValueRanges->SetArrayField(AttrName.ToString(), Range);
                }
            }
        }
        Features->SetArrayField(TEXT("attributes"), AttrNames);
        Features->SetObjectField(TEXT("value_ranges"), ValueRanges);
    }
    else if (Cast<UPCGSplineData>(NodeOutputData) || Cast<UPCGPolyLineData>(NodeOutputData))
    {
        Features->SetStringField(TEXT("geometry_type"), TEXT("splines"));
        Features->SetNumberField(TEXT("point_count"), 0);
        TArray<TSharedPtr<FJsonValue>> EmptyAttrs;
        Features->SetArrayField(TEXT("attributes"), EmptyAttrs);
        TSharedPtr<FJsonObject> EmptyRanges = MakeShared<FJsonObject>();
        Features->SetObjectField(TEXT("value_ranges"), EmptyRanges);
    }
    else
    {
        Features->SetStringField(TEXT("geometry_type"), TEXT("unknown"));
        Features->SetNumberField(TEXT("point_count"), 0);
        TArray<TSharedPtr<FJsonValue>> EmptyAttrs;
        Features->SetArrayField(TEXT("attributes"), EmptyAttrs);
        TSharedPtr<FJsonObject> EmptyRanges = MakeShared<FJsonObject>();
        Features->SetObjectField(TEXT("value_ranges"), EmptyRanges);
    }

    ResponseJson->SetBoolField(TEXT("success"), true);
    ResponseJson->SetObjectField(TEXT("features"), Features);
    SendJsonResponse(ClientSocket, ResponseJson);
    return;
}
```

- [ ] **Step 3: Rebuild the UE plugin**

Open the Unreal Engine project, compile in the editor (or via `UnrealBuildTool`). Verify no compile errors.

- [ ] **Step 4: Manual smoke test**

With UE open and a PCGEx graph loaded:
1. Connect to the TCP bridge (use an existing Hayba MCP tool call to verify connection)
2. Send a raw `READ_NODE_OUTPUT` command with a valid `node_id` and `graph_asset_path`
3. Verify the response contains `{ success: true, features: { geometry_type, point_count, attributes, value_ranges } }`

- [ ] **Step 5: Commit**

```bash
cd D:/hayba
git add packages/hayba/Plugins/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/HaybaMCPModule.cpp
git commit -m "feat(ue-plugin): add READ_NODE_OUTPUT TCP command"
```

---

## Task 4: UE Data Generator

**Files:**
- Create: `D:/pcgex-gnn/src/data/generator.py`
- Create: `D:/pcgex-gnn/tests/test_generator.py`

The generator connects to the UE TCP bridge (same protocol as Hayba's MCP tools — 4-byte length-prefixed JSON), loads a graph, executes it node-by-node, and captures per-node output table features + wall-clock runtime.

- [ ] **Step 1: Write failing tests**

```python
# D:/pcgex-gnn/tests/test_generator.py
import asyncio
import json
import struct
import pytest
from unittest.mock import AsyncMock, patch, MagicMock
from src.data.generator import UEBridgeClient, GeneratedSample, generate_sample

# ---- helpers ----

def make_tcp_response(payload: dict) -> bytes:
    """Encode a response the way the UE TCP bridge would send it."""
    body = json.dumps(payload).encode()
    return struct.pack(">I", len(body)) + body

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

NODE_OUTPUT_FEATURES = {
    "geometry_type": "points",
    "point_count": 423,
    "attributes": ["density_weight"],
    "value_ranges": {"density_weight": [0.0, 1.0]},
}

@pytest.mark.asyncio
async def test_generate_sample_returns_stage_outputs():
    """generate_sample returns one GeneratedSample with per-node stage outputs."""
    execute_resp = make_tcp_response({"success": True, "duration_ms": 12.5})
    read_output_resp = make_tcp_response({"success": True, "features": NODE_OUTPUT_FEATURES})

    # Two nodes → two execute + two read_output calls
    mock_responses = [
        execute_resp, read_output_resp,   # node n0
        execute_resp, read_output_resp,   # node n1
    ]
    response_iter = iter(mock_responses)

    async def mock_send_recv(command: dict) -> dict:
        raw = next(response_iter)
        body = raw[4:]  # strip length prefix
        return json.loads(body)

    with patch("src.data.generator.UEBridgeClient.send_command", side_effect=mock_send_recv):
        client = UEBridgeClient(host="127.0.0.1", port=9001)
        sample = await generate_sample(client, SAMPLE_GRAPH, graph_asset_path="/Game/Test/Graph")

    assert isinstance(sample, GeneratedSample)
    assert len(sample.stage_outputs) == 2
    assert sample.stage_outputs["n0"]["point_count"] == 423
    assert sample.stage_outputs["n1"]["point_count"] == 423
    assert sample.total_runtime_ms >= 0.0

@pytest.mark.asyncio
async def test_generate_sample_records_per_node_runtime():
    """Each stage output includes the wall-clock time for that node."""
    execute_resp = make_tcp_response({"success": True, "duration_ms": 8.0})
    read_output_resp = make_tcp_response({"success": True, "features": NODE_OUTPUT_FEATURES})
    mock_responses = [execute_resp, read_output_resp, execute_resp, read_output_resp]
    response_iter = iter(mock_responses)

    async def mock_send_recv(command: dict) -> dict:
        raw = next(response_iter)
        return json.loads(raw[4:])

    with patch("src.data.generator.UEBridgeClient.send_command", side_effect=mock_send_recv):
        client = UEBridgeClient(host="127.0.0.1", port=9001)
        sample = await generate_sample(client, SAMPLE_GRAPH, graph_asset_path="/Game/Test/Graph")

    assert sample.stage_outputs["n0"]["runtime_ms"] == 8.0
    assert sample.stage_outputs["n1"]["runtime_ms"] == 8.0

@pytest.mark.asyncio
async def test_generate_sample_aborts_on_execute_failure():
    """generate_sample raises RuntimeError if a node execution fails."""
    fail_resp = make_tcp_response({"success": False, "error": "Node failed"})
    response_iter = iter([fail_resp])

    async def mock_send_recv(command: dict) -> dict:
        return json.loads(next(response_iter)[4:])

    with patch("src.data.generator.UEBridgeClient.send_command", side_effect=mock_send_recv):
        client = UEBridgeClient(host="127.0.0.1", port=9001)
        with pytest.raises(RuntimeError, match="Node failed"):
            await generate_sample(client, SAMPLE_GRAPH, graph_asset_path="/Game/Test/Graph")
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd D:/pcgex-gnn
python -m pytest tests/test_generator.py -v
```
Expected: FAIL — `ModuleNotFoundError: No module named 'src.data.generator'`

- [ ] **Step 3: Implement generator**

```python
# D:/pcgex-gnn/src/data/generator.py
from __future__ import annotations
import asyncio
import json
import struct
import time
from dataclasses import dataclass, field
from typing import Any

@dataclass
class GeneratedSample:
    graph: dict
    graph_asset_path: str
    stage_outputs: dict[str, dict]   # node_id → { geometry_type, point_count, attributes, value_ranges, runtime_ms }
    total_runtime_ms: float

class UEBridgeClient:
    def __init__(self, host: str = "127.0.0.1", port: int = 9001):
        self.host = host
        self.port = port
        self._reader: asyncio.StreamReader | None = None
        self._writer: asyncio.StreamWriter | None = None

    async def connect(self) -> None:
        self._reader, self._writer = await asyncio.open_connection(self.host, self.port)

    async def disconnect(self) -> None:
        if self._writer:
            self._writer.close()
            await self._writer.wait_closed()

    async def send_command(self, command: dict) -> dict:
        if not self._writer:
            raise RuntimeError("Not connected — call connect() first")
        body = json.dumps(command).encode()
        self._writer.write(struct.pack(">I", len(body)) + body)
        await self._writer.drain()

        length_bytes = await self._reader.readexactly(4)
        length = struct.unpack(">I", length_bytes)[0]
        response_bytes = await self._reader.readexactly(length)
        return json.loads(response_bytes)

def _topological_order(graph: dict) -> list[str]:
    """Return node IDs in topological execution order."""
    nodes = {n["id"] for n in graph["nodes"]}
    edges = graph.get("edges", [])
    in_degree: dict[str, int] = {n: 0 for n in nodes}
    children: dict[str, list[str]] = {n: [] for n in nodes}
    for e in edges:
        in_degree[e["to_node"]] += 1
        children[e["from_node"]].append(e["to_node"])

    queue = [n for n in nodes if in_degree[n] == 0]
    order = []
    while queue:
        node = queue.pop(0)
        order.append(node)
        for child in children[node]:
            in_degree[child] -= 1
            if in_degree[child] == 0:
                queue.append(child)
    return order

async def generate_sample(
    client: UEBridgeClient,
    graph: dict,
    graph_asset_path: str,
) -> GeneratedSample:
    """Execute a graph node-by-node and capture per-node output table features."""
    stage_outputs: dict[str, dict] = {}
    total_start = time.perf_counter()

    for node_id in _topological_order(graph):
        # Execute node
        exec_resp = await client.send_command({
            "command": "EXECUTE_PCG_NODE",
            "node_id": node_id,
            "graph_asset_path": graph_asset_path,
        })
        if not exec_resp.get("success"):
            raise RuntimeError(exec_resp.get("error", f"Execution failed for node {node_id}"))

        node_runtime_ms: float = exec_resp.get("duration_ms", 0.0)

        # Read output table
        read_resp = await client.send_command({
            "command": "READ_NODE_OUTPUT",
            "node_id": node_id,
            "graph_asset_path": graph_asset_path,
        })
        if not read_resp.get("success"):
            raise RuntimeError(read_resp.get("error", f"READ_NODE_OUTPUT failed for node {node_id}"))

        features = read_resp["features"]
        features["runtime_ms"] = node_runtime_ms
        stage_outputs[node_id] = features

    total_runtime_ms = (time.perf_counter() - total_start) * 1000.0
    return GeneratedSample(
        graph=graph,
        graph_asset_path=graph_asset_path,
        stage_outputs=stage_outputs,
        total_runtime_ms=total_runtime_ms,
    )
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd D:/pcgex-gnn
python -m pytest tests/test_generator.py -v
```
Expected: all 3 tests PASS

- [ ] **Step 5: Commit**

```bash
cd D:/pcgex-gnn
git add src/data/generator.py tests/test_generator.py
git commit -m "feat: add UE data generator with per-node output capture"
```

---

## Task 5: Mutation Pipeline

**Files:**
- Create: `D:/pcgex-gnn/src/data/mutations.py`
- Create: `D:/pcgex-gnn/tests/test_mutations.py`

- [ ] **Step 1: Write failing tests**

```python
# D:/pcgex-gnn/tests/test_mutations.py
import copy
import json
from pathlib import Path
from src.data.mutations import perturb_params, swap_node, add_node, mutate

FIXTURE_PATH = Path(__file__).parent / "fixtures" / "sample_graph.json"

def load_graph():
    return json.loads(FIXTURE_PATH.read_text())

def test_perturb_params_changes_values():
    graph = load_graph()
    original_params = copy.deepcopy(graph["nodes"][0]["params"])
    mutated = perturb_params(graph, perturbation=0.30, seed=42)
    new_params = mutated["nodes"][0]["params"]
    # At least one param should change
    assert any(new_params[k] != original_params[k] for k in original_params)

def test_perturb_params_stays_within_bounds():
    graph = load_graph()
    for _ in range(20):
        mutated = perturb_params(graph, perturbation=0.30)
        for node in mutated["nodes"]:
            for k, v in node["params"].items():
                original_v = graph["nodes"][mutated["nodes"].index(node)]["params"][k]
                assert abs(v - original_v) <= abs(original_v) * 0.30 + 1e-6

def test_perturb_params_does_not_mutate_original():
    graph = load_graph()
    original = copy.deepcopy(graph)
    perturb_params(graph, perturbation=0.30, seed=1)
    assert graph == original

def test_swap_node_changes_class():
    graph = load_graph()
    mutated = swap_node(graph, node_index=0, new_class="PCGExFindPointOnBounds",
                        new_params={"SearchRadius": 300.0})
    assert mutated["nodes"][0]["class"] == "PCGExFindPointOnBounds"
    assert mutated["nodes"][0]["params"]["SearchRadius"] == 300.0

def test_swap_node_preserves_edges():
    graph = load_graph()
    mutated = swap_node(graph, node_index=0, new_class="PCGExFindPointOnBounds",
                        new_params={})
    assert len(mutated["edges"]) == len(graph["edges"])

def test_add_node_inserts_node():
    graph = load_graph()
    new_node = {"id": "n2", "class": "PCGExWriteIndex", "params": {}, "position": {"x": 500, "y": 0}}
    new_edge = {"from_node": "node_1", "from_pin": "Out", "to_node": "n2", "to_pin": "In"}
    mutated = add_node(graph, new_node=new_node, new_edges=[new_edge])
    assert len(mutated["nodes"]) == len(graph["nodes"]) + 1
    assert len(mutated["edges"]) == len(graph["edges"]) + 1

def test_mutate_returns_n_variants():
    graph = load_graph()
    variants = mutate(graph, n=5)
    assert len(variants) == 5
    assert all(isinstance(v, dict) for v in variants)
    # All variants should be structurally valid (have nodes and edges)
    assert all("nodes" in v and "edges" in v for v in variants)
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd D:/pcgex-gnn
python -m pytest tests/test_mutations.py -v
```
Expected: FAIL — `ModuleNotFoundError: No module named 'src.data.mutations'`

- [ ] **Step 3: Implement mutations**

```python
# D:/pcgex-gnn/src/data/mutations.py
from __future__ import annotations
import copy
import random
from typing import Optional

def perturb_params(graph: dict, perturbation: float = 0.30, seed: Optional[int] = None) -> dict:
    """Return a new graph with numeric params perturbed by ±perturbation fraction."""
    rng = random.Random(seed)
    result = copy.deepcopy(graph)
    for node in result["nodes"]:
        for key, val in node["params"].items():
            if isinstance(val, (int, float)):
                delta = val * perturbation
                node["params"][key] = val + rng.uniform(-delta, delta)
    return result

def swap_node(graph: dict, node_index: int, new_class: str, new_params: dict) -> dict:
    """Return a new graph with the node at node_index replaced by a new class+params."""
    result = copy.deepcopy(graph)
    node = result["nodes"][node_index]
    node["class"] = new_class
    node["params"] = copy.deepcopy(new_params)
    return result

def add_node(graph: dict, new_node: dict, new_edges: list[dict]) -> dict:
    """Return a new graph with new_node and new_edges appended."""
    result = copy.deepcopy(graph)
    result["nodes"].append(copy.deepcopy(new_node))
    result["edges"].extend(copy.deepcopy(new_edges))
    return result

def mutate(graph: dict, n: int, perturbation: float = 0.30) -> list[dict]:
    """Return n mutated variants of graph using random perturbation."""
    variants = []
    for i in range(n):
        variants.append(perturb_params(graph, perturbation=perturbation, seed=i))
    return variants
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd D:/pcgex-gnn
python -m pytest tests/test_mutations.py -v
```
Expected: all 7 tests PASS

- [ ] **Step 5: Commit**

```bash
cd D:/pcgex-gnn
git add src/data/mutations.py tests/test_mutations.py
git commit -m "feat: add mutation pipeline for training data generation"
```

---

## Task 6: PCGEx Website Scraper

**Files:**
- Create: `D:/pcgex-gnn/src/data/scraper.py`
- Create: `D:/pcgex-gnn/tests/test_scraper.py`
- Create: `D:/pcgex-gnn/tests/fixtures/pcgex_example.html`

The scraper fetches PCGEx documentation pages and extracts graph patterns (node lists + rough connection hints) for use as RAG knowledge base seeds.

- [ ] **Step 1: Write a fixture HTML page**

Capture a real PCGEx example page. Save it to `tests/fixtures/pcgex_example.html`. The exact HTML will depend on the live site — fetch it manually:

```bash
curl -L "https://pcgextendedtoolkit.com/docs/nodes/clusters/cluster-to-path/" \
  -o D:/pcgex-gnn/tests/fixtures/pcgex_example.html
```

- [ ] **Step 2: Write failing tests**

```python
# D:/pcgex-gnn/tests/test_scraper.py
from pathlib import Path
from src.data.scraper import parse_example_page, GraphPattern

FIXTURE_HTML = (Path(__file__).parent / "fixtures" / "pcgex_example.html").read_text(encoding="utf-8")

def test_parse_returns_graph_pattern():
    result = parse_example_page(FIXTURE_HTML, url="https://pcgextendedtoolkit.com/docs/nodes/clusters/cluster-to-path/")
    assert isinstance(result, GraphPattern)

def test_parse_extracts_node_classes():
    result = parse_example_page(FIXTURE_HTML, url="https://pcgextendedtoolkit.com/docs/nodes/clusters/cluster-to-path/")
    # Should find at least one PCGEx node class name
    assert len(result.node_classes) >= 1
    assert all(isinstance(c, str) for c in result.node_classes)

def test_parse_extracts_description():
    result = parse_example_page(FIXTURE_HTML, url="https://pcgextendedtoolkit.com/docs/nodes/clusters/cluster-to-path/")
    assert isinstance(result.description, str)
    assert len(result.description) > 10

def test_parse_extracts_domain_tags():
    result = parse_example_page(FIXTURE_HTML, url="https://pcgextendedtoolkit.com/docs/nodes/clusters/cluster-to-path/")
    # Domain tags inferred from URL path: "clusters" → likely contains "cluster"
    assert isinstance(result.domain_tags, list)
```

- [ ] **Step 3: Run tests to verify they fail**

```bash
cd D:/pcgex-gnn
python -m pytest tests/test_scraper.py -v
```
Expected: FAIL — `ModuleNotFoundError: No module named 'src.data.scraper'`

- [ ] **Step 4: Implement scraper**

```python
# D:/pcgex-gnn/src/data/scraper.py
from __future__ import annotations
import re
import time
from dataclasses import dataclass, field
from typing import Optional
import requests
from bs4 import BeautifulSoup

# PCGEx node class names follow the pattern PCGEx<Something>
_NODE_CLASS_RE = re.compile(r'\bPCGEx[A-Z][A-Za-z0-9_]+')

# URL path segment → domain tag mapping
_PATH_TO_DOMAIN = {
    "clusters": "cluster",
    "paths": "roads",
    "splines": "roads",
    "points": "foliage",
    "sampling": "foliage",
    "filter": "foliage",
    "transform": "foliage",
}

@dataclass
class GraphPattern:
    url: str
    node_classes: list[str]
    description: str
    domain_tags: list[str]
    raw_html: str = field(repr=False, default="")

def parse_example_page(html: str, url: str) -> GraphPattern:
    soup = BeautifulSoup(html, "html.parser")

    # Extract description from first meaningful paragraph
    description = ""
    for tag in soup.find_all(["p", "h1", "h2", "h3"]):
        text = tag.get_text(strip=True)
        if len(text) > 20:
            description = text
            break

    # Find all PCGEx node class names in the page text
    page_text = soup.get_text()
    node_classes = list(dict.fromkeys(_NODE_CLASS_RE.findall(page_text)))  # deduplicate, preserve order

    # Infer domain tags from URL path segments
    domain_tags: list[str] = []
    for segment in url.split("/"):
        tag = _PATH_TO_DOMAIN.get(segment.lower())
        if tag and tag not in domain_tags:
            domain_tags.append(tag)

    return GraphPattern(
        url=url,
        node_classes=node_classes,
        description=description,
        domain_tags=domain_tags,
        raw_html=html,
    )

def scrape_pcgex_docs(base_url: str = "https://pcgextendedtoolkit.com/docs/",
                       delay_s: float = 1.5) -> list[GraphPattern]:
    """Crawl PCGEx docs and return all parseable graph patterns."""
    session = requests.Session()
    session.headers["User-Agent"] = "pcgex-gnn-scraper/1.0 (research)"

    index_resp = session.get(base_url, timeout=10)
    index_resp.raise_for_status()
    index_soup = BeautifulSoup(index_resp.text, "html.parser")

    # Collect all doc page links
    links = set()
    for a in index_soup.find_all("a", href=True):
        href: str = a["href"]
        if href.startswith("/docs/") or href.startswith(base_url):
            full = href if href.startswith("http") else "https://pcgextendedtoolkit.com" + href
            links.add(full)

    patterns = []
    for url in sorted(links):
        try:
            resp = session.get(url, timeout=10)
            resp.raise_for_status()
            pattern = parse_example_page(resp.text, url=url)
            if pattern.node_classes:
                patterns.append(pattern)
            time.sleep(delay_s)
        except Exception:
            continue

    return patterns
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
cd D:/pcgex-gnn
python -m pytest tests/test_scraper.py -v
```
Expected: all 4 tests PASS

- [ ] **Step 6: Commit**

```bash
cd D:/pcgex-gnn
git add src/data/scraper.py tests/test_scraper.py tests/fixtures/pcgex_example.html
git commit -m "feat: add PCGEx docs scraper for RAG knowledge base seeding"
```

---

## Task 7: Sample Processor

**Files:**
- Create: `D:/pcgex-gnn/src/data/processor.py`
- Create: `D:/pcgex-gnn/tests/test_processor.py`

Converts raw sample directories (`data/raw/<domain>/<sample-id>/`) into tensorized `.pt` files for training.

- [ ] **Step 1: Write failing tests**

```python
# D:/pcgex-gnn/tests/test_processor.py
import json
import tempfile
from pathlib import Path
import torch
from src.data.processor import process_sample, ProcessedSample, NODE_CLASS_VOCAB

def make_raw_sample(tmp_path: Path) -> Path:
    sample_dir = tmp_path / "foliage" / "sample_001"
    sample_dir.mkdir(parents=True)

    graph = {
        "nodes": [
            {"id": "n0", "class": "PCGExSampleNearestPoint",
             "params": {"MaxPointsPerQuery": 8, "SearchRadius": 500.0},
             "position": {"x": 0, "y": 0}},
            {"id": "n1", "class": "PCGExCluster",
             "params": {"MinClusterSize": 3, "MaxClusterSize": 20},
             "position": {"x": 250, "y": 0}},
        ],
        "edges": [{"from_node": "n0", "from_pin": "Out", "to_node": "n1", "to_pin": "In"}],
        "domain": "foliage",
    }
    stage_outputs = {
        "n0": {"geometry_type": "points", "point_count": 423,
               "attributes": ["density_weight"], "value_ranges": {"density_weight": [0.0, 1.0]},
               "runtime_ms": 8.0},
        "n1": {"geometry_type": "points", "point_count": 87,
               "attributes": ["cluster_id"], "value_ranges": {"cluster_id": [0.0, 12.0]},
               "runtime_ms": 15.0},
    }
    meta = {"domain": "foliage", "source": "generated", "mutations_applied": ["perturb_params"]}
    runtime = {"total_ms": 23.0, "per_node_ms": {"n0": 8.0, "n1": 15.0}, "normalized_ms": 54.4}

    (sample_dir / "graph.json").write_text(json.dumps(graph))
    (sample_dir / "stage_outputs.json").write_text(json.dumps(stage_outputs))
    (sample_dir / "meta.json").write_text(json.dumps(meta))
    (sample_dir / "runtime.json").write_text(json.dumps(runtime))
    return sample_dir

def test_process_sample_returns_processed_sample(tmp_path):
    sample_dir = make_raw_sample(tmp_path)
    result = process_sample(sample_dir)
    assert isinstance(result, ProcessedSample)

def test_process_sample_node_features_shape(tmp_path):
    sample_dir = make_raw_sample(tmp_path)
    result = process_sample(sample_dir)
    # node_features: [N_nodes × node_feature_dim]
    # feature_dim = type_embed_index(1) + param_count(varies) padded to MAX_PARAMS + depth(1)
    assert result.node_features.shape[0] == 2  # 2 nodes
    assert result.node_features.ndim == 2

def test_process_sample_adjacency_shape(tmp_path):
    sample_dir = make_raw_sample(tmp_path)
    result = process_sample(sample_dir)
    # adjacency: [N_nodes × N_nodes]
    assert result.adjacency.shape == (2, 2)
    assert result.adjacency[0, 1] == 1.0   # n0 → n1 edge
    assert result.adjacency[1, 0] == 0.0   # no reverse edge

def test_process_sample_stage_features_shape(tmp_path):
    sample_dir = make_raw_sample(tmp_path)
    result = process_sample(sample_dir)
    # stage_features: [N_nodes × stage_feature_dim]
    assert result.stage_features.shape[0] == 2
    assert result.stage_features.ndim == 2

def test_process_sample_runtime_normalized(tmp_path):
    sample_dir = make_raw_sample(tmp_path)
    result = process_sample(sample_dir)
    assert result.normalized_runtime_ms == pytest.approx(54.4, abs=0.1)

def test_process_sample_node_classes_indexed(tmp_path):
    sample_dir = make_raw_sample(tmp_path)
    result = process_sample(sample_dir)
    # node_class_indices: [N_nodes] of int64
    assert result.node_class_indices.dtype == torch.int64
    assert result.node_class_indices.shape == (2,)
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd D:/pcgex-gnn
python -m pytest tests/test_processor.py -v
```
Expected: FAIL — `ModuleNotFoundError: No module named 'src.data.processor'`

- [ ] **Step 3: Implement processor**

```python
# D:/pcgex-gnn/src/data/processor.py
from __future__ import annotations
import json
from dataclasses import dataclass
from pathlib import Path
import torch
import numpy as np

MAX_PARAMS = 16   # pad param vectors to this length

# Vocabulary: PCGEx node class → integer index (grows as new classes are seen)
# Loaded from/saved to data/kb/node_class_vocab.json
NODE_CLASS_VOCAB: dict[str, int] = {}
_VOCAB_PATH = Path(__file__).parent.parent.parent / "data" / "kb" / "node_class_vocab.json"

def _load_vocab() -> None:
    global NODE_CLASS_VOCAB
    if _VOCAB_PATH.exists():
        NODE_CLASS_VOCAB = json.loads(_VOCAB_PATH.read_text())

def _save_vocab() -> None:
    _VOCAB_PATH.parent.mkdir(parents=True, exist_ok=True)
    _VOCAB_PATH.write_text(json.dumps(NODE_CLASS_VOCAB, indent=2))

def _get_class_index(class_name: str) -> int:
    _load_vocab()
    if class_name not in NODE_CLASS_VOCAB:
        NODE_CLASS_VOCAB[class_name] = len(NODE_CLASS_VOCAB)
        _save_vocab()
    return NODE_CLASS_VOCAB[class_name]

def _encode_params(params: dict) -> list[float]:
    """Flatten param dict to a fixed-length float vector, zero-padded to MAX_PARAMS."""
    values = [float(v) for v in params.values() if isinstance(v, (int, float))]
    values = values[:MAX_PARAMS]
    values += [0.0] * (MAX_PARAMS - len(values))
    return values

def _encode_stage_features(stage: dict) -> list[float]:
    """Encode output table features as a fixed-length float vector."""
    geom_type_map = {"points": 0.0, "splines": 1.0, "unknown": 2.0}
    geom = geom_type_map.get(stage.get("geometry_type", "unknown"), 2.0)
    point_count = float(stage.get("point_count", 0))
    attr_count = float(len(stage.get("attributes", [])))
    runtime = float(stage.get("runtime_ms", 0.0))
    return [geom, point_count, attr_count, runtime]

@dataclass
class ProcessedSample:
    node_features: torch.Tensor          # [N × (1 + MAX_PARAMS + 1)]  type_index | params | depth
    node_class_indices: torch.Tensor     # [N] int64 — for embedding lookup
    adjacency: torch.Tensor              # [N × N] float32
    stage_features: torch.Tensor         # [N × 4] float32
    normalized_runtime_ms: float
    domain: str
    sample_id: str

def process_sample(sample_dir: Path) -> ProcessedSample:
    graph = json.loads((sample_dir / "graph.json").read_text())
    stage_outputs = json.loads((sample_dir / "stage_outputs.json").read_text())
    runtime = json.loads((sample_dir / "runtime.json").read_text())
    meta = json.loads((sample_dir / "meta.json").read_text())

    nodes = graph["nodes"]
    node_ids = [n["id"] for n in nodes]
    id_to_idx = {nid: i for i, nid in enumerate(node_ids)}
    N = len(nodes)

    # Node features
    node_features_list = []
    class_indices = []
    for depth, node in enumerate(nodes):
        class_idx = _get_class_index(node["class"])
        params = _encode_params(node.get("params", {}))
        node_features_list.append([float(class_idx)] + params + [float(depth)])
        class_indices.append(class_idx)

    node_features = torch.tensor(node_features_list, dtype=torch.float32)
    node_class_indices = torch.tensor(class_indices, dtype=torch.int64)

    # Adjacency matrix
    adj = torch.zeros(N, N, dtype=torch.float32)
    for edge in graph.get("edges", []):
        src = id_to_idx.get(edge["from_node"])
        dst = id_to_idx.get(edge["to_node"])
        if src is not None and dst is not None:
            adj[src, dst] = 1.0

    # Stage features
    stage_list = []
    for nid in node_ids:
        stage = stage_outputs.get(nid, {})
        stage_list.append(_encode_stage_features(stage))
    stage_features = torch.tensor(stage_list, dtype=torch.float32)

    return ProcessedSample(
        node_features=node_features,
        node_class_indices=node_class_indices,
        adjacency=adj,
        stage_features=stage_features,
        normalized_runtime_ms=float(runtime.get("normalized_ms", 0.0)),
        domain=meta.get("domain", "unknown"),
        sample_id=sample_dir.name,
    )
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd D:/pcgex-gnn
python -m pytest tests/test_processor.py -v
```
Expected: all 6 tests PASS

- [ ] **Step 5: Commit**

```bash
cd D:/pcgex-gnn
git add src/data/processor.py tests/test_processor.py
git commit -m "feat: add sample processor — raw dirs to training tensors"
```

---

## Task 8: generate_data.py CLI

**Files:**
- Create: `D:/pcgex-gnn/scripts/generate_data.py`

Ties together: scraper → seed graphs → mutations → generator (UE execution) → write raw sample dirs. This is the main data generation entry point.

- [ ] **Step 1: Write the CLI script**

```python
# D:/pcgex-gnn/scripts/generate_data.py
"""
Usage:
  python scripts/generate_data.py --domain foliage --n 10 --host 127.0.0.1 --port 9001
  python scripts/generate_data.py --domain foliage --n 10 --from-scrape
"""
import argparse
import asyncio
import json
import time
import uuid
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).parent.parent))

from rich.console import Console
from rich.progress import track
from src.data.generator import UEBridgeClient, generate_sample
from src.data.mutations import mutate
from src.data.scraper import scrape_pcgex_docs

console = Console()
DATA_DIR = Path(__file__).parent.parent / "data" / "raw"

async def run(domain: str, n: int, host: str, port: int, from_scrape: bool) -> None:
    client = UEBridgeClient(host=host, port=port)
    await client.connect()
    console.print(f"[green]Connected to UE TCP bridge at {host}:{port}[/green]")

    # Seed graphs: scrape or load from data/raw/<domain>/seeds/
    seed_graphs: list[dict] = []
    if from_scrape:
        console.print("[yellow]Scraping PCGEx docs...[/yellow]")
        patterns = scrape_pcgex_docs()
        for p in patterns:
            if any(tag == domain for tag in p.domain_tags) and p.node_classes:
                seed_graphs.append({
                    "nodes": [
                        {"id": f"n{i}", "class": cls, "params": {}, "position": {"x": i * 250, "y": 0}}
                        for i, cls in enumerate(p.node_classes[:8])
                    ],
                    "edges": [
                        {"from_node": f"n{i}", "from_pin": "Out", "to_node": f"n{i+1}", "to_pin": "In"}
                        for i in range(len(p.node_classes[:8]) - 1)
                    ],
                    "domain": domain,
                })
        console.print(f"[green]Got {len(seed_graphs)} seed graphs from scrape[/green]")
    else:
        seed_dir = DATA_DIR / domain / "seeds"
        if not seed_dir.exists():
            console.print(f"[red]No seed graphs at {seed_dir}. Use --from-scrape or add seeds manually.[/red]")
            return
        for f in seed_dir.glob("*.json"):
            seed_graphs.append(json.loads(f.read_text()))

    if not seed_graphs:
        console.print("[red]No seed graphs found. Aborting.[/red]")
        return

    # Generate N variants across seed graphs
    generated = 0
    errors = 0
    for seed in seed_graphs:
        variants = mutate(seed, n=max(1, n // len(seed_graphs)))
        for variant in track(variants, description=f"[cyan]Executing variants for {domain}[/cyan]"):
            sample_id = str(uuid.uuid4())[:8]
            try:
                sample = await generate_sample(
                    client, variant,
                    graph_asset_path=f"/Game/PCGEx/Generated/{domain}_{sample_id}"
                )
            except RuntimeError as e:
                console.print(f"[red]  ✗ {sample_id}: {e}[/red]")
                errors += 1
                continue

            # Write raw sample
            sample_dir = DATA_DIR / domain / sample_id
            sample_dir.mkdir(parents=True)
            (sample_dir / "graph.json").write_text(json.dumps(variant, indent=2))
            (sample_dir / "stage_outputs.json").write_text(json.dumps(sample.stage_outputs, indent=2))
            (sample_dir / "meta.json").write_text(json.dumps({
                "domain": domain, "source": "generated",
                "mutations_applied": ["perturb_params"], "seed_id": seed.get("id", "unknown"),
            }, indent=2))
            total_points = sum(
                s.get("point_count", 0) for s in sample.stage_outputs.values()
            )
            normalized_ms = (sample.total_runtime_ms / max(total_points, 1)) * 1000
            (sample_dir / "runtime.json").write_text(json.dumps({
                "total_ms": sample.total_runtime_ms,
                "per_node_ms": {nid: s.get("runtime_ms", 0) for nid, s in sample.stage_outputs.items()},
                "normalized_ms": normalized_ms,
            }, indent=2))
            generated += 1
            console.print(f"  [green]✓[/green] {sample_id} — {total_points} pts — {sample.total_runtime_ms:.1f}ms")

    await client.disconnect()
    console.print(f"\n[bold green]Done:[/bold green] {generated} samples generated, {errors} errors")
    console.print(f"Samples at: {DATA_DIR / domain}/")

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Generate PCGEx training data")
    parser.add_argument("--domain", required=True, help="Domain name (e.g. foliage, roads)")
    parser.add_argument("--n", type=int, default=10, help="Number of variants to generate")
    parser.add_argument("--host", default="127.0.0.1", help="UE TCP bridge host")
    parser.add_argument("--port", type=int, default=9001, help="UE TCP bridge port")
    parser.add_argument("--from-scrape", action="store_true", help="Seed from PCGEx docs scrape")
    args = parser.parse_args()
    asyncio.run(run(args.domain, args.n, args.host, args.port, args.from_scrape))
```

- [ ] **Step 2: Run a smoke test (requires UE open)**

```bash
cd D:/pcgex-gnn
python scripts/generate_data.py --domain foliage --n 3 --from-scrape
```
Expected: connects to UE, generates 3 sample directories under `data/raw/foliage/`, prints progress.

If UE is not available: verify the script at least parses args and prints a connection error rather than crashing with an unhandled exception.

- [ ] **Step 3: Run full test suite to confirm nothing regressed**

```bash
cd D:/pcgex-gnn
python -m pytest tests/ -v
```
Expected: all tests PASS

- [ ] **Step 4: Commit**

```bash
cd D:/pcgex-gnn
git add scripts/generate_data.py
git commit -m "feat: add generate_data CLI — scrape → mutate → execute → save"
```

---

## Final Integration Check

- [ ] **Run all tests one final time**

```bash
cd D:/pcgex-gnn
python -m pytest tests/ -v --tb=short
```
Expected: all tests PASS, 0 errors

- [ ] **Verify directory structure is complete**

```bash
find D:/pcgex-gnn/src -name "*.py" | sort
find D:/pcgex-gnn/tests -name "*.py" | sort
```

- [ ] **Final commit**

```bash
cd D:/pcgex-gnn
git add .
git commit -m "chore: Plan 1 complete — data infrastructure ready"

cd D:/hayba
git add packages/hayba/src/gaea/knowledge/
git commit -m "chore: add pcgex domain registry and kb seed files"
```
