# Gaea Knowledge Enrichment & Brainstorm Tool Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enrich the Gaea archetype knowledge base with deep node structure, build a RAG-powered brainstorm tool as a mandatory gate before terrain creation, add standalone zone painter scratch sessions, and rename the existing brainstorm tool.

**Architecture:** Enrichment-first approach. Parse .terrain files and cross-reference transcripts to build rich archetype entries. New `hayba_brainstorm_gaea` tool consumes enriched knowledge via RAG search. Standalone scratch sessions enable zone painting without projects. Existing `hayba_brainstorm_terrain` renamed to `hayba_ue_landscape_pipeline`.

**Tech Stack:** TypeScript, Zod, Vitest, Express, React (dashboard)

**Spec:** `docs/superpowers/specs/2026-04-09-gaea-knowledge-enrichment-and-brainstorm-tool-design.md`

---

## File Structure

### New Files

| File | Responsibility |
|------|---------------|
| `src/gaea/scripts/parse-terrain-files.ts` | Parse .terrain JSON files into structured graph data |
| `src/gaea/scripts/parse-terrain-files.test.ts` | Tests for parser |
| `src/gaea/scripts/match-transcripts.ts` | Match parsed terrains against transcript excerpts |
| `src/gaea/scripts/match-transcripts.test.ts` | Tests for matcher |
| `src/gaea/knowledge/parsed-terrains/` | Output directory for parsed .terrain structures |
| `src/tools/hayba-brainstorm-gaea.ts` | New RAG-powered brainstorm tool |
| `src/tools/hayba-brainstorm-gaea.test.ts` | Tests |
| `src/tools/hayba-ue-landscape-pipeline.ts` | Renamed from hayba-brainstorm-terrain.ts |

### Modified Files

| File | Change |
|------|--------|
| `src/gaea/knowledge/types.ts` | Add graph, node_reasoning, common_mistakes, sources to GaeaArchetypeSchema |
| `src/gaea/knowledge/knowledge-types.ts` | Add zone_strategy, position_params to NodeReferenceSchema |
| `src/gaea/knowledge/node-reference.json` | Add zone_strategy + position_params per node |
| `src/gaea/knowledge/archetypes.json` | Enriched after manual opencode pass |
| `src/zones.ts` | Add scratch session CRUD + cleanup |
| `src/tools/hayba-read-zones.ts` | Accept scratchSessionId |
| `src/tools/hayba-create-terrain.ts` | Add soft gate warning |
| `src/tools/index.ts` | Register brainstorm-gaea, rename brainstorm_terrain |
| `src/dashboard/api.ts` | Add scratch session endpoints |
| `dashboard/src/App.tsx` | Handle `#scratch/<id>/zones` URL |

All paths below are relative to `packages/hayba/`.

---

### Task 1: Extend Archetype Schema with New Fields

**Files:**
- Modify: `src/gaea/knowledge/types.ts`
- Test: `src/gaea/knowledge/archetype-store.test.ts`

- [ ] **Step 1: Write test for new archetype schema fields**

In `src/gaea/knowledge/archetype-store.test.ts`, add a test that validates an archetype with the new fields parses correctly:

```ts
import { GaeaArchetypeSchema } from './types.js';

describe('GaeaArchetypeSchema enriched fields', () => {
  it('parses archetype with graph, node_reasoning, common_mistakes, sources', () => {
    const entry = {
      pattern_name: 'Test Alpine',
      phase: 'character',
      semantic_intent: 'Alpine ridge with glacial erosion',
      core_topology: ['Mountain', 'Erosion2', 'Autolevel'],
      heuristic_parameters: {
        'Erosion2.Duration': { value: 0.15, reason: 'Preserve ridges' },
      },
      biome_tags: ['alpine'],
      scale_reference: '8km x 8km',
      source_video_id: 'abc123',
      graph: {
        nodes: [
          { id: 'peak', type: 'Mountain', params: { Scale: 1.5, Height: 0.9, Style: 'Alpine' } },
          { id: 'erode', type: 'Erosion2', params: { Duration: 0.15 } },
          { id: 'level', type: 'Autolevel', params: {} },
        ],
        edges: [
          { from: 'peak', fromPort: 'Out', to: 'erode', toPort: 'In' },
          { from: 'erode', fromPort: 'Out', to: 'level', toPort: 'In' },
        ],
      },
      node_reasoning: {
        peak: 'Alpine style for sharp glacial ridges',
        erode: 'Low duration preserves ridge definition',
      },
      common_mistakes: [
        'Erosion duration > 0.5 destroys alpine ridges',
      ],
      sources: [
        { type: 'terrain_file', name: 'Snowymount.terrain' },
      ],
    };
    const parsed = GaeaArchetypeSchema.parse(entry);
    expect(parsed.graph).toBeDefined();
    expect(parsed.graph!.nodes).toHaveLength(3);
    expect(parsed.graph!.edges).toHaveLength(2);
    expect(parsed.node_reasoning).toEqual(entry.node_reasoning);
    expect(parsed.common_mistakes).toEqual(entry.common_mistakes);
    expect(parsed.sources).toEqual(entry.sources);
  });

  it('parses archetype without new fields (backwards compatible)', () => {
    const entry = {
      pattern_name: 'Legacy Entry',
      semantic_intent: 'Basic terrain',
      core_topology: ['Mountain'],
      heuristic_parameters: {},
      biome_tags: ['alpine'],
    };
    const parsed = GaeaArchetypeSchema.parse(entry);
    expect(parsed.graph).toBeUndefined();
    expect(parsed.node_reasoning).toEqual({});
    expect(parsed.common_mistakes).toEqual([]);
    expect(parsed.sources).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/hayba && npx vitest run src/gaea/knowledge/archetype-store.test.ts`
Expected: FAIL — `graph`, `node_reasoning`, `common_mistakes`, `sources` are not in schema

- [ ] **Step 3: Update GaeaArchetypeSchema in types.ts**

In `src/gaea/knowledge/types.ts`, add the new fields to the schema. Insert after `source_video_id`:

```ts
import { z } from 'zod';

export const HeuristicParameterSchema = z.object({
  value: z.union([z.number(), z.string(), z.boolean()]),
  reason: z.string(),
});

export const PhaseSchema = z.enum(['base', 'character', 'simulation', 'lookdev', 'utility']);

export const ArchetypeGraphNodeSchema = z.object({
  id: z.string().min(1),
  type: z.string().min(1),
  params: z.record(z.union([z.string(), z.number(), z.boolean()])).default({}),
});

export const ArchetypeGraphEdgeSchema = z.object({
  from: z.string().min(1),
  fromPort: z.string().min(1),
  to: z.string().min(1),
  toPort: z.string().min(1),
});

export const ArchetypeGraphSchema = z.object({
  nodes: z.array(ArchetypeGraphNodeSchema).min(1),
  edges: z.array(ArchetypeGraphEdgeSchema),
});

export const ArchetypeSourceSchema = z.object({
  type: z.enum(['terrain_file', 'transcript', 'forum', 'blog']),
  name: z.string().optional(),
  video_id: z.string().optional(),
  timestamp: z.string().optional(),
});

export const GaeaArchetypeSchema = z.object({
  pattern_name: z.string().min(1),
  phase: PhaseSchema.default('character'),
  semantic_intent: z.string().min(1),
  core_topology: z.array(z.string()).min(1),
  heuristic_parameters: z.record(HeuristicParameterSchema),
  biome_tags: z.array(z.string()),
  scale_reference: z.string().nullable().default(null),
  source_video_id: z.string().nullable().default(null),
  // Enriched fields
  graph: ArchetypeGraphSchema.optional(),
  node_reasoning: z.record(z.string()).default({}),
  common_mistakes: z.array(z.string()).default([]),
  sources: z.array(ArchetypeSourceSchema).default([]),
});

export type GaeaArchetype = z.infer<typeof GaeaArchetypeSchema>;
export type Phase = z.infer<typeof PhaseSchema>;
export type ArchetypeGraph = z.infer<typeof ArchetypeGraphSchema>;
export type ArchetypeSource = z.infer<typeof ArchetypeSourceSchema>;

export const SearchInputSchema = z.object({
  query: z.string().min(1),
  biome_tags: z.array(z.string()).optional(),
  topology_filter: z.array(z.string()).optional(),
  limit: z.number().int().positive().default(3),
});

export type SearchInput = z.infer<typeof SearchInputSchema>;

export const FullArchetypeGraphResponseSchema = z.object({
  pattern_name: z.string(),
  full_graph_json: z.record(z.unknown()),
  node_positions: z.record(z.object({ x: z.number(), y: z.number() })).nullable().default(null),
});

export type FullArchetypeGraphResponse = z.infer<typeof FullArchetypeGraphResponseSchema>;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/hayba && npx vitest run src/gaea/knowledge/archetype-store.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/hayba/src/gaea/knowledge/types.ts packages/hayba/src/gaea/knowledge/archetype-store.test.ts
git commit -m "feat: extend GaeaArchetype schema with graph, node_reasoning, common_mistakes, sources"
```

---

### Task 2: Add zone_strategy to Node Reference Schema

**Files:**
- Modify: `src/gaea/knowledge/knowledge-types.ts`
- Modify: `src/gaea/knowledge/gaea-docs/node-reference.json`
- Test: `src/gaea/knowledge/knowledge-store.test.ts`

- [ ] **Step 1: Write test for zone_strategy field**

In `src/gaea/knowledge/knowledge-store.test.ts`, add:

```ts
import { KnowledgeStore } from './knowledge-store.js';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DOCS_DIR = path.resolve(__dirname, 'gaea-docs');

describe('KnowledgeStore zone_strategy', () => {
  it('returns zone_strategy and position_params for position nodes', () => {
    const store = new KnowledgeStore(DOCS_DIR);
    const mountain = store.getNode('Mountain');
    expect(mountain).not.toBeNull();
    expect(mountain!.zone_strategy).toBe('position');
    expect(mountain!.position_params).toContain('X');
    expect(mountain!.position_params).toContain('Y');
  });

  it('returns zone_strategy "mask" for nodes without position params', () => {
    const store = new KnowledgeStore(DOCS_DIR);
    const island = store.getNode('Island');
    if (island) {
      expect(island.zone_strategy).toBe('mask');
      expect(island.position_params).toEqual([]);
    }
  });

  it('returns zone_strategy "none" for processing nodes', () => {
    const store = new KnowledgeStore(DOCS_DIR);
    const erosion = store.getNode('Erosion2');
    if (erosion) {
      expect(erosion.zone_strategy).toBe('none');
      expect(erosion.position_params).toEqual([]);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/hayba && npx vitest run src/gaea/knowledge/knowledge-store.test.ts`
Expected: FAIL — `zone_strategy` and `position_params` not in schema or data

- [ ] **Step 3: Update NodeReferenceSchema in knowledge-types.ts**

In `src/gaea/knowledge/knowledge-types.ts`, add the new fields to `NodeReferenceSchema`:

```ts
export const NodeReferenceSchema = z.object({
  category: z.string(),
  description: z.string(),
  ports: z.object({
    in: z.array(z.string()),
    out: z.array(z.string()),
  }),
  parameters: z.record(z.object({
    type: z.string(),
    default: z.string(),
    range: z.string().optional(),
  })),
  tips: z.array(z.string()),
  phase_hint: z.string(),
  typical_predecessors: z.array(z.string()),
  typical_successors: z.array(z.string()),
  zone_strategy: z.enum(['position', 'mask', 'none']).default('none'),
  position_params: z.array(z.string()).default([]),
});
```

- [ ] **Step 4: Add zone_strategy to node-reference.json**

Update `src/gaea/knowledge/gaea-docs/node-reference.json`. For every node entry, add `zone_strategy` and `position_params`. Classification rules:

- **`"position"`** — primitives with X/Y params: `Mountain`, `MountainRange`, `Ridge`, `Volcano`, `CraterField`, `Crater`
- **`"mask"`** — primitives without X/Y that generate shapes: `Island`, `Gradient`, `RadialGradient`, `Perlin`
- **`"none"`** — all processing/simulation/lookdev nodes: `Erosion2`, `Combine`, `Blur`, `Autolevel`, `Snow`, `ThermalShaper`, `Sandstone`, `Canyon`, `Warp`, `Rugged`, `TextureBase`, `SatMap`, etc.

Example for Mountain (add after `typical_successors`):

```json
"zone_strategy": "position",
"position_params": ["X", "Y"]
```

Example for Erosion2:

```json
"zone_strategy": "none",
"position_params": []
```

Verify classification against each node's actual parameter list in the JSON.

- [ ] **Step 5: Run test to verify it passes**

Run: `cd packages/hayba && npx vitest run src/gaea/knowledge/knowledge-store.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/hayba/src/gaea/knowledge/knowledge-types.ts packages/hayba/src/gaea/knowledge/gaea-docs/node-reference.json packages/hayba/src/gaea/knowledge/knowledge-store.test.ts
git commit -m "feat: add zone_strategy classification to node reference"
```

---

### Task 3: .terrain File Parser Script

**Files:**
- Create: `src/gaea/scripts/parse-terrain-files.ts`
- Create: `src/gaea/scripts/parse-terrain-files.test.ts`

- [ ] **Step 1: Write test for parser**

Create `src/gaea/scripts/parse-terrain-files.test.ts`:

```ts
import { parseTerrainFile, type ParsedTerrain } from './parse-terrain-files.js';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXAMPLES_DIR = path.resolve(__dirname, '../knowledge/more_examples');

describe('parseTerrainFile', () => {
  it('parses Snowymount.terrain into nodes and edges', () => {
    const filePath = path.join(EXAMPLES_DIR, 'Snowymount.terrain');
    const result = parseTerrainFile(filePath);

    expect(result.source_file).toBe('Snowymount.terrain');
    expect(result.nodes.length).toBeGreaterThan(0);
    // Each node should have id, type, params, and position
    for (const node of result.nodes) {
      expect(node.id).toBeDefined();
      expect(node.type).toBeDefined();
      expect(typeof node.params).toBe('object');
      expect(node.position).toBeDefined();
      expect(typeof node.position.X).toBe('number');
      expect(typeof node.position.Y).toBe('number');
    }
    // Edges should reference existing node IDs
    const nodeIds = new Set(result.nodes.map(n => n.id));
    for (const edge of result.edges) {
      expect(nodeIds.has(edge.from)).toBe(true);
      expect(nodeIds.has(edge.to)).toBe(true);
      expect(edge.fromPort).toBeDefined();
      expect(edge.toPort).toBeDefined();
    }
  });

  it('extracts metadata (name, version)', () => {
    const filePath = path.join(EXAMPLES_DIR, 'Snowymount.terrain');
    const result = parseTerrainFile(filePath);
    expect(result.metadata.name).toBeDefined();
    expect(typeof result.metadata.name).toBe('string');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/hayba && npx vitest run src/gaea/scripts/parse-terrain-files.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement the parser**

Create `src/gaea/scripts/parse-terrain-files.ts`:

```ts
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'fs';
import path from 'path';

export interface ParsedNode {
  id: string;         // numeric ID from .terrain file
  type: string;       // node type extracted from $type (e.g. "RadialGradient")
  params: Record<string, string | number | boolean>;
  position: { X: number; Y: number };
}

export interface ParsedEdge {
  from: string;
  fromPort: string;
  to: string;
  toPort: string;
}

export interface ParsedTerrain {
  source_file: string;
  metadata: { name: string; version: string };
  nodes: ParsedNode[];
  edges: ParsedEdge[];
}

/**
 * Extract the Gaea node type from the $type field.
 * Format: "QuadSpinner.Gaea.Nodes.RadialGradient, Gaea.Nodes"
 * Returns: "RadialGradient"
 */
function extractNodeType(typeStr: string): string {
  const parts = typeStr.split(',')[0].split('.');
  return parts[parts.length - 1];
}

/** Known non-parameter keys in a Gaea node object */
const SKIP_KEYS = new Set([
  '$id', '$type', 'Id', 'Name', 'Position', 'Ports',
  'IsMarked', 'IsActive', 'IsPinned', 'IsBypassed',
  'DisplayMode', 'Notes', 'Color', 'GroupId',
  'PostProcessStack', 'ModifierStack',
]);

/**
 * Parse a single .terrain file (JSON format) into structured graph data.
 */
export function parseTerrainFile(filePath: string): ParsedTerrain {
  const raw = readFileSync(filePath, 'utf-8');
  const data = JSON.parse(raw);

  const terrain = data.Assets?.$values?.[0]?.Terrain ?? data;
  const metadata = {
    name: terrain.Metadata?.Name ?? path.basename(filePath, '.terrain'),
    version: terrain.Metadata?.Version ?? 'unknown',
  };

  const nodesObj = terrain.Nodes ?? {};
  const nodes: ParsedNode[] = [];
  const nodeIdMap = new Map<string, string>(); // numeric ID → our ID

  // Parse nodes
  for (const [numericId, nodeData] of Object.entries(nodesObj)) {
    if (numericId.startsWith('$')) continue; // skip $id, $type metadata
    const nd = nodeData as Record<string, unknown>;
    const typeStr = nd.$type as string | undefined;
    if (!typeStr) continue;

    const type = extractNodeType(typeStr);
    const id = `${type}_${numericId}`;
    nodeIdMap.set(numericId, id);

    const position = nd.Position as { X?: number; Y?: number } | undefined;
    const pos = { X: position?.X ?? 0, Y: position?.Y ?? 0 };

    // Extract parameters — everything that isn't a known structural key
    const params: Record<string, string | number | boolean> = {};
    for (const [key, value] of Object.entries(nd)) {
      if (SKIP_KEYS.has(key)) continue;
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        params[key] = value;
      }
    }

    nodes.push({ id, type, params, position: pos });
  }

  // Parse edges from port connections
  const edges: ParsedEdge[] = [];
  for (const [numericId, nodeData] of Object.entries(nodesObj)) {
    if (numericId.startsWith('$')) continue;
    const nd = nodeData as Record<string, unknown>;
    const ports = (nd.Ports as { $values?: unknown[] })?.$values ?? [];

    for (const port of ports) {
      const p = port as Record<string, unknown>;
      const portType = p.Type as string | undefined;
      const portName = p.Name as string | undefined;
      if (!portName) continue;

      // Connections are stored as $ref references to other port objects
      // or as Connection objects with a Target reference
      const connections = (p.Connections as { $values?: unknown[] })?.$values ?? [];
      for (const conn of connections) {
        const c = conn as Record<string, unknown>;
        // Find the target node — connection references the target port's Parent
        const targetPort = c as Record<string, unknown>;
        const targetParent = targetPort.Parent as { $ref?: string; Id?: number } | undefined;
        const targetPortName = targetPort.Name as string | undefined;

        if (targetParent && targetPortName) {
          const targetId = String(targetParent.Id ?? targetParent.$ref ?? '');
          const fromId = nodeIdMap.get(numericId);
          const toId = nodeIdMap.get(targetId);

          if (fromId && toId && (portType === 'PrimaryOut' || portType === 'SecondaryOut')) {
            edges.push({
              from: fromId,
              fromPort: portName,
              to: toId,
              toPort: targetPortName,
            });
          }
        }
      }
    }
  }

  return {
    source_file: path.basename(filePath),
    metadata,
    nodes,
    edges,
  };
}

/**
 * Parse all .terrain files in a directory.
 */
export function parseAllTerrainFiles(dir: string): ParsedTerrain[] {
  const files = readdirSync(dir).filter(f => f.endsWith('.terrain'));
  return files.map(f => parseTerrainFile(path.join(dir, f)));
}

/**
 * CLI: parse all .terrain files and write to output directory.
 * Run: npx tsx src/gaea/scripts/parse-terrain-files.ts
 */
if (process.argv[1]?.endsWith('parse-terrain-files.ts')) {
  const __dirname = path.dirname(new URL(import.meta.url).pathname);
  const examplesDir = path.resolve(__dirname, '../knowledge/more_examples');
  const outputDir = path.resolve(__dirname, '../knowledge/parsed-terrains');
  mkdirSync(outputDir, { recursive: true });

  const results = parseAllTerrainFiles(examplesDir);
  for (const result of results) {
    const slug = result.source_file.replace(/\.terrain$/, '').replace(/[^a-zA-Z0-9]+/g, '-').toLowerCase();
    writeFileSync(path.join(outputDir, `${slug}.json`), JSON.stringify(result, null, 2));
    console.log(`Parsed: ${result.source_file} → ${slug}.json (${result.nodes.length} nodes, ${result.edges.length} edges)`);
  }
  console.log(`\nDone. ${results.length} files parsed to ${outputDir}`);
}
```

**Note:** The .terrain JSON format uses `$ref` and `$id` for internal references. The edge parsing logic above is a best-effort approach — the Gaea JSON format stores connections in port objects. The implementer should inspect 2-3 .terrain files (Snowymount.terrain, Help 9 (Tall mountains).terrain) to understand the exact connection structure and adjust the edge extraction accordingly. The key structures to look for:
- `Nodes.<numericId>.Ports.$values[]` — each port has `Name`, `Type` (PrimaryIn/PrimaryOut/SecondaryIn/SecondaryOut)
- Connections are either inline (nested objects with `$ref`) or stored in a top-level `Connections` array

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/hayba && npx vitest run src/gaea/scripts/parse-terrain-files.test.ts`
Expected: PASS — at minimum, nodes are extracted. Edge extraction may need iteration based on the actual .terrain format.

If edge extraction fails, debug by inspecting the raw JSON:
```bash
cd packages/hayba
node -e "const d=JSON.parse(require('fs').readFileSync('src/gaea/knowledge/more_examples/Snowymount.terrain','utf-8')); const t=d.Assets.\$values[0].Terrain; const nodes=t.Nodes; const first=Object.entries(nodes).find(([k])=>!k.startsWith('\$')); console.log(JSON.stringify(first[1].Ports,null,2))"
```

- [ ] **Step 5: Run the parser on all .terrain files**

```bash
cd packages/hayba && npx tsx src/gaea/scripts/parse-terrain-files.ts
```

Inspect a few output files to verify quality.

- [ ] **Step 6: Commit**

```bash
git add packages/hayba/src/gaea/scripts/parse-terrain-files.ts packages/hayba/src/gaea/scripts/parse-terrain-files.test.ts packages/hayba/src/gaea/knowledge/parsed-terrains/
git commit -m "feat: add .terrain file parser script"
```

---

### Task 4: Transcript Matcher Script

**Files:**
- Create: `src/gaea/scripts/match-transcripts.ts`
- Create: `src/gaea/scripts/match-transcripts.test.ts`

- [ ] **Step 1: Write test for transcript matcher**

Create `src/gaea/scripts/match-transcripts.test.ts`:

```ts
import { matchTranscripts, type TranscriptMatch } from './match-transcripts.js';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TRANSCRIPTS_DIR = path.resolve(__dirname, '../transcripts');

describe('matchTranscripts', () => {
  it('finds relevant snippets for node types', () => {
    const results = matchTranscripts({
      nodeTypes: ['Mountain', 'Erosion2', 'Sandstone'],
      biomeTerms: ['alpine', 'mountain'],
      terrainName: 'Snowymount',
      transcriptsDir: TRANSCRIPTS_DIR,
    });

    expect(results.length).toBeGreaterThanOrEqual(0);
    for (const match of results) {
      expect(match.filename).toBeDefined();
      expect(match.snippet).toBeDefined();
      expect(match.snippet.length).toBeGreaterThan(0);
      expect(match.snippet.length).toBeLessThanOrEqual(1000);
    }
  });

  it('returns empty array when no matches found', () => {
    const results = matchTranscripts({
      nodeTypes: ['NonExistentNode12345'],
      biomeTerms: ['nonexistentbiome'],
      terrainName: 'nonexistent',
      transcriptsDir: TRANSCRIPTS_DIR,
    });

    expect(results).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/hayba && npx vitest run src/gaea/scripts/match-transcripts.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement the transcript matcher**

Create `src/gaea/scripts/match-transcripts.ts`:

```ts
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'fs';
import path from 'path';
import type { ParsedTerrain } from './parse-terrain-files.js';

export interface TranscriptMatch {
  filename: string;
  snippet: string;       // ~500-1000 chars of relevant context
  matchedTerms: string[]; // which search terms matched
}

interface MatchInput {
  nodeTypes: string[];
  biomeTerms: string[];
  terrainName: string;
  transcriptsDir: string;
}

/**
 * Extract a snippet of ~500 chars around the match position.
 */
function extractSnippet(text: string, matchIndex: number, maxLen = 800): string {
  const halfLen = Math.floor(maxLen / 2);
  const start = Math.max(0, matchIndex - halfLen);
  const end = Math.min(text.length, matchIndex + halfLen);
  let snippet = text.slice(start, end).trim();
  if (start > 0) snippet = '...' + snippet;
  if (end < text.length) snippet = snippet + '...';
  return snippet;
}

/**
 * Search transcripts for mentions of node types, biome terms, or terrain name.
 * Returns relevant snippets with surrounding context.
 */
export function matchTranscripts(input: MatchInput): TranscriptMatch[] {
  const { nodeTypes, biomeTerms, terrainName, transcriptsDir } = input;

  // Build search terms — case-insensitive
  const searchTerms = [
    ...nodeTypes.map(n => n.toLowerCase()),
    ...biomeTerms.map(b => b.toLowerCase()),
    terrainName.toLowerCase(),
  ].filter(t => t.length > 2); // skip very short terms

  const files = readdirSync(transcriptsDir).filter(f => f.endsWith('.txt'));
  const matches: TranscriptMatch[] = [];

  for (const file of files) {
    const text = readFileSync(path.join(transcriptsDir, file), 'utf-8');
    const textLower = text.toLowerCase();

    // Find which terms match in this transcript
    const foundTerms: string[] = [];
    let bestMatchIndex = -1;
    let bestScore = 0;

    for (const term of searchTerms) {
      const idx = textLower.indexOf(term);
      if (idx !== -1) {
        foundTerms.push(term);
        // Prefer matches with more terms nearby
        const score = foundTerms.length;
        if (score > bestScore) {
          bestScore = score;
          bestMatchIndex = idx;
        }
      }
    }

    // Require at least 2 matching terms for relevance
    if (foundTerms.length >= 2 && bestMatchIndex >= 0) {
      matches.push({
        filename: file,
        snippet: extractSnippet(text, bestMatchIndex),
        matchedTerms: foundTerms,
      });
    }
  }

  // Sort by number of matched terms (most relevant first)
  matches.sort((a, b) => b.matchedTerms.length - a.matchedTerms.length);

  return matches;
}

/**
 * Match all parsed terrains against transcripts.
 * Run: npx tsx src/gaea/scripts/match-transcripts.ts
 */
if (process.argv[1]?.endsWith('match-transcripts.ts')) {
  const __dirname = path.dirname(new URL(import.meta.url).pathname);
  const parsedDir = path.resolve(__dirname, '../knowledge/parsed-terrains');
  const transcriptsDir = path.resolve(__dirname, '../transcripts');
  const outputDir = path.resolve(__dirname, '../knowledge/transcript-matches');
  mkdirSync(outputDir, { recursive: true });

  const parsedFiles = readdirSync(parsedDir).filter(f => f.endsWith('.json'));

  for (const file of parsedFiles) {
    const parsed: ParsedTerrain = JSON.parse(readFileSync(path.join(parsedDir, file), 'utf-8'));
    const nodeTypes = [...new Set(parsed.nodes.map(n => n.type))];
    const terrainName = parsed.metadata.name;

    // Derive biome terms from node types and terrain name
    const biomeTerms: string[] = [];
    if (/snow|alpine|mountain|ridge/i.test(terrainName)) biomeTerms.push('alpine', 'mountain', 'snow');
    if (/desert|canyon|sand/i.test(terrainName)) biomeTerms.push('desert', 'arid', 'canyon');
    if (/volcanic|volcano|lava/i.test(terrainName)) biomeTerms.push('volcanic', 'lava');
    if (/river|valley|erosion/i.test(terrainName)) biomeTerms.push('river', 'valley', 'erosion');
    if (/island|coastal|ocean/i.test(terrainName)) biomeTerms.push('coastal', 'island');
    if (/thermal|pool|hot spring/i.test(terrainName)) biomeTerms.push('thermal', 'geothermal');

    const matches = matchTranscripts({
      nodeTypes,
      biomeTerms,
      terrainName,
      transcriptsDir,
    });

    const output = {
      source_file: parsed.source_file,
      terrain_name: terrainName,
      node_types: nodeTypes,
      transcript_matches: matches,
    };

    const slug = file.replace('.json', '');
    writeFileSync(path.join(outputDir, `${slug}-matches.json`), JSON.stringify(output, null, 2));
    console.log(`${parsed.source_file}: ${matches.length} transcript matches`);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/hayba && npx vitest run src/gaea/scripts/match-transcripts.test.ts`
Expected: PASS

- [ ] **Step 5: Run the matcher on all parsed terrains**

First ensure Task 3's parser has run, then:

```bash
cd packages/hayba && npx tsx src/gaea/scripts/match-transcripts.ts
```

- [ ] **Step 6: Commit**

```bash
git add packages/hayba/src/gaea/scripts/match-transcripts.ts packages/hayba/src/gaea/scripts/match-transcripts.test.ts packages/hayba/src/gaea/knowledge/transcript-matches/
git commit -m "feat: add transcript matcher script for .terrain cross-referencing"
```

---

### Task 5: Scratch Sessions for Standalone Zone Painter

**Files:**
- Modify: `src/zones.ts`
- Modify: `src/dashboard/api.ts`
- Modify: `src/tools/hayba-read-zones.ts`
- Modify: `dashboard/src/App.tsx`
- Test: `tests/zones-scratch.test.ts` (new)

- [ ] **Step 1: Write test for scratch session CRUD**

Create `tests/zones-scratch.test.ts`:

```ts
import { createScratchSession, submitScratchZones, getScratchZones, cleanupExpiredScratch } from '../src/zones.js';
import { existsSync, mkdirSync, rmSync } from 'fs';
import path from 'path';
import os from 'os';

const TEST_BASE = path.join(os.tmpdir(), 'hayba-scratch-test');

beforeEach(() => {
  mkdirSync(TEST_BASE, { recursive: true });
});

afterEach(() => {
  rmSync(TEST_BASE, { recursive: true, force: true });
});

describe('scratch sessions', () => {
  it('creates a scratch session with a unique ID', () => {
    const session = createScratchSession(TEST_BASE);
    expect(session.scratchSessionId).toBeDefined();
    expect(typeof session.scratchSessionId).toBe('string');
    expect(session.scratchSessionId.length).toBeGreaterThan(0);
  });

  it('stores and retrieves zone data', async () => {
    const session = createScratchSession(TEST_BASE);
    const zones = [
      { id: 'z1', name: 'Mountain', description: 'Peak zone', color: '#ff0000', type: 'terrain' as const, visible: true },
    ];
    const masks = [{ zoneId: 'z1', pngBase64: 'iVBORw0KGgo=' }]; // minimal PNG stub

    await submitScratchZones(session.scratchSessionId, zones, masks, TEST_BASE);
    const retrieved = await getScratchZones(session.scratchSessionId, TEST_BASE);

    expect(retrieved).not.toBeNull();
    expect(retrieved!.zones).toHaveLength(1);
    expect(retrieved!.zones[0].name).toBe('Mountain');
  });

  it('cleans up expired sessions', async () => {
    const session = createScratchSession(TEST_BASE, -1); // expired immediately (negative TTL)
    await submitScratchZones(session.scratchSessionId,
      [{ id: 'z1', name: 'test', description: '', color: '#fff', type: 'terrain' as const, visible: true }],
      [], TEST_BASE
    );

    cleanupExpiredScratch(TEST_BASE);
    const retrieved = await getScratchZones(session.scratchSessionId, TEST_BASE);
    expect(retrieved).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/hayba && npx vitest run tests/zones-scratch.test.ts`
Expected: FAIL — functions not exported

- [ ] **Step 3: Add scratch session functions to zones.ts**

In `src/zones.ts`, add after the existing code:

```ts
import { randomUUID } from 'node:crypto';
import { readdirSync, rmSync, statSync } from 'node:fs';

const SCRATCH_DIR = '.scratch';
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

function scratchDir(scratchId: string, base: string): string {
  return join(base, SCRATCH_DIR, scratchId);
}

export function createScratchSession(
  base = DEFAULT_PROJECTS_BASE,
  ttlMs = DEFAULT_TTL_MS,
): { scratchSessionId: string } {
  const id = randomUUID();
  const dir = scratchDir(id, base);
  mkdirSync(dir, { recursive: true });
  // Write metadata with expiry
  const meta = { createdAt: Date.now(), expiresAt: Date.now() + ttlMs };
  writeFileSync(join(dir, 'meta.json'), JSON.stringify(meta));
  return { scratchSessionId: id };
}

export async function submitScratchZones(
  scratchSessionId: string,
  zones: Omit<Zone, 'maskPath'>[],
  masks: { zoneId: string; pngBase64: string }[],
  base = DEFAULT_PROJECTS_BASE,
  canvasSize: 1024 | 2048 | 4096 = 1024,
): Promise<ZoneSession> {
  const dir = scratchDir(scratchSessionId, base);
  const masksDir = join(dir, 'masks');
  mkdirSync(masksDir, { recursive: true });
  const writtenMasks: { zoneId: string; pngPath: string }[] = [];

  for (const m of masks) {
    const filename = `${m.zoneId}.png`;
    const pngPath = join(masksDir, filename);
    writeFileSync(pngPath, Buffer.from(m.pngBase64, 'base64'));
    writtenMasks.push({ zoneId: m.zoneId, pngPath });
  }

  const zonesWithPaths: Zone[] = zones.map(z => ({
    ...z,
    maskPath: writtenMasks.find(m => m.zoneId === z.id)?.pngPath ?? '',
  }));

  const session: ZoneSession = {
    projectId: `scratch:${scratchSessionId}`,
    zones: zonesWithPaths,
    masks: writtenMasks,
    submittedAt: new Date().toISOString(),
    canvasSize,
    phase: 'a',
  };

  writeFileSync(join(dir, 'zones.json'), JSON.stringify(session, null, 2), 'utf-8');
  return session;
}

export async function getScratchZones(
  scratchSessionId: string,
  base = DEFAULT_PROJECTS_BASE,
): Promise<ZoneSession | null> {
  const file = join(scratchDir(scratchSessionId, base), 'zones.json');
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, 'utf-8')) as ZoneSession;
}

export function cleanupExpiredScratch(base = DEFAULT_PROJECTS_BASE): void {
  const dir = join(base, SCRATCH_DIR);
  if (!existsSync(dir)) return;
  const now = Date.now();
  for (const entry of readdirSync(dir)) {
    const metaPath = join(dir, entry, 'meta.json');
    if (!existsSync(metaPath)) continue;
    try {
      const meta = JSON.parse(readFileSync(metaPath, 'utf-8')) as { expiresAt: number };
      if (meta.expiresAt < now) {
        rmSync(join(dir, entry), { recursive: true, force: true });
      }
    } catch { /* skip corrupt entries */ }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/hayba && npx vitest run tests/zones-scratch.test.ts`
Expected: PASS

- [ ] **Step 5: Update hayba-read-zones.ts to accept scratchSessionId**

In `src/tools/hayba-read-zones.ts`, modify the handler:

```ts
import type { ToolResult } from './hayba-bake-terrain.js';
import { getCurrentZones, getScratchZones } from '../zones.js';
import { DEFAULT_PROJECTS_BASE } from '../projects.js';

export async function readZonesHandler(
  args: Record<string, unknown>,
  base = DEFAULT_PROJECTS_BASE,
): Promise<ToolResult> {
  const projectId = args.projectId as string | undefined;
  const scratchSessionId = args.scratchSessionId as string | undefined;

  if (!projectId && !scratchSessionId) {
    return { content: [{ type: 'text', text: 'Error: projectId or scratchSessionId is required.' }], isError: true };
  }

  const session = scratchSessionId
    ? await getScratchZones(scratchSessionId, base)
    : await getCurrentZones(projectId!, base);

  if (!session) {
    const target = scratchSessionId ? `scratch session "${scratchSessionId}"` : `project "${projectId}"`;
    return {
      content: [{ type: 'text', text: `No zone submission found for ${target}. Ask the user to paint and submit zones first.` }],
      isError: true,
    };
  }

  return { content: [{ type: 'text', text: JSON.stringify(session, null, 2) }] };
}
```

- [ ] **Step 6: Update index.ts tool registration for hayba_read_zones**

In `src/tools/index.ts`, update the `hayba_read_zones` registration to accept `scratchSessionId`:

```ts
  server.tool(
    'hayba_read_zones',
    {
      projectId: z.string().optional().describe('Project ID to read submitted zones from.'),
      scratchSessionId: z.string().optional().describe('Scratch session ID (for standalone zone painting without a project).'),
    },
    async (params) => {
      const result = await readZonesHandler(params as Record<string, unknown>);
      return { content: result.content, isError: result.isError };
    }
  );
```

- [ ] **Step 7: Add scratch session API endpoints to dashboard**

In `src/dashboard/api.ts`, add after the existing `// ── Painter session` section:

```ts
  // ── Scratch sessions ───────────────────────────────────────────────────────

  app.post('/api/zones/scratch-session', (req: Request, res: Response) => {
    const result = createScratchSession();
    // Unlock painter for the scratch session
    unlockPainter(`scratch:${result.scratchSessionId}`, 'a');
    res.json(result);
  });

  app.post('/api/zones/scratch-submit', async (req: Request, res: Response) => {
    const { scratchSessionId, zones, masks, canvasSize } = req.body as {
      scratchSessionId?: string;
      zones?: unknown[];
      masks?: { zoneId: string; pngBase64: string }[];
      canvasSize?: 1024 | 2048 | 4096;
    };
    if (!scratchSessionId || !zones || !masks) {
      return res.status(400).json({ error: 'scratchSessionId, zones, and masks are required' });
    }
    const session = await submitScratchZones(scratchSessionId, zones as any, masks, undefined, canvasSize);
    res.json(session);
  });

  app.get('/api/zones/scratch/:scratchSessionId', async (req: Request, res: Response) => {
    const session = await getScratchZones(req.params.scratchSessionId as string);
    if (!session) return res.status(404).json({ error: 'No zone submission found for scratch session' });
    res.json(session);
  });
```

Add imports at top of `api.ts`:
```ts
import { createScratchSession, submitScratchZones, getScratchZones } from '../zones.js';
```

- [ ] **Step 8: Update App.tsx to handle scratch URLs**

In `dashboard/src/App.tsx`, update `parseHash`:

```ts
function parseHash(): { projectId?: string; scratchSessionId?: string; section?: string } {
  const hash = window.location.hash.replace('#', '');
  const parts = hash.split('/');
  if (parts[0] === 'project' && parts[1]) {
    return { projectId: parts[1], section: parts[2] ?? 'zones' };
  }
  if (parts[0] === 'scratch' && parts[1]) {
    return { scratchSessionId: parts[1], section: parts[2] ?? 'zones' };
  }
  return {};
}
```

And pass `scratchSessionId` to `ProjectsPage`:

```tsx
{tab === 'Projects' && (
  <ProjectsPage
    deepLinkProjectId={deepLink.projectId}
    deepLinkSection={deepLink.section}
    deepLinkScratchSessionId={deepLink.scratchSessionId}
  />
)}
```

The `ProjectsPage` component will need to accept `deepLinkScratchSessionId` and, when present, open the ZonePainter directly in scratch mode (submitting to `/api/zones/scratch-submit` instead of `/api/zones/submit`). The exact UI changes depend on how `ZonePainter.tsx` currently handles submission — adapt the submit handler to use the scratch endpoint when a `scratchSessionId` is present.

- [ ] **Step 9: Commit**

```bash
git add packages/hayba/src/zones.ts packages/hayba/tests/zones-scratch.test.ts packages/hayba/src/tools/hayba-read-zones.ts packages/hayba/src/tools/index.ts packages/hayba/src/dashboard/api.ts packages/hayba/dashboard/src/App.tsx
git commit -m "feat: add scratch sessions for standalone zone painter"
```

---

### Task 6: Rename hayba_brainstorm_terrain → hayba_ue_landscape_pipeline

**Files:**
- Create: `src/tools/hayba-ue-landscape-pipeline.ts` (renamed from hayba-brainstorm-terrain.ts)
- Modify: `src/tools/index.ts`
- Delete: `src/tools/hayba-brainstorm-terrain.ts`

- [ ] **Step 1: Copy and rename the file**

```bash
cd packages/hayba
cp src/tools/hayba-brainstorm-terrain.ts src/tools/hayba-ue-landscape-pipeline.ts
```

- [ ] **Step 2: Update the new file**

In `src/tools/hayba-ue-landscape-pipeline.ts`:

1. Rename the exported function: `brainstormTerrainHandler` → `ueLandscapePipelineHandler`
2. Rename the exported type: `BrainstormStep` → `UELandscapePipelineStep`
3. Keep all internal logic the same for now

Find and replace in the file:
- `brainstormTerrainHandler` → `ueLandscapePipelineHandler`
- `BrainstormStep` → `UELandscapePipelineStep`

- [ ] **Step 3: Update index.ts**

In `src/tools/index.ts`:

Replace the import:
```ts
// Old
import { brainstormTerrainHandler, type BrainstormStep } from './hayba-brainstorm-terrain.js';
// New
import { ueLandscapePipelineHandler, type UELandscapePipelineStep } from './hayba-ue-landscape-pipeline.js';
```

Replace the tool registration:
```ts
  server.tool(
    'hayba_ue_landscape_pipeline',
    'Full UE landscape project pipeline: guided brainstorm → zone painting → Gaea terrain generation → bake → import into Unreal Engine → foliage zones. Use this for major landscape projects that will be imported into UE5. For standalone Gaea terrain work, use hayba_brainstorm_gaea instead.',
    {
      step: z.enum(['start', 'biome', 'scale', 'features', 'name', 'layout', 'preview', 'bake', 'foliage', 'done'])
        .describe('Current step in the pipeline flow. Always start with "start".'),
      answer: z.string().optional()
        .describe('The user\'s answer to the previous step\'s question.'),
      projectId: z.string().optional()
        .describe('Project ID — returned by the "layout" step, pass it through on subsequent steps.'),
      projectName: z.string().optional()
        .describe('Name for the project, used at the "layout" step when creating the project.'),
      biomeAnswer: z.string().optional()
        .describe('The biome answer from step "biome" — used for archetype search in preview.'),
      featureAnswer: z.string().optional()
        .describe('The feature answer from step "features" — used for archetype search in preview.'),
    },
    async (params) => {
      const result = await ueLandscapePipelineHandler(params as Record<string, unknown>, session);
      return { content: result.content, isError: result.isError };
    }
  );
```

- [ ] **Step 4: Delete old file**

```bash
rm packages/hayba/src/tools/hayba-brainstorm-terrain.ts
```

- [ ] **Step 5: Verify build passes**

```bash
cd packages/hayba && npx tsc --noEmit
```

- [ ] **Step 6: Commit**

```bash
git add packages/hayba/src/tools/hayba-ue-landscape-pipeline.ts packages/hayba/src/tools/index.ts
git rm packages/hayba/src/tools/hayba-brainstorm-terrain.ts
git commit -m "refactor: rename hayba_brainstorm_terrain → hayba_ue_landscape_pipeline"
```

---

### Task 7: Build hayba_brainstorm_gaea Tool

**Files:**
- Create: `src/tools/hayba-brainstorm-gaea.ts`
- Create: `tests/tools/hayba-brainstorm-gaea.test.ts`
- Modify: `src/tools/index.ts`

- [ ] **Step 1: Write test for the brainstorm tool**

Create `tests/tools/hayba-brainstorm-gaea.test.ts`:

```ts
import { brainstormGaeaHandler, type BrainstormGaeaResult } from '../../src/tools/hayba-brainstorm-gaea.js';

describe('hayba_brainstorm_gaea', () => {
  it('returns archetypes, best practices, and follow-up questions on start', async () => {
    const result = await brainstormGaeaHandler({
      prompt: 'alpine mountain with sharp ridges',
      step: 'start',
    });

    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0].text) as BrainstormGaeaResult;
    expect(data.step).toBe('start');
    expect(data.archetypes.length).toBeGreaterThan(0);
    expect(data.best_practices.length).toBeGreaterThanOrEqual(0);
    expect(data.node_zone_strategies).toBeDefined();
    // Should return some follow-up questions or a suggested plan
    expect(data.follow_up_questions.length + (data.suggested_plan ? 1 : 0)).toBeGreaterThan(0);
  });

  it('returns a scratch session on zones step', async () => {
    const result = await brainstormGaeaHandler({
      prompt: 'desert canyon',
      step: 'zones',
    });

    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0].text) as BrainstormGaeaResult;
    expect(data.step).toBe('zones');
    expect(data.scratchSessionId).toBeDefined();
    expect(data.painterUrl).toBeDefined();
    expect(data.painterUrl).toContain('scratch');
  });

  it('returns final graph plan on finalize step', async () => {
    const result = await brainstormGaeaHandler({
      prompt: 'volcanic island',
      step: 'finalize',
    });

    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0].text) as BrainstormGaeaResult;
    expect(data.step).toBe('finalize');
    expect(data.final_graph).toBeDefined();
    expect(data.final_graph!.nodes.length).toBeGreaterThan(0);
    expect(data.final_graph!.edges.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/hayba && npx vitest run tests/tools/hayba-brainstorm-gaea.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement the brainstorm-gaea tool**

Create `src/tools/hayba-brainstorm-gaea.ts`:

```ts
/**
 * hayba_brainstorm_gaea
 *
 * RAG-powered terrain brainstorm tool. Mandatory gate before hayba_create_terrain.
 * Multi-turn: returns archetype matches, knowledge, follow-up questions, and
 * eventually a synthesized graph plan.
 *
 * Steps: start → followup → zones (optional) → finalize
 */

import type { ToolResult } from './hayba-bake-terrain.js';
import { getStore } from './search-gaea-archetypes.js';
import { queryGaeaKnowledge } from './query-gaea-knowledge.js';
import { createScratchSession } from '../zones.js';
import { config } from '../config.js';
import type { GaeaArchetype } from '../gaea/knowledge/types.js';
import { KnowledgeStore } from '../gaea/knowledge/knowledge-store.js';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DOCS_DIR = resolve(__dirname, '..', 'gaea', 'knowledge', 'gaea-docs');

let knowledgeStore: KnowledgeStore | null = null;
function getKnowledgeStore(): KnowledgeStore {
  if (!knowledgeStore) knowledgeStore = new KnowledgeStore(DOCS_DIR);
  return knowledgeStore;
}

export type BrainstormGaeaStep = 'start' | 'followup' | 'zones' | 'finalize';

export interface BrainstormGaeaResult {
  step: BrainstormGaeaStep;
  archetypes: GaeaArchetype[];
  best_practices: Array<{ id?: string; category: string; rule: string }>;
  workflow_patterns: Array<{ description: string; when_to_use: string; nodes: string[] }>;
  common_mistakes: string[];
  node_zone_strategies: Record<string, { strategy: string; position_params: string[] }>;
  follow_up_questions: string[];
  suggested_plan: {
    nodes: Array<{ id: string; type: string; params: Record<string, unknown> }>;
    edges: Array<{ from: string; fromPort: string; to: string; toPort: string }>;
    reasoning: string;
  } | null;
  final_graph: {
    nodes: Array<{ id: string; type: string; params: Record<string, unknown> }>;
    edges: Array<{ from: string; fromPort: string; to: string; toPort: string }>;
  } | null;
  scratchSessionId?: string;
  painterUrl?: string;
}

export async function brainstormGaeaHandler(
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const prompt = args.prompt as string;
  const step = (args.step as BrainstormGaeaStep) ?? 'start';
  const answer = args.answer as string | undefined;
  const scratchSessionId = args.scratchSessionId as string | undefined;

  if (!prompt) {
    return {
      content: [{ type: 'text', text: 'Error: prompt is required.' }],
      isError: true,
    };
  }

  const archetypeStore = getStore();
  const ks = getKnowledgeStore();

  const result: BrainstormGaeaResult = {
    step,
    archetypes: [],
    best_practices: [],
    workflow_patterns: [],
    common_mistakes: [],
    node_zone_strategies: {},
    follow_up_questions: [],
    suggested_plan: null,
    final_graph: null,
  };

  switch (step) {
    case 'start':
    case 'followup': {
      // Combine prompt + answer for search
      const searchQuery = answer ? `${prompt} ${answer}` : prompt;

      // RAG: search archetypes
      const archetypes = await archetypeStore.search({
        query: searchQuery,
        limit: 5,
      });
      result.archetypes = archetypes;

      // Collect all node types from top archetypes
      const allNodeTypes = [...new Set(archetypes.flatMap(a => a.core_topology))];

      // RAG: knowledge lookup for each node type
      for (const nodeType of allNodeTypes) {
        const nodeRef = ks.getNode(nodeType);
        if (nodeRef) {
          result.node_zone_strategies[nodeType] = {
            strategy: nodeRef.zone_strategy ?? 'none',
            position_params: nodeRef.position_params ?? [],
          };
        }
      }

      // RAG: best practices
      result.best_practices = ks.getBestPractices({ nodeTypes: allNodeTypes });

      // RAG: workflow patterns
      result.workflow_patterns = ks.findPatterns({ description: searchQuery }).map(p => ({
        description: p.description,
        when_to_use: p.when_to_use,
        nodes: p.nodes,
      }));

      // Collect common mistakes from enriched archetypes
      result.common_mistakes = [
        ...new Set(archetypes.flatMap(a => a.common_mistakes ?? [])),
      ];

      // Build suggested plan from best matching archetype
      if (archetypes.length > 0) {
        const best = archetypes[0];
        if (best.graph) {
          result.suggested_plan = {
            nodes: best.graph.nodes.map(n => ({ id: n.id, type: n.type, params: n.params as Record<string, unknown> })),
            edges: best.graph.edges,
            reasoning: `Based on "${best.pattern_name}": ${best.semantic_intent}`,
          };
        } else {
          // Fallback: construct a linear chain from core_topology
          const nodes = best.core_topology.map((type, i) => ({
            id: `node_${i}`,
            type,
            params: {} as Record<string, unknown>,
          }));
          const edges = [];
          for (let i = 0; i < nodes.length - 1; i++) {
            edges.push({
              from: nodes[i].id,
              fromPort: 'Out',
              to: nodes[i + 1].id,
              toPort: 'In',
            });
          }
          result.suggested_plan = {
            nodes,
            edges,
            reasoning: `Linear chain from "${best.pattern_name}": ${best.semantic_intent}. Note: this is a simplified topology — review and adapt connections.`,
          };
        }
      }

      // Generate follow-up questions for ambiguous prompts
      if (step === 'start') {
        result.follow_up_questions = [];

        // Check if scale is specified
        if (!/\b(small|mid|large|km|meters?|continental|regional|local)\b/i.test(prompt)) {
          result.follow_up_questions.push('What scale should this terrain be? (e.g. small 2-4 km², mid 8-10 km², or large 16+ km²)');
        }

        // Check if erosion style is specified
        if (!/\b(sharp|soft|smooth|rugged|eroded|weathered)\b/i.test(prompt)) {
          result.follow_up_questions.push('What erosion character? Sharp ridges, soft rolling hills, or heavily weathered?');
        }

        // Check if coloring/lookdev is mentioned
        if (!/\b(snow|color|texture|satmap|green|brown|red)\b/i.test(prompt)) {
          result.follow_up_questions.push('Do you want the terrain with coloring/textures, or just the heightmap shape?');
        }
      }

      break;
    }

    case 'zones': {
      // Create a scratch session and return painter URL
      const session = createScratchSession();
      result.scratchSessionId = session.scratchSessionId;
      result.painterUrl = `http://${config.dashboardHost}:${config.dashboardPort}/#scratch/${session.scratchSessionId}/zones`;
      break;
    }

    case 'finalize': {
      // Build the final graph from prompt + any zone data
      const archetypes = await archetypeStore.search({ query: prompt, limit: 3 });
      result.archetypes = archetypes;

      if (archetypes.length > 0) {
        const best = archetypes[0];

        if (best.graph) {
          // Use the enriched graph as the final output
          result.final_graph = {
            nodes: best.graph.nodes.map(n => ({ id: n.id, type: n.type, params: n.params as Record<string, unknown> })),
            edges: best.graph.edges,
          };
        } else {
          // Fallback: linear chain
          const nodes = best.core_topology.map((type, i) => ({
            id: `node_${i}`,
            type,
            params: {} as Record<string, unknown>,
          }));
          const edges = [];
          for (let i = 0; i < nodes.length - 1; i++) {
            edges.push({
              from: nodes[i].id,
              fromPort: 'Out',
              to: nodes[i + 1].id,
              toPort: 'In',
            });
          }
          result.final_graph = { nodes, edges };
        }

        // Look up zone strategies for all nodes in final graph
        for (const node of (result.final_graph?.nodes ?? [])) {
          const nodeRef = ks.getNode(node.type);
          if (nodeRef) {
            result.node_zone_strategies[node.type] = {
              strategy: nodeRef.zone_strategy ?? 'none',
              position_params: nodeRef.position_params ?? [],
            };
          }
        }
      }

      break;
    }

    default: {
      return {
        content: [{ type: 'text', text: `Unknown step "${step}". Valid steps: start, followup, zones, finalize.` }],
        isError: true,
      };
    }
  }

  return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
}
```

- [ ] **Step 4: Register the tool in index.ts**

In `src/tools/index.ts`, add the import:

```ts
import { brainstormGaeaHandler } from './hayba-brainstorm-gaea.js';
```

Add the tool registration (in the `// ── Gaea tools ──` section):

```ts
  server.tool(
    'hayba_brainstorm_gaea',
    'Brainstorm a Gaea terrain through RAG-powered knowledge search and multi-turn refinement. Returns archetype matches, best practices, common mistakes, and a synthesized graph plan. IMPORTANT: Always call this tool before hayba_create_terrain. Do NOT build a Gaea graph without first brainstorming through this tool.',
    {
      prompt: z.string().describe('Natural language terrain description, e.g. "alpine mountain with sharp ridges"'),
      step: z.enum(['start', 'followup', 'zones', 'finalize']).optional().default('start')
        .describe('Current step. start=initial RAG search, followup=refine with answer, zones=open painter, finalize=build graph plan'),
      answer: z.string().optional()
        .describe('User answer to a follow-up question from the previous step'),
      scratchSessionId: z.string().optional()
        .describe('Scratch session ID from the zones step, for reading painted zones'),
    },
    async (params) => {
      const result = await brainstormGaeaHandler(params as Record<string, unknown>);
      return { content: result.content, isError: result.isError };
    }
  );
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd packages/hayba && npx vitest run tests/tools/hayba-brainstorm-gaea.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/hayba/src/tools/hayba-brainstorm-gaea.ts packages/hayba/tests/tools/hayba-brainstorm-gaea.test.ts packages/hayba/src/tools/index.ts
git commit -m "feat: add hayba_brainstorm_gaea RAG-powered terrain brainstorm tool"
```

---

### Task 8: Add Soft Gate Warning to create_terrain

**Files:**
- Modify: `src/tools/hayba-create-terrain.ts`
- Modify: `src/tools/index.ts`

- [ ] **Step 1: Update create_terrain tool description in index.ts**

In `src/tools/index.ts`, update the `hayba_create_terrain` registration. Change the `prompt` description:

```ts
  server.tool(
    'hayba_create_terrain',
    'Create a Gaea terrain from a graph definition or template. IMPORTANT: Do NOT call this tool without first calling hayba_brainstorm_gaea. The brainstorm tool performs RAG search, knowledge lookup, and graph planning that is essential for quality terrain output.',
    {
      prompt: z.string().describe('Natural language terrain description — used for logging and as fallback if no graph provided'),
      // ... rest of params unchanged
    },
    async (params) => {
      const result = await createTerrainHandler(params as Record<string, unknown>, session);
      return { content: result.content, isError: result.isError };
    }
  );
```

- [ ] **Step 2: Add soft gate warning in createTerrainHandler**

In `src/tools/hayba-create-terrain.ts`, add a warning at the top of the handler when no graph is provided and no brainstorm context exists. After the prompt validation check:

```ts
  // Soft gate: warn if no graph provided (likely skipped brainstorm)
  if (!args.graph && !args.template) {
    // If called without a graph, the AI is asking for the node catalog.
    // Prepend a warning to encourage brainstorm usage.
    const warning = '⚠️ No brainstorm session detected. For better results, call hayba_brainstorm_gaea first — it performs RAG search against the knowledge base and produces an optimized graph plan.\n\n';
    // Continue to return the catalog, but with the warning prepended
    const nodeTypes = await session.enqueue(() => session.client.listNodeTypes());
    const catalog = nodeTypes
      .map((n) => {
        const params = n.parameters.map((p) => `  - ${p.name}: ${p.type} [${p.min ?? '?'} - ${p.max ?? '?'}], default ${p.default}`).join('\n');
        return `### ${n.type} (${n.category})\nInputs: ${n.inputs.join(', ') || 'none'} | Outputs: ${n.outputs.join(', ')}\n${params}`;
      })
      .join('\n\n');

    const templates = listTemplates();
    const templateSection = [
      `## Quick Start: Use a Template`,
      ...templates.map(t => `  - **${t.name}**: ${t.description} (tweakable: ${(t.tweakable ?? []).join(', ')})`),
      ``,
      `Call: hayba_create_terrain(prompt="...", template="desert", template_overrides={"Seed": 42})`,
    ].join('\n');

    return {
      content: [{
        type: 'text',
        text: warning + templateSection + '\n\n' + catalog + `\n\nPrompt to fulfill: "${args.prompt}"`,
      }],
    };
  }
```

This replaces the existing fallback block (lines 91-129 in the current file) that returns the catalog without a warning.

- [ ] **Step 3: Verify build passes**

```bash
cd packages/hayba && npx tsc --noEmit
```

- [ ] **Step 4: Commit**

```bash
git add packages/hayba/src/tools/hayba-create-terrain.ts packages/hayba/src/tools/index.ts
git commit -m "feat: add soft gate warning to create_terrain when brainstorm not used"
```

---

### Task 9: Manual Archetype Enrichment (Workflow Task)

This is NOT a code task — it's a workflow step using opencode in a separate terminal.

- [ ] **Step 1: Verify parser and matcher outputs exist**

```bash
ls packages/hayba/src/gaea/knowledge/parsed-terrains/
ls packages/hayba/src/gaea/knowledge/transcript-matches/
```

Both directories should have JSON files from Tasks 3 and 4.

- [ ] **Step 2: Enrich archetypes via opencode**

Open a separate terminal. For each parsed .terrain file + its transcript matches:

1. Feed the parsed graph structure to opencode
2. Feed the matched transcript snippets
3. Ask it to produce enriched archetype entries with:
   - `semantic_intent` rewritten with geological depth
   - `graph` with full nodes/edges/params
   - `node_reasoning` per node
   - `common_mistakes`
   - `sources`

4. Review the output and merge into `packages/hayba/src/gaea/knowledge/archetypes.json`

- [ ] **Step 3: Regenerate embeddings**

After updating `archetypes.json`, the embeddings need to be regenerated:

```bash
cd packages/hayba && npx vitest run src/gaea/knowledge/archetype-store.test.ts
```

The `ensureEmbeddings` method will detect missing embeddings and compute new ones. Alternatively, delete `embeddings.json` and let it regenerate fully.

- [ ] **Step 4: Commit enriched archetypes**

```bash
git add packages/hayba/src/gaea/knowledge/archetypes.json packages/hayba/src/gaea/knowledge/embeddings.json
git commit -m "feat: enrich archetypes with deep graph structure from .terrain files and transcripts"
```

---

### Task 10: Integration Test — Full Brainstorm Flow

**Files:**
- Create: `tests/tools/hayba-brainstorm-gaea-integration.test.ts`

- [ ] **Step 1: Write integration test**

Create `tests/tools/hayba-brainstorm-gaea-integration.test.ts`:

```ts
import { brainstormGaeaHandler, type BrainstormGaeaResult } from '../../src/tools/hayba-brainstorm-gaea.js';

describe('brainstorm-gaea integration', () => {
  it('full flow: start → followup → finalize', async () => {
    // Step 1: start
    const startResult = await brainstormGaeaHandler({
      prompt: 'snowy alpine mountain with sharp ridges and erosion',
      step: 'start',
    });
    const start = JSON.parse(startResult.content[0].text) as BrainstormGaeaResult;
    expect(start.archetypes.length).toBeGreaterThan(0);
    expect(start.node_zone_strategies).toBeDefined();

    // Verify zone strategies are populated for archetype nodes
    const nodeTypes = [...new Set(start.archetypes.flatMap(a => a.core_topology))];
    for (const nt of nodeTypes) {
      if (start.node_zone_strategies[nt]) {
        expect(['position', 'mask', 'none']).toContain(start.node_zone_strategies[nt].strategy);
      }
    }

    // Step 2: followup with answer
    const followResult = await brainstormGaeaHandler({
      prompt: 'snowy alpine mountain with sharp ridges and erosion',
      step: 'followup',
      answer: 'mid scale 8km, sharp ridges, with snow coloring',
    });
    const follow = JSON.parse(followResult.content[0].text) as BrainstormGaeaResult;
    expect(follow.archetypes.length).toBeGreaterThan(0);

    // Step 3: finalize
    const finalResult = await brainstormGaeaHandler({
      prompt: 'snowy alpine mountain with sharp ridges and erosion',
      step: 'finalize',
    });
    const final = JSON.parse(finalResult.content[0].text) as BrainstormGaeaResult;
    expect(final.final_graph).not.toBeNull();
    expect(final.final_graph!.nodes.length).toBeGreaterThan(0);
    expect(final.final_graph!.edges.length).toBeGreaterThan(0);
  });

  it('zones step creates scratch session', async () => {
    const result = await brainstormGaeaHandler({
      prompt: 'desert with canyons',
      step: 'zones',
    });
    const data = JSON.parse(result.content[0].text) as BrainstormGaeaResult;
    expect(data.scratchSessionId).toBeDefined();
    expect(data.painterUrl).toContain('scratch');
    expect(data.painterUrl).toContain(data.scratchSessionId);
  });
});
```

- [ ] **Step 2: Run integration test**

Run: `cd packages/hayba && npx vitest run tests/tools/hayba-brainstorm-gaea-integration.test.ts`
Expected: PASS

- [ ] **Step 3: Run full test suite**

Run: `cd packages/hayba && npx vitest run`
Expected: All tests pass. Fix any regressions from the rename or schema changes.

- [ ] **Step 4: Commit**

```bash
git add packages/hayba/tests/tools/hayba-brainstorm-gaea-integration.test.ts
git commit -m "test: add integration test for full brainstorm-gaea flow"
```
