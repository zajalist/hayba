# Gaea Knowledge Enrichment & Brainstorm Tool Design

**Date:** 2026-04-09
**Status:** Approved for Implementation

## Overview

Enrich the Gaea archetype knowledge base with deep node structure from .terrain files and transcripts, build a new RAG-powered brainstorm tool (`hayba_brainstorm_gaea`) as a mandatory gate before terrain creation, add standalone zone painter scratch sessions, and rename the existing brainstorm tool to `hayba_ue_landscape_pipeline`.

## Problem Statement

The current knowledge system is shallow:
- Archetypes list node names but lack connection graphs, port usage, parameter reasoning, and common mistakes
- 16 .terrain example files and 65+ transcripts are not being parsed into the knowledge base
- The AI can skip RAG entirely and hand-build generic graphs
- Zone masks are applied incorrectly — nodes with x,y position params (e.g. Mountain) get mask blending instead of position extraction
- `hayba_brainstorm_terrain` is a full UE pipeline being misused for simple Gaea terrain requests

---

## 1. Enriched Archetype Schema

Each entry in `archetypes.json` gains new fields alongside existing ones.

### New Fields

```jsonc
{
  "pattern_name": "Alpine Ridge System",
  "semantic_intent": "...",                    // existing — rewritten with geological depth
  "core_topology": ["Mountain", "Erosion2", "Autolevel"],  // existing — kept for quick display

  // NEW: Full connection graph
  "graph": {
    "nodes": [
      { "id": "peak", "type": "Mountain", "params": { "Scale": 1.5, "Height": 0.9, "Style": "Alpine" } },
      { "id": "erode", "type": "Erosion2", "params": { "Duration": 0.15, "Downcutting": 0.6 } },
      { "id": "level", "type": "Autolevel", "params": {} }
    ],
    "edges": [
      { "from": "peak", "fromPort": "Out", "to": "erode", "toPort": "In" },
      { "from": "erode", "fromPort": "Out", "to": "level", "toPort": "In" }
    ]
  },

  // NEW: Per-node reasoning
  "node_reasoning": {
    "peak": "Alpine style produces sharp ridges characteristic of glacial horn peaks. Scale 1.5 gives enough bulk for erosion to carve into without flattening.",
    "erode": "Low duration (0.15) preserves ridge sharpness — high duration would round everything into foothills."
  },

  // NEW: Common mistakes for this pattern
  "common_mistakes": [
    "Using Erosion2 duration > 0.5 on alpine terrain — destroys ridge definition",
    "Adding a mask to Mountain node instead of setting its x,y position directly"
  ],

  // NEW: Source traceability
  "sources": [
    { "type": "terrain_file", "name": "Snowymount.terrain" },
    { "type": "transcript", "video_id": "abc123", "timestamp": "4:32" }
  ],

  // Existing fields preserved
  "heuristic_parameters": { ... },
  "biome_tags": [...],
  "scale_reference": "...",
  "source_video_id": "...",
  "phase": "..."
}
```

### Schema Changes

| Field | Type | Purpose |
|-------|------|---------|
| `graph` | `{ nodes: Node[], edges: Edge[] }` | Full executable connection structure |
| `node_reasoning` | `Record<string, string>` | Per-node ID explanation of why this node and these params |
| `common_mistakes` | `string[]` | Pitfalls extracted from transcripts, forums, experience |
| `sources` | `Array<{ type, name/video_id, timestamp? }>` | Where this archetype was derived from |

### Embedding Text

The embedding vector for semantic search is computed from `semantic_intent`. With richer intent descriptions (geological depth), search quality improves without changing the embedding pipeline.

---

## 2. Node Reference Enrichment

`node-reference.json` gains a `zone_strategy` classification per node type. This tells the AI how to handle zone painter data for each node.

### New Fields

```jsonc
{
  "Mountain": {
    "category": "primitive",
    "description": "...",
    "ports": { ... },
    "parameters": { ... },
    "zone_strategy": "position",
    "position_params": ["X", "Y"],
    // ... existing fields
  },
  "Island": {
    "zone_strategy": "mask",
    "position_params": [],
  },
  "Erosion2": {
    "zone_strategy": "none",
    "position_params": [],
  }
}
```

### Zone Strategy Values

| Strategy | Meaning | AI Behavior |
|----------|---------|-------------|
| `"position"` | Node has x,y params | Extract coordinates from zone mask centroid, set params directly. Do NOT add a mask node in Gaea. |
| `"mask"` | Node lacks x,y params | Load zone mask as a File node, Blur for soft edges, feed into node's Mask port. |
| `"none"` | Processing node | Not position-dependent. No zone handling needed. |

### Classification Scope

Every node in `node-reference.json` must have `zone_strategy` set. The parser script (Section 3) classifies based on whether the node's parameter list includes position-like params (X, Y, PosX, PosY, Position).

---

## 3. .terrain File Parser & Transcript Matcher

Two automated scripts + a manual enrichment workflow.

### 3.1 .terrain Parser Script

**File:** `packages/hayba/src/gaea/scripts/parse-terrain-files.ts`

**Input:** 16 .terrain files in `packages/hayba/src/gaea/knowledge/more_examples/`

**Process:**
1. Parse XML structure of each .terrain file
2. Extract: node types, node IDs, parameter values, connections (with port names), node positions
3. Output structured JSON per file

**Output per file:**
```jsonc
{
  "source_file": "Snowymount.terrain",
  "nodes": [
    { "id": "Mountain_1", "type": "Mountain", "params": { "Scale": 1.2, "Height": 0.8 }, "position": { "X": 26400, "Y": 26100 } }
  ],
  "edges": [
    { "from": "Mountain_1", "fromPort": "Out", "to": "Erosion2_1", "toPort": "In" }
  ]
}
```

**Output location:** `packages/hayba/src/gaea/knowledge/parsed-terrains/`

### 3.2 Transcript Matcher Script

**File:** `packages/hayba/src/gaea/scripts/match-transcripts.ts`

**Input:** Parsed .terrain structures + 65+ transcript files

**Process:**
1. For each parsed .terrain file, search transcripts for keyword matches (terrain name, node types used, biome terms)
2. Extract relevant snippets where parameter values or workflow reasoning is discussed
3. Output matched pairs: parsed graph + relevant transcript excerpts

**Output per file:**
```jsonc
{
  "source_file": "Snowymount.terrain",
  "transcript_matches": [
    {
      "video_id": "abc123",
      "timestamp": "4:32",
      "snippet": "I keep the erosion duration low here because we want to preserve those sharp alpine ridges..."
    }
  ]
}
```

### 3.3 Manual Enrichment via Opencode

Not automated code — a workflow:

1. Open a separate terminal with opencode
2. Feed it the parsed graph structure + matched transcript snippets for a .terrain file
3. Prompt it to produce:
   - `semantic_intent` with geological depth
   - `node_reasoning` per node
   - `common_mistakes` from transcript context
   - Determine if file contains one or multiple archetype patterns
4. Review output, edit as needed, merge into `archetypes.json`

This ensures human-in-the-loop quality control on the enrichment.

---

## 4. `hayba_brainstorm_gaea` Tool

New multi-turn, RAG-powered brainstorm tool. Mandatory gate before `hayba_create_terrain`.

### Tool Signature

```ts
hayba_brainstorm_gaea({
  prompt: string,              // terrain description
  step?: "start" | "followup" | "zones" | "finalize",
  answer?: string,             // user's answer to follow-up question
  scratchSessionId?: string,   // from standalone painter, if used
})
```

### Flow

```
User: "make me an alpine mountain"
    ↓
AI calls hayba_brainstorm_gaea(prompt: "alpine mountain", step: "start")
    ↓
Tool internally runs:
  - searchGaeaArchetypes("alpine mountain")
  - queryGaeaKnowledge(phase, node types)
  - Pull best practices + common mistakes
    ↓
Tool returns:
  - Top archetype matches with full graph + node_reasoning
  - Applicable best practices & common mistakes
  - Follow-up questions if prompt is ambiguous
  - Suggested graph plan synthesized from archetypes
    ↓
AI reasons through results (explicit reasoning protocol)
AI asks user if they want to draw zones → only if user agrees:
    ↓
AI calls hayba_brainstorm_gaea(step: "zones")
  → Opens standalone painter, returns URL + scratch session ID
    ↓
User draws, AI reads zones
AI applies zone_strategy per node from node-reference
    ↓
AI calls hayba_brainstorm_gaea(step: "finalize", scratchSessionId: "...")
  → Returns final graph plan
    ↓
AI calls hayba_create_terrain with the graph
```

### Step Returns

**`start`:**
```jsonc
{
  "step": "start",
  "archetypes": [/* top matches with full graph, node_reasoning, common_mistakes */],
  "best_practices": [/* applicable rules */],
  "workflow_patterns": [/* matching sub-chains */],
  "follow_up_questions": ["What scale? Small intimate or epic?", "Erosion style: sharp ridges or soft rolling?"],
  "suggested_plan": { /* synthesized graph from best archetype match */ },
  "node_zone_strategies": { "Mountain": "position", "Island": "mask" }
}
```

**`followup`:** Same structure, refined based on answers. May return more questions or a finalized plan.

**`zones`:** Returns `{ scratchSessionId, painterUrl }`. AI asks user to draw, then reads zones.

**`finalize`:** Returns `{ finalGraph, reasoning }` — the complete graph plan ready for `create_terrain`.

### Tool Description

```
"Brainstorm a Gaea terrain through RAG-powered knowledge search and multi-turn 
refinement. Returns archetype matches, best practices, common mistakes, and a 
synthesized graph plan.

IMPORTANT: Always call this tool before hayba_create_terrain. The brainstorm 
performs RAG search, knowledge lookup, and graph planning essential for quality 
terrain output. Do NOT build a Gaea graph without first brainstorming through 
this tool."
```

### New Files

| File | Purpose |
|------|---------|
| `src/tools/hayba-brainstorm-gaea.ts` | Tool handler |
| `src/tools/hayba-brainstorm-gaea.test.ts` | Tests |

---

## 5. Standalone Zone Painter (Scratch Sessions)

Temporary drawing sessions without a project. Used by `hayba_brainstorm_gaea` when the AI asks and user agrees to draw zone positions.

### API

- `POST /api/zones/scratch-session` → `{ scratchSessionId: string }`
- Zones stored in `<projects_base>/.scratch/<scratchSessionId>/`
- Painter URL: `http://127.0.0.1:<port>/#scratch/<scratchSessionId>/zones`
- `hayba_read_zones` extended to accept `scratchSessionId` as alternative to `projectId`

### Lifecycle

1. Brainstorm tool creates scratch session → returns URL
2. User draws zones, clicks submit
3. AI reads zones via `hayba_read_zones(scratchSessionId: "...")`
4. If user proceeds to a full UE pipeline later, scratch data can be adopted into a real project
5. Scratch sessions auto-expire after 24 hours (cleanup on server start)

### Changes

| File | Change |
|------|--------|
| `src/zones.ts` | Add scratch session CRUD (create, read, cleanup) |
| `src/tools/hayba-read-zones.ts` | Accept `scratchSessionId` as alternative to `projectId` |
| `dashboard/src/` | Handle `/#scratch/<id>/zones` URL pattern |
| `src/dashboard/api.ts` | Add `/api/zones/scratch-session` endpoint |

---

## 6. Rename `hayba_brainstorm_terrain` → `hayba_ue_landscape_pipeline`

### Changes

| From | To |
|------|-----|
| `src/tools/hayba-brainstorm-terrain.ts` | `src/tools/hayba-ue-landscape-pipeline.ts` |
| Tool name: `hayba_brainstorm_terrain` | `hayba_ue_landscape_pipeline` |
| Export: `brainstormTerrainHandler` | `ueLandscapePipelineHandler` |

### Updated Description

```
"Full UE landscape project pipeline: guided brainstorm → zone painting → 
Gaea terrain generation → bake → import into Unreal Engine → foliage zones. 
Use this for major landscape projects that will be imported into UE5. 
For standalone Gaea terrain work, use hayba_brainstorm_gaea instead."
```

### Preview Step Fix

The `preview` step (currently lines 182-322 of `hayba-brainstorm-terrain.ts`) replaces its hardcoded Perlin+Mountain+Combine graph construction with:
1. RAG lookup using enriched archetypes
2. Zone strategy from node-reference (position vs mask per node type)
3. Knowledge-informed graph synthesis

This reuses the same knowledge pipeline that `hayba_brainstorm_gaea` uses.

---

## 7. RAG Enforcement

Three layers ensure the AI always uses the knowledge system.

### Layer 1: Tool Descriptions

`hayba_create_terrain` description updated:
```
"IMPORTANT: Do NOT call this tool without first calling hayba_brainstorm_gaea. 
The brainstorm tool performs RAG search, knowledge lookup, and graph planning 
that is essential for quality terrain output."
```

### Layer 2: Brainstorm Tool Always Surfaces Knowledge

Every response from `hayba_brainstorm_gaea` includes:
- Matched archetypes with full graphs and node reasoning
- Applicable best practices
- Common mistakes for the matched pattern
- Node zone_strategy lookups for all nodes in the plan

The AI cannot avoid seeing this information — it's embedded in the tool response.

### Layer 3: Soft Gate on `create_terrain`

When `create_terrain` is called, it checks if a brainstorm session exists. If not:
```
"Warning: No brainstorm session found. Call hayba_brainstorm_gaea first 
for better results. Proceeding anyway."
```

Not a hard block — keeps `create_terrain` usable for power-user scenarios.

---

## 8. New & Modified Files

### New Files

| File | Purpose |
|------|---------|
| `src/gaea/scripts/parse-terrain-files.ts` | Parse .terrain XML into structured JSON |
| `src/gaea/scripts/match-transcripts.ts` | Match parsed terrains against transcript files |
| `src/gaea/knowledge/parsed-terrains/` | Output directory for parsed .terrain structures |
| `src/tools/hayba-brainstorm-gaea.ts` | New RAG-powered brainstorm tool |
| `src/tools/hayba-brainstorm-gaea.test.ts` | Tests |
| `src/tools/hayba-ue-landscape-pipeline.ts` | Renamed from hayba-brainstorm-terrain.ts |

### Modified Files

| File | Change |
|------|--------|
| `src/gaea/knowledge/archetypes.json` | Enriched entries with graph, node_reasoning, common_mistakes, sources |
| `src/gaea/knowledge/gaea-docs/node-reference.json` | Add zone_strategy + position_params per node |
| `src/gaea/knowledge/types.ts` | Updated GaeaArchetype schema with new fields |
| `src/tools/index.ts` | Register hayba_brainstorm_gaea, rename brainstorm_terrain registration |
| `src/tools/hayba-create-terrain.ts` | Add soft gate warning, update description |
| `src/tools/hayba-read-zones.ts` | Accept scratchSessionId |
| `src/zones.ts` | Add scratch session CRUD + cleanup |
| `src/dashboard/api.ts` | Add scratch session endpoint |
| `dashboard/src/` | Handle scratch URL pattern |

### Deleted Files

| File | Reason |
|------|--------|
| `src/tools/hayba-brainstorm-terrain.ts` | Renamed to hayba-ue-landscape-pipeline.ts |

---

## 9. Execution Order

1. **.terrain parser script** — parse all 16 files into structured JSON
2. **Transcript matcher script** — find matching transcript excerpts
3. **Node reference enrichment** — add zone_strategy to all nodes
4. **Manual archetype enrichment** — via opencode, using parsed data + transcripts
5. **Schema updates** — update GaeaArchetype types for new fields
6. **`hayba_brainstorm_gaea` tool** — build the new brainstorm tool
7. **Scratch sessions** — standalone zone painter support
8. **Rename + fix `hayba_ue_landscape_pipeline`** — rename and rewire preview step
9. **RAG enforcement** — update tool descriptions and soft gate
