# PCGEx Exporter — Phase 1

Unreal Engine 5 Python script that extracts PCGEx graph topologies into standardized JSON files.

## Quick Start

### Option 1: Run from UE5 Output Log

1. Open UE5 with the PCGExExampleProject loaded
2. Open Window → Developer Tools → Output Log
3. Switch to the "Python" tab
4. Paste and run:

```python
import sys
sys.path.insert(0, "D:/pcgex_bridge/Plugins/PCGExBridge/Content/Python")
import pcgex_exporter
pcgex_exporter.export_all_graphs(
    source_dir="/Game/PCGExExampleProject",
    output_dir="D:/pcgex_bridge/Plugins/PCGExBridge/Bridge/pcgex_context"
)
```

### Option 2: Run as Editor Script

```python
import unreal
unreal.PythonScriptPlugin.exec_script("D:/pcgex_bridge/Plugins/PCGExBridge/Content/Python/run_in_ue.py")
```

## Output

Each PCGGraph asset becomes a JSON file in the output directory:

```
Bridge/pcgex_context/
├── ForestPaths.json
├── UrbanGrowth.json
├── ClusterTest.json
└── ...
```

## JSON Schema

See `docs/superpowers/specs/2026-04-03-pcgex-bridge-design.md` section 2 for the full schema.

---

## Phase 3: UE Bridge (Ingestion)

### Start the Bridge

```python
import sys
sys.path.insert(0, "D:/pcgex_bridge/Plugins/PCGExBridge/Content/Python")
import mcp_ue_bridge
mcp_ue_bridge.start_polling(
    inbox_dir="D:/pcgex_bridge/Plugins/PCGExBridge/Bridge/bridge_inbox",
    outbox_dir="D:/pcgex_bridge/Plugins/PCGExBridge/Bridge/bridge_outbox",
    poll_interval=1.0
)
```

### How It Works

1. Script polls `bridge_inbox/` every 1 second
2. When a new `.json` file appears, it validates and reconstructs the graph
3. Status is written to `bridge_outbox/<name>.json`
4. Already-processed files are skipped (tracked in memory)

### Status Values

| Status | Meaning |
|--------|---------|
| `pending` | No status file found yet |
| `success` | Graph was created and saved in UE |
| `error` | Something went wrong — check `details` for the error message |
