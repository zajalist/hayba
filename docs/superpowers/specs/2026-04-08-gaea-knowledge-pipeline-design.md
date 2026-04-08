# Gaea Knowledge Pipeline & Terrain Generation Design

**Date:** 2026-04-08
**Status:** Draft

## Overview

A multi-stage terrain generation pipeline backed by a comprehensive Gaea documentation knowledge layer, a DAG-based graph layout engine, and an improved archetype search system. The goal: AI-generated Gaea graphs that are accurate, well-organized, and follow real-world conventions — with a configurable self-critique step for complex terrains.

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                   Knowledge Layer                        │
│  ┌──────────────┐ ┌────────────────┐ ┌────────────────┐ │
│  │ node-ref.json│ │best-practices  │ │workflow-patterns│ │
│  │ (per-node    │ │.json (rules,   │ │.json (reusable │ │
│  │  ports,      │ │ conventions)   │ │ sub-chains)    │ │
│  │  params,     │ │                │ │                │ │
│  │  tips)       │ │                │ │                │ │
│  └──────────────┘ └────────────────┘ └────────────────┘ │
│  ┌──────────────┐ ┌────────────────┐                    │
│  │archetypes.json│ │cli-reference   │                    │
│  │(existing)    │ │.json           │                    │
│  └──────────────┘ └────────────────┘                    │
└─────────────────────────────────────────────────────────┘
         │                │                │
         ▼                ▼                ▼
┌─────────────────────────────────────────────────────────┐
│               Terrain Generation Pipeline                │
│                                                          │
│  ┌─────────┐  ┌──────────┐  ┌─────────┐  ┌──────────┐  │
│  │1. Intent│─▶│2. Knowl- │─▶│3. Graph │─▶│4. Layout │  │
│  │Analysis │  │edge Lookup│  │Design   │  │Planning  │  │
│  └─────────┘  └──────────┘  └─────────┘  └──────────┘  │
│                                                 │        │
│  ┌─────────┐  ┌──────────────────────┐          │        │
│  │6. Build │◀─│5. Critique (if       │◀─────────┘        │
│  │.terrain │  │   complexity > thresh)│                   │
│  └─────────┘  └──────────────────────┘                   │
└─────────────────────────────────────────────────────────┘
```

---

## 1. Knowledge Layer

Three new static JSON knowledge stores scraped from docs.gaea.app, stored in `packages/hayba/src/gaea/knowledge/gaea-docs/`.

### 1.1 node-reference.json

Scraped from `docs.gaea.app/reference/nodes/*`. One entry per Gaea node:

```json
{
  "Erosion2": {
    "category": "simulation",
    "description": "Advanced hydraulic erosion with sediment transport...",
    "ports": {
      "in": ["In", "Mask"],
      "out": ["Out", "Wear", "Flow", "Deposit"]
    },
    "parameters": {
      "Duration": { "type": "number", "default": 0.5, "range": [0, 1] },
      "RealScale": { "type": "boolean", "default": false }
    },
    "tips": [
      "Use after Mountain/Canyon for realism",
      "Chain multiple with decreasing duration"
    ],
    "phase_hint": "simulation",
    "typical_predecessors": ["Mountain", "Canyon", "Combine"],
    "typical_successors": ["Shaper", "ThermalShaper", "Snow"]
  }
}
```

The `typical_predecessors`/`typical_successors` fields are derived by cross-referencing node co-occurrence in archetypes, example .terrain files, and transcripts.

### 1.2 best-practices.json

Scraped from `docs.gaea.app/guides`, `docs.gaea.app/using`, and `docs.gaea.app/ui`:

```json
{
  "rules": [
    {
      "id": "bp-001",
      "category": "workflow",
      "rule": "Always erode before adding surface detail",
      "source": "guides/terrain-workflow"
    },
    {
      "id": "bp-002",
      "category": "performance",
      "rule": "Keep graphs under 50 nodes; use subgraphs for complex terrains",
      "source": "guides/optimization"
    },
    {
      "id": "bp-003",
      "category": "organization",
      "rule": "Group related nodes and label groups by phase",
      "source": "ui/graph-organization"
    }
  ]
}
```

### 1.3 workflow-patterns.json

Common reusable sub-chains extracted from guides and transcripts:

```json
{
  "erosion-chain": {
    "nodes": ["Erosion2", "ThermalShaper", "Sediments"],
    "connections": [
      { "from": "Erosion2", "fromPort": "Out", "to": "ThermalShaper", "toPort": "In" },
      { "from": "ThermalShaper", "fromPort": "Out", "to": "Sediments", "toPort": "In" }
    ],
    "description": "Standard erosion pipeline for realistic weathering",
    "when_to_use": "After base shape is established",
    "phase": "simulation"
  },
  "alpine-texture": {
    "nodes": ["Snow", "TextureBase", "SatMap", "Combine"],
    "connections": [],
    "description": "Alpine coloring with snow cap and rock texture",
    "when_to_use": "Lookdev phase for alpine/mountain biomes",
    "phase": "lookdev"
  }
}
```

### 1.4 cli-reference.json

Scraped from `docs.gaea.app/developers`. CLI flags, automation API details, build profiles. Feeds into swarmhost.ts improvements.

### 1.5 Knowledge Query

New file: `packages/hayba/src/gaea/knowledge/knowledge-store.ts`

```ts
export class KnowledgeStore {
  constructor(docsDir: string);

  /** Look up a specific node's full reference */
  getNode(nodeType: string): NodeReference | null;

  /** Get applicable best practices for a set of node types or a phase */
  getBestPractices(filter: { phase?: string; nodeTypes?: string[] }): BestPractice[];

  /** Find workflow patterns matching a description or phase */
  findPatterns(query: { phase?: string; description?: string }): WorkflowPattern[];

  /** Get all predecessors/successors for a node type */
  getNodeNeighbors(nodeType: string): { predecessors: string[]; successors: string[] };
}
```

---

## 2. Terrain Generation Pipeline

### Stage 1: Intent Analysis

Enhanced version of existing `analyzeQueryIntent`. Produces a `TerrainIntent`:

```ts
interface TerrainIntent {
  // Existing
  semanticWeight: number;
  topologyWeight: number;
  biomeWeight: number;
  phaseWeight: number;
  requiredNodes: string[];
  targetPhase?: string;

  // New
  biome: string | null;           // "alpine", "desert", etc.
  mood: string | null;            // "harsh", "serene", "dramatic"
  scale: string | null;           // "continental", "regional", "local"
  geologicalProcesses: string[];  // ["erosion", "volcanic", "glacial"]
  complexityScore: number;        // computed estimate for critique gating
  estimatedNodeCount: number;     // rough count for layout pre-allocation
}
```

Complexity score formula:

```ts
complexityScore =
  (estimatedNodeCount * 1.0) +
  (branchCount * 2.0) +
  (mergeCount * 1.5) +
  (textureNodeCount * 0.5)
```

### Stage 2: Knowledge Lookup

Queries all knowledge stores and returns a bundle:

```ts
interface TerrainKnowledge {
  topArchetypes: ScoredArchetype[];           // from archetype store
  relevantNodes: Map<string, NodeReference>;  // from node-reference
  applicableRules: BestPractice[];            // from best-practices
  suggestedPatterns: WorkflowPattern[];       // from workflow-patterns
}
```

### Stage 3: Graph Design

Takes `TerrainIntent` + `TerrainKnowledge`, produces a `GraphPlan`:

```ts
interface GraphPlan {
  nodes: Array<{
    id: string;
    type: string;
    params: Record<string, unknown>;
    phase: string;  // for layout grouping
  }>;
  edges: Array<{
    from: string;
    fromPort: string;
    to: string;
    toPort: string;
  }>;
}
```

Logic:
- Start from best archetype match
- Adapt topology based on intent (add Snow chain if alpine, add Rivers if hydrology detected)
- Use node-reference to resolve correct port names
- Use workflow-patterns to insert validated sub-chains
- Apply best-practice rules during construction

### Stage 4: Layout Planning

New DAG layout engine (see Section 3 below). Takes the unpositioned `GraphPlan` and produces:

```ts
interface PositionedGraphPlan extends GraphPlan {
  nodes: Array<GraphPlan['nodes'][0] & {
    position: { X: number; Y: number };
  }>;
}
```

### Stage 5: Critique (Conditional)

Triggered when `complexityScore >= critiqueThreshold`. Uses LLM review:

**Input:** `PositionedGraphPlan` + applicable best-practices + node-reference for all used nodes

**Checks:**
- Geological realism — erosion before surface detail? simulation after base shape?
- Port validity — does each connection use real ports from node-reference?
- Dead ends — any node whose output goes nowhere and isn't an export?
- Redundancy — consecutive identical nodes without parameter changes?
- Best practice violations — rules from best-practices.json applied to the graph

**Output:** Revised `PositionedGraphPlan` + `CritiqueReport`:

```ts
interface CritiqueReport {
  triggered: boolean;
  complexityScore: number;
  threshold: number;
  changes: Array<{
    type: 'added' | 'removed' | 'reordered' | 'reconnected';
    description: string;
    reason: string;
  }>;
  warnings: string[];
}
```

### Stage 6: Build

Existing `buildTerrainFile` in swarmhost.ts, modified to consume `PositionedGraphPlan` instead of computing positions internally. The `posX += 300` linear layout logic is removed in favor of positions from Stage 4.

---

## 3. DAG Layout Engine

New file: `packages/hayba/src/gaea/layout-engine.ts`

### Algorithm: Modified Sugiyama

1. **Topological sort** — determine node execution order via Kahn's algorithm
2. **Layer assignment** — longest-path from sources. Each node goes to `max(predecessor layers) + 1`
3. **Crossing minimization** — barycenter heuristic: within each layer, order nodes by average position of connected nodes in adjacent layers. Run 2 passes (forward + backward).
4. **Position assignment** — apply Gaea-convention coordinates

### Layout Constants

Derived from analysis of 16 example .terrain files:

```ts
const LAYOUT = {
  ORIGIN_X: 26400,      // leftmost node X position
  ORIGIN_Y: 26100,      // main flow line Y position
  H_SPACING: 300,       // horizontal gap between layers
  V_SPACING: 125,       // vertical gap between nodes in same layer
  BRANCH_OFFSET: 200,   // Y offset for secondary branches (texture, mask)
} as const;
```

### Special Positioning Rules

- **Parallel generators** (multiple primitives at layer 0) — same X, stacked vertically with V_SPACING
- **Combine/Merge nodes** — placed at median Y of their inputs
- **Texture/color branch** — nodes with phase "lookdev" offset below main flow by BRANCH_OFFSET
- **Export nodes** (Unreal, Mesher, LightX) — always rightmost layer
- **Mask inputs** — placed at Y + V_SPACING/2 below the node they feed into

### Public API

```ts
export function layoutGraph(
  nodes: Array<{ id: string; type: string; params: Record<string, unknown>; phase?: string }>,
  edges: Array<{ from: string; fromPort: string; to: string; toPort: string }>,
  nodeReference?: NodeReferenceMap
): Array<{ id: string; type: string; params: Record<string, unknown>; position: { X: number; Y: number } }>
```

---

## 4. Complexity Threshold & UE5 Plugin Settings

### Setting Location

Stored in the Hayba UE5 plugin's project settings, alongside existing terrain settings:

```json
{
  "hayba": {
    "terrain": {
      "critiqueThreshold": 15.0,
      "critiqueEnabled": true
    }
  }
}
```

### Complexity Formula

```
complexityScore =
  (nodeCount * 1.0) +
  (branchCount * 2.0) +
  (mergeCount * 1.5) +
  (textureNodeCount * 0.5)
```

Default threshold: `15.0` (~12-node graph with a couple of branches).

### UE5 Integration

Exposed in the HaybaMCPToolkit plugin's details panel:
- `Critique Threshold` — float slider, range 5.0–50.0, default 15.0
- `Enable Critique` — bool checkbox, default true

Read by the MCP server via the existing conventions/config system when the terrain pipeline runs.

---

## 5. Archetype Store Refactoring

Changes to `packages/hayba/src/gaea/knowledge/archetype-store.ts`:

### 5.1 LCS Sequence Matching

Replace `sequenceSimilarity` function. Current: linear position penalty (`-0.15` per mismatch). New: Longest Common Subsequence algorithm that rewards preserved relative order regardless of insertions.

```ts
function lcsLength(a: string[], b: string[]): number {
  const m = a.length, n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i-1].toLowerCase() === b[j-1].toLowerCase()
        ? dp[i-1][j-1] + 1
        : Math.max(dp[i-1][j], dp[i][j-1]);
    }
  }
  return dp[m][n];
}

function sequenceSimilarity(querySeq: string[], targetSeq: string[]): number {
  if (querySeq.length === 0) return 0;
  const lcs = lcsLength(querySeq, targetSeq);
  return lcs / Math.max(querySeq.length, targetSeq.length);
}
```

### 5.2 Intent Analysis Upgrades

- Word-boundary regex: `new RegExp(`\\b${node}\\b`)` instead of `q.includes(node)`
- Dynamic weights when nodes detected: `topologyWeight = 0.45`, `semanticWeight = 0.25`
- Expanded phase keywords:
  - `"hydrology"`, `"river"`, `"fluvial"` → simulation
  - `"primitive"`, `"generator"` → base
  - `"color"`, `"texture"`, `"satmap"` → lookdev

### 5.3 Sequence Score as Multiplier

Change scoring from:
```ts
score = ... + (sequenceScore * 0.2)  // additive
```
To:
```ts
const adjustedTopology = topologyScore * (1 + sequenceScore);  // multiplier
score = (semanticScore * w.semantic) + (adjustedTopology * w.topology) + ...
```

### 5.4 Phase Flexibility

If no `targetPhase` detected by intent analyzer, bypass the phase filter entirely instead of silently filtering. Current code at line 186-189 hard-filters on phase, dropping good matches.

### 5.5 Hardware-Aware Embeddings

In `ensureEmbeddings`, detect `os.cpus().length > 8`. If high-perf environment, use `embedBatch` from embedder.ts to process all missing archetypes in a single pass. Otherwise keep sequential to prevent memory pressure.

### 5.6 Preserved API

No changes to: `GaeaArchetypeSchema`, `SearchInput`, `ArchetypeStore` public methods. All changes are internal to scoring and embedding logic.

---

## 6. Doc Scraper

### Script

`packages/hayba/src/gaea/scripts/scrape-gaea-docs.ts`

Run as: `npx tsx packages/hayba/src/gaea/scripts/scrape-gaea-docs.ts`

### Scraping Strategy

| Section | URL Pattern | Output File | Extracted Data |
|---------|------------|-------------|----------------|
| Reference | `docs.gaea.app/reference/nodes/*` | `node-reference.json` | Node category, description, ports, parameters, tips |
| Guides | `docs.gaea.app/guides/*` | `best-practices.json`, `workflow-patterns.json` | Rules, conventions, reusable sub-chains |
| Using | `docs.gaea.app/using/*` | Merged into `best-practices.json` | Workflow methodology, terrain-building advice |
| UI | `docs.gaea.app/ui/*` | Merged into `best-practices.json` | Graph organization, grouping conventions |
| Developers | `docs.gaea.app/developers/*` | `cli-reference.json` | CLI flags, automation API, build profiles |

### Implementation Details

- Uses `fetch` (Node 18+) for HTTP requests
- HTML parsing with `cheerio` (lightweight, already common in Node ecosystem)
- Rate-limited: 1 request/second
- Output directory: `packages/hayba/src/gaea/knowledge/gaea-docs/`

### Enrichment Pass

After scraping, a second pass cross-references:
- Node-reference with existing archetypes
- Node co-occurrence in example .terrain files (16 files in `more_examples/`)
- Node mentions in transcripts (65+ transcript files)

This populates the `typical_predecessors`/`typical_successors` fields in node-reference.json.

---

## 7. New & Modified Files

### New Files
| File | Purpose |
|------|---------|
| `src/gaea/knowledge/knowledge-store.ts` | Query interface for doc-sourced knowledge |
| `src/gaea/knowledge/gaea-docs/node-reference.json` | Per-node reference data |
| `src/gaea/knowledge/gaea-docs/best-practices.json` | Rules and conventions |
| `src/gaea/knowledge/gaea-docs/workflow-patterns.json` | Reusable sub-chains |
| `src/gaea/knowledge/gaea-docs/cli-reference.json` | CLI/automation reference |
| `src/gaea/layout-engine.ts` | DAG layout algorithm |
| `src/gaea/layout-engine.test.ts` | Layout engine tests |
| `src/gaea/terrain-pipeline.ts` | 6-stage pipeline orchestrator |
| `src/gaea/terrain-pipeline.test.ts` | Pipeline tests |
| `src/gaea/scripts/scrape-gaea-docs.ts` | Doc scraper script |
| `src/tools/query-gaea-knowledge.ts` | MCP tool for node/practice lookups |

### Modified Files
| File | Changes |
|------|---------|
| `src/gaea/knowledge/archetype-store.ts` | LCS matching, intent upgrades, phase flexibility, scoring multiplier, hardware-aware embeddings |
| `src/gaea/knowledge/archetype-store.test.ts` | Updated tests for new scoring logic |
| `src/gaea/swarmhost.ts` | `buildTerrainFile` consumes `PositionedGraphPlan`, removes `posX += 300` |
| `src/tools/hayba-brainstorm-terrain.ts` | Uses pipeline stages 1-2 for richer brainstorming |
| `src/tools/hayba-create-terrain.ts` | Uses full pipeline stages 1-6 |
| `src/tools/index.ts` | Register `query-gaea-knowledge` tool |
| `src/config.ts` | Read `critiqueThreshold`/`critiqueEnabled` from settings |
| `Plugins/HaybaMCPToolkit/` | Add critique threshold/enabled to UE5 plugin settings panel |

---

## 8. Execution Order

1. **Scraper** — build the knowledge layer first (node-reference, best-practices, workflow-patterns, cli-reference)
2. **Knowledge store** — query interface for the scraped data
3. **Layout engine** — DAG positioning algorithm
4. **Archetype store refactoring** — LCS, intent, scoring improvements
5. **Terrain pipeline** — wire all stages together
6. **Critique system** — conditional self-review with threshold
7. **UE5 plugin settings** — expose critique threshold in editor
8. **MCP tool updates** — update brainstorm/create terrain tools, add query-gaea-knowledge
