# PCGEx MCP Debug Rework — Design Spec
**Date:** 2026-04-05  
**Status:** Approved  
**Scope:** Structured AI debugging protocol for PCGEx graphs, with plugin-controlled inquisitiveness mode

---

## Problem

Claude can create, validate, and execute PCGEx graphs but has no feedback loop after execution. When UE rejects a graph or produces silent bad output (empty results, wrong geometry, partial execution), Claude cannot determine what went wrong. Specifically:

- `execute_pcg_graph` returns only `{ executed, duration, results[] }` — no per-node output data
- Claude injects debug nodes via `inject_debug_nodes` / `auto_wire_debug_overlay` but never reads their output
- Debug nodes are never removed — they pollute the final graph permanently
- Claude has no structured protocol for confirming its diagnosis before attempting a fix

---

## Solution Overview

Four layers working together:

1. **Plugin UI setting** — user controls how inquisitive Claude is during debugging
2. **New C++ TCP commands** — expose per-node execution data, config, and debug node removal
3. **New MCP tools** — two debug workflow tools (Fast and Thorough) plus primitives
4. **Behavior routing** — Claude reads inquisitiveness mode before every debug session and routes accordingly

---

## Layer 1: Plugin UI — AI Debug Behavior

New section added to the existing `PCGExWizardWidget` Slate panel (Window menu):

```
┌─ AI Debug Behavior ──────────────────────────────┐
│                                                    │
│  Inquisitiveness Mode:  [Thorough ▼]               │
│                                                    │
│  ○ Silent   — diagnose & fix automatically         │
│  ● Thorough — confirm each step (recommended)      │
│  ○ Fast     — single diagnosis, one confirmation   │
│                                                    │
│  [✓] Always ask before removing debug nodes        │
│      (overrides mode — always on by default)       │
│                                                    │
└────────────────────────────────────────────────────┘
```

**New fields on `UPCGExBridgeSettings`:**
- `EPCGExInquisitivenessMode InquisitivenessMode` — enum: `Silent` | `Fast` | `Thorough`, default `Thorough`
- `bool bAlwaysConfirmDebugNodeRemoval` — default `true`; user can uncheck to allow Silent mode to skip cleanup confirmation

Both persisted to `.ini` via existing settings system.

---

## Layer 2: New C++ TCP Commands

All added to `FPCGExBridgeCommandHandler`. Follow existing request/response framing (4-byte length prefix + JSON).

### `get_bridge_config`
**Params:** none  
**Returns:**
```json
{
  "inquisitivenessMode": "fast" | "thorough" | "silent",
  "alwaysConfirmDebugNodeRemoval": true,
  "tcpPort": 52342,
  "dashboardPort": 52341,
  "pluginVersion": "0.2.0"
}
```

### `get_node_execution_data`
**Params:** `assetPath: string`, `maxSampleRows?: number` (default 10)  
Always re-executes the graph fresh (no caching) and walks each node to collect output data.  
**Returns:**
```json
{
  "assetPath": "/Game/...",
  "executedAt": "ISO8601",
  "nodes": [
    {
      "id": "node_003",
      "class": "UPCGExBuildDelaunayGraph2DSettings",
      "label": "Delaunay 2D",
      "outputPointCount": 0,
      "outputPins": ["Vtx", "Edges"],
      "attributes": ["Position", "PCGEx/VtxEndpoint"],
      "sampleRows": [],
      "status": "executed" | "skipped" | "error",
      "errorMessage": "string | null"
    }
  ]
}
```

`outputPointCount: 0` on a non-terminal node is the primary signal — it marks where data flow stopped. `status: "skipped"` means the node was not reached. `status: "error"` includes `errorMessage`.

### `remove_debug_nodes`
**Params:** `assetPath: string`, `labelPrefix?: string` (default `"DBG"`)  
Finds all nodes whose label starts with `labelPrefix`, removes them, and rewires the original edges they interrupted.  
**Returns:**
```json
{
  "removed": 4,
  "rewired": 4,
  "assetPath": "/Game/..."
}
```

---

## Layer 3: New MCP Tools

### `read_node_output`
Thin wrapper around `get_node_execution_data`. Used internally by both debug workflow tools and available standalone for manual inspection.

**Params:** `assetPath`, `maxSampleRows?`  
**Returns:** Full node execution data response.

---

### `remove_debug_nodes`
Thin wrapper around the C++ `remove_debug_nodes` command. Claude **never calls this silently** — it always presents:

> *"Debugging complete. I injected N debug nodes with prefix DBG. Should I remove them, or would you like to keep them to inspect in the PCG editor?"*

**Params:** `assetPath`, `labelPrefix?`  
**Returns:** `{ removed, rewired }`

---

### `debug_graph` — Fast mode (Option A)
Single-pass workflow. Tool description encodes the protocol so Claude follows it without external orchestration:

1. Call `read_node_output` → find first node where `outputPointCount === 0` or `status === "error"`
2. Call `auto_wire_debug_overlay` with `edgeFilter` targeting edges around the suspect node only
3. Call `execute_pcg_graph`
4. Call `read_node_output` again → read debug node output data
5. Form a single diagnosis + proposed fix
6. Present to user: *"I believe [X] because [evidence]. Does that match what you see?"*
7. If confirmed → apply fix
8. Call `remove_debug_nodes` (with user confirmation unless `bAlwaysConfirmDebugNodeRemoval` is false)

**Params:** `assetPath`, `suspectedNodes?: string[]` (optional — Claude picks if omitted)

---

### `start_debug_session` — Thorough mode (Option B)
Five-phase doctor protocol. Each phase stops and waits for user response before proceeding.

**Params:** `assetPath`, `symptom: string` (user's description of what's wrong)

**Phase 1 — Symptom confirmation**
Call `read_node_output`. Present the raw execution data.  
Ask: *"I can see [node X output 0 points] and [node Y was skipped]. Is that consistent with what you observed, or is the problem somewhere else?"*  
Wait. If user redirects, update the suspect list.

**Phase 2 — Hypothesis confirmation**
State hypothesis explicitly.  
Ask: *"My hypothesis is [Z — e.g. the Delaunay node has no input points because the sampler upstream produced 0 output]. Should I inject debug nodes on [these specific edges] to verify?"*  
Wait for approval before injecting anything.

**Phase 3 — Evidence**
Inject targeted debug nodes. Execute. Call `read_node_output`. Present the attribute data table.  
Ask: *"The debug data shows [A — e.g. the sampler output 0 points, confirming the input is empty]. Does that confirm the problem?"*  
Wait. If user disagrees, revise hypothesis and return to Phase 2.

**Phase 4 — Fix confirmation**
Propose the exact change with specifics.  
Ask: *"I'll fix this by [e.g. replacing the surface sampler seed from 0 to 42 and adding a fallback point]. Approve?"*  
Wait. Apply only after explicit approval.

**Phase 5 — Cleanup**
Apply fix. Then call `remove_debug_nodes` with user confirmation:  
*"Fix applied. Should I remove the N debug nodes, or leave them so you can inspect the graph?"*

---

## Layer 4: Behavior Routing

Before starting any debug workflow, Claude calls `get_bridge_config` and reads `inquisitivenessMode`:

| Mode | Tool used | Diagnosis confirmation | Fix confirmation | Cleanup confirmation |
|------|-----------|----------------------|-----------------|---------------------|
| `thorough` | `start_debug_session` | Yes — Phase 1+2+3 | Yes — Phase 4 | Yes — Phase 5 |
| `fast` | `debug_graph` | Single step | Single step | Yes (always) |
| `silent` | `debug_graph` | Skipped | Skipped | Yes (always, locked) |

`bAlwaysConfirmDebugNodeRemoval: true` overrides all modes for the cleanup step — Claude always asks before removing debug nodes regardless of mode.

---

## Error Handling

- **UE not connected:** `get_node_execution_data` fails gracefully — Claude falls back to static graph analysis using `validate_attribute_flow` and `export_pcg_graph` only, and tells the user UE is not reachable
- **No nodes with 0 output:** Graph may have executed correctly — Claude reports this and asks the user to describe the symptom more specifically
- **Debug node injection fails:** Claude reports which edges could not be instrumented and proceeds with available data
- **Fix application fails:** Claude does not retry silently — reports the failure and asks the user how to proceed
- **`remove_debug_nodes` partial failure:** Reports how many were removed vs. how many remain, advises manual cleanup in PCG editor

---

## What This Does Not Cover

The following features from the original request are **out of scope for this spec** and will be separate specs:
- Bidirectional graph editing
- Expanded biome and template library  
- Visual preview in Claude
- PCGEx graph marketplace
- Automated level assembly

---

## Files Affected

| Layer | File | Change |
|-------|------|--------|
| C++ | `PCGExBridgeCommandHandler.h/.cpp` | 3 new command handlers |
| C++ | `PCGExBridgeSettings.h/.cpp` | 2 new fields + enum |
| C++ | `PCGExWizardWidget.h/.cpp` | New UI section |
| TS | `src/tools/read-node-output.ts` | New tool file |
| TS | `src/tools/remove-debug-nodes.ts` | New tool file |
| TS | `src/tools/debug-graph.ts` | New tool file (Option A) |
| TS | `src/tools/start-debug-session.ts` | New tool file (Option B) |
| TS | `src/tools/index.ts` | Register 4 new tools |
| TS | `src/dashboard/api.ts` | Expose new endpoints |
