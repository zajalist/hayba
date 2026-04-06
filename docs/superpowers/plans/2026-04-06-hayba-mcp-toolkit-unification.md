# Hayba MCP Toolkit Unification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Merge `packages/gaea` and `packages/pcgex` into a single `packages/hayba` package with one MCP server (`@hayba/mcp`), all tools prefixed `hayba_`, and a single merged UE plugin (`HaybaMCPToolkit`).

**Architecture:** Rename `packages/pcgex` → `packages/hayba`. Move gaea domain code into `src/gaea/`. Move gaea tool handlers into `src/tools/` with `hayba-` filename prefix, updating their imports. Centralize all tool registration in `src/tools/index.ts` via `registerTools(server, session)`. Merge both UE plugins into one `HaybaMCPToolkit` plugin based on the PCGEx module with landscape importer added.

**Tech Stack:** TypeScript, Node.js ≥22.5, `@modelcontextprotocol/sdk`, `zod`, `express`, `vitest`; C++ UE 5.7 plugin (Slate, PCG, Landscape, Sockets, Json)

---

## File Map

**Renamed/moved (TS):**
- `packages/pcgex/` → `packages/hayba/`
- `packages/gaea/src/{swarmhost,gaea-launcher,session,file-watcher,types,templates}` → `packages/hayba/src/gaea/`
- `packages/gaea/src/tools/*.ts` → `packages/hayba/src/tools/hayba-{name}.ts` (imports updated, `registerTool()` removed)
- `packages/gaea/tests/**` → `packages/hayba/tests/gaea/**` (import paths updated)
- `packages/gaea/swarmhost.config.json` → `packages/hayba/swarmhost.config.json`

**Modified (TS):**
- `packages/hayba/package.json` — name, bin, description, merge deps
- `packages/hayba/src/tools/index.ts` — `registerTools(server, session)`, all tools renamed `hayba_*`
- `packages/hayba/src/index.ts` — unified server named `hayba-mcp`, load gaea config, create `SessionManager`

**New (UE plugin):**
- `packages/hayba/Plugins/HaybaMCPToolkit/HaybaMCPToolkit.uplugin`
- `packages/hayba/Plugins/HaybaMCPToolkit/Source/HaybaMCPToolkit/HaybaMCPToolkit.Build.cs`
- `packages/hayba/Plugins/HaybaMCPToolkit/Source/HaybaMCPToolkit/Public/HaybaMCPModule.h`
- `packages/hayba/Plugins/HaybaMCPToolkit/Source/HaybaMCPToolkit/Public/HaybaMCPCommandHandler.h`
- `packages/hayba/Plugins/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/HaybaMCPModule.cpp`
- `packages/hayba/Plugins/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/HaybaMCPSettings.h`
- `packages/hayba/Plugins/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/HaybaMCPSettings.cpp`
- `packages/hayba/Plugins/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/HaybaMCPLandscapeImporter.h`
- `packages/hayba/Plugins/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/HaybaMCPLandscapeImporter.cpp`
- All remaining Hayba_PcgEx_MCP files copied verbatim with renames (see Task 8)

**Deleted:**
- `packages/gaea/` (entire directory, after all code is moved)
- `packages/hayba/Plugins/Hayba_PcgEx_MCP/` (replaced by HaybaMCPToolkit)

---

## Task 1: Rename packages/pcgex → packages/hayba and update metadata

**Files:**
- Rename: `packages/pcgex/` → `packages/hayba/`
- Modify: `packages/hayba/package.json`

- [ ] **Step 1: Rename the directory**

```bash
git mv packages/pcgex packages/hayba
```

- [ ] **Step 2: Verify the rename looks clean**

```bash
git status
```

Expected: all `packages/pcgex/` entries show as renamed to `packages/hayba/`.

- [ ] **Step 3: Rewrite package.json**

Replace the entire contents of `packages/hayba/package.json` with:

```json
{
  "name": "@hayba/mcp",
  "version": "1.0.0",
  "description": "Hayba MCP Toolkit — AI-powered terrain and PCG authoring for Unreal Engine",
  "type": "module",
  "bin": {
    "hayba-mcp": "./dist/index.js"
  },
  "main": "./dist/index.js",
  "scripts": {
    "build": "tsc",
    "dev": "tsc --watch",
    "start": "node dist/index.js",
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.0.0",
    "express": "^4.21.0",
    "zod": "^3.23.0"
  },
  "devDependencies": {
    "@types/express": "^5.0.0",
    "@types/node": "^24.12.2",
    "typescript": "^5.6.0",
    "vitest": "^2.1.0"
  },
  "engines": {
    "node": ">=22.5.0"
  },
  "license": "MIT"
}
```

- [ ] **Step 4: Update the server name in src/index.ts**

In `packages/hayba/src/index.ts`, change:

```ts
const server = new McpServer({
  name: 'hayba-pcgex',
  version: '0.2.0'
});
```

to:

```ts
const server = new McpServer({
  name: 'hayba-mcp',
  version: '1.0.0'
});
```

Also update the log line:
```ts
console.error(`PCGEx Bridge MCP server v0.2.0 started on stdio`);
```
to:
```ts
console.error(`Hayba MCP Toolkit v1.0.0 started on stdio`);
```

- [ ] **Step 5: Build to confirm no breakage**

```bash
cd packages/hayba && npm install && npm run build
```

Expected: `dist/` is created with no TypeScript errors.

- [ ] **Step 6: Run existing tests**

```bash
npm test
```

Expected: All previously passing tests still pass (tcp-client, tools, catalog, resources, types).

- [ ] **Step 7: Commit**

```bash
cd ../..
git add packages/hayba/package.json packages/hayba/src/index.ts
git commit -m "refactor: rename pcgex package to @hayba/mcp"
```

---

## Task 2: Move gaea domain source files into packages/hayba/src/gaea/

**Files:**
- Create dir: `packages/hayba/src/gaea/`
- Move: `packages/gaea/src/{swarmhost.ts,gaea-launcher.ts,session.ts,file-watcher.ts,types.ts}` → `packages/hayba/src/gaea/`
- Move: `packages/gaea/src/templates/` → `packages/hayba/src/gaea/templates/`
- Move: `packages/gaea/swarmhost.config.json` → `packages/hayba/swarmhost.config.json`

None of the gaea domain files import from `./tools/`, so all internal imports (e.g. `import { SwarmHostClient } from "./swarmhost.js"` within `session.ts`) remain valid after the move — they reference siblings in the same `gaea/` directory.

- [ ] **Step 1: Create the gaea/ subdirectory and copy domain files**

```bash
mkdir packages/hayba/src/gaea
git mv packages/gaea/src/swarmhost.ts packages/hayba/src/gaea/swarmhost.ts
git mv packages/gaea/src/gaea-launcher.ts packages/hayba/src/gaea/gaea-launcher.ts
git mv packages/gaea/src/session.ts packages/hayba/src/gaea/session.ts
git mv packages/gaea/src/file-watcher.ts packages/hayba/src/gaea/file-watcher.ts
git mv packages/gaea/src/types.ts packages/hayba/src/gaea/types.ts
git mv packages/gaea/src/templates packages/hayba/src/gaea/templates
git mv packages/gaea/swarmhost.config.json packages/hayba/swarmhost.config.json
```

- [ ] **Step 2: Update tsconfig to include gaea files**

`packages/hayba/tsconfig.json` currently has `"include": ["src/**/*"]`. The gaea files are now under `src/gaea/` so they are already included — no change needed. Verify it reads:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src"
  },
  "include": ["src/**/*"]
}
```

- [ ] **Step 3: Build to confirm gaea files compile**

```bash
cd packages/hayba && npm run build
```

Expected: No errors. The gaea files compile since their internal imports are sibling-relative and unchanged.

- [ ] **Step 4: Commit**

```bash
cd ../..
git add packages/hayba/src/gaea packages/hayba/swarmhost.config.json
git commit -m "refactor: move gaea domain code into packages/hayba/src/gaea/"
```

---

## Task 3: Create gaea tool files in packages/hayba/src/tools/

Each gaea tool file is copied into `packages/hayba/src/tools/` with a `hayba-` prefix filename. Three changes per file:
1. Remove the `registerTool(...)` call at the bottom.
2. Update relative imports: `../session.js` → `../gaea/session.js`, `../types.js` → `../gaea/types.js`, `../templates/index.js` → `../gaea/templates/index.js`, `../gaea-launcher.js` → `../gaea/gaea-launcher.js`, `../file-watcher.js` → `../gaea/file-watcher.js`.
3. Remove the import of `registerTool`/`ToolHandler`/`ToolResult` from `./index.js`.

**Files:**
- Create: `packages/hayba/src/tools/hayba-bake-terrain.ts`
- Create: `packages/hayba/src/tools/hayba-create-terrain.ts`
- Create: `packages/hayba/src/tools/hayba-open-in-gaea.ts`
- Create: `packages/hayba/src/tools/hayba-read-terrain-variables.ts`
- Create: `packages/hayba/src/tools/hayba-set-terrain-variables.ts`
- Create: `packages/hayba/src/tools/hayba-open-session.ts`
- Create: `packages/hayba/src/tools/hayba-close-session.ts`
- Create: `packages/hayba/src/tools/hayba-add-node.ts`
- Create: `packages/hayba/src/tools/hayba-remove-node.ts`
- Create: `packages/hayba/src/tools/hayba-connect-nodes.ts`
- Create: `packages/hayba/src/tools/hayba-get-graph-state.ts`
- Create: `packages/hayba/src/tools/hayba-get-parameters.ts`
- Create: `packages/hayba/src/tools/hayba-set-parameter.ts`
- Create: `packages/hayba/src/tools/hayba-list-node-types.ts`
- Create: `packages/hayba/src/tools/hayba-cook-graph.ts`

- [ ] **Step 1: Create hayba-bake-terrain.ts**

`packages/hayba/src/tools/hayba-bake-terrain.ts`:

```ts
import type { SessionManager } from '../gaea/session.js';

export type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };
export type ToolHandler = (args: Record<string, unknown>, session: SessionManager) => Promise<ToolResult>;

export const bakeTerrain: ToolHandler = async (args, session) => {
  const terrainPath = (args.path as string | undefined) ?? session.terrainPath;
  if (!terrainPath) {
    return {
      content: [{ type: 'text', text: 'Error: path is required — no terrain is currently loaded.' }],
      isError: true,
    };
  }

  const variables = args.variables as Record<string, unknown> | undefined;
  const ignorecache = args.ignorecache !== false;

  if (terrainPath !== session.terrainPath) {
    await session.enqueue(() => session.client.loadGraph(terrainPath));
    session.setTerrainPath(terrainPath);
  }

  try {
    await session.enqueue(() => session.client.cook(undefined, variables, ignorecache));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { content: [{ type: 'text', text: `Bake failed: ${message}` }], isError: true };
  }

  let exported: { heightmap: string; normalmap?: string; splatmap?: string } | null = null;
  try {
    exported = await session.enqueue(() => session.client.export(session.outputDir, 'EXR'));
  } catch {
    // Cook succeeded but export scan failed — not fatal
  }

  const lines = [
    `Terrain baked successfully.`,
    `File: ${terrainPath}`,
    variables ? `Variables: ${JSON.stringify(variables)}` : null,
    ``,
    exported ? `Output files:` : `Note: Bake completed but output files not yet located.`,
    exported?.heightmap ? `  Heightmap: ${exported.heightmap}` : null,
    exported?.normalmap ? `  Normal map: ${exported.normalmap}` : null,
    exported?.splatmap  ? `  Splatmap: ${exported.splatmap}` : null,
  ].filter(Boolean).join('\n');

  return { content: [{ type: 'text', text: lines }] };
};
```

- [ ] **Step 2: Create hayba-open-session.ts**

`packages/hayba/src/tools/hayba-open-session.ts`:

```ts
import type { SessionManager } from '../gaea/session.js';
import type { ToolHandler } from './hayba-bake-terrain.js';

export const openSessionHandler: ToolHandler = async (args, session) => {
  if (typeof args.path !== 'string' || !args.path.trim()) {
    return { content: [{ type: 'text', text: 'Error: path is required and must be a non-empty string' }], isError: true };
  }

  const terrainPath = args.path.trim();
  await session.enqueue(() => session.client.loadGraph(terrainPath));
  session.setTerrainPath(terrainPath);

  return {
    content: [{
      type: 'text',
      text: [
        `Session opened successfully.`,
        `Terrain file: ${terrainPath}`,
        ``,
        `You can now call hayba_get_graph_state to inspect the graph, hayba_get_parameters to examine a node, or hayba_set_parameter to modify values.`
      ].join('\n')
    }]
  };
};
```

- [ ] **Step 3: Create hayba-close-session.ts**

`packages/hayba/src/tools/hayba-close-session.ts`:

```ts
import type { ToolHandler } from './hayba-bake-terrain.js';
import { stopWatching } from '../gaea/file-watcher.js';
import { isProcessRunning } from '../gaea/gaea-launcher.js';

export const closeSessionHandler: ToolHandler = async (_args, session) => {
  stopWatching();
  if (session.gaeaPid && isProcessRunning(session.gaeaPid)) {
    try { process.kill(session.gaeaPid); } catch { /* ignore */ }
  }
  session.clearGaeaSession();
  return { content: [{ type: 'text', text: 'Session closed. Gaea stopped.' }] };
};
```

- [ ] **Step 4: Create hayba-get-graph-state.ts**

`packages/hayba/src/tools/hayba-get-graph-state.ts`:

```ts
import type { ToolHandler } from './hayba-bake-terrain.js';

export const getGraphStateHandler: ToolHandler = async (_args, session) => {
  const state = await session.enqueue(() => session.client.getGraphState());

  const nodeLines = state.nodes.map(
    (n) =>
      `  [${n.cookStatus}] ${n.id} (${n.type})` +
      (Object.keys(n.params).length ? `\n    params: ${JSON.stringify(n.params)}` : '')
  );
  const edgeLines = state.edges.map(
    (e) => `  ${e.from}:${e.fromPort} → ${e.to}:${e.toPort}`
  );

  const text = [
    `## Current Graph State`,
    ``,
    `### Nodes (${state.nodes.length})`,
    ...nodeLines,
    ``,
    `### Connections (${state.edges.length})`,
    ...(edgeLines.length ? edgeLines : ['  (no connections)']),
    ``,
    `Call hayba_get_parameters to inspect a specific node's parameters.`
  ].join('\n');

  return { content: [{ type: 'text', text }] };
};
```

- [ ] **Step 5: Create hayba-get-parameters.ts**

`packages/hayba/src/tools/hayba-get-parameters.ts`:

```ts
import type { ToolHandler } from './hayba-bake-terrain.js';

export const getParametersHandler: ToolHandler = async (args, session) => {
  if (typeof args.node_id !== 'string' || !args.node_id.trim()) {
    return { content: [{ type: 'text', text: 'Error: node_id is required' }], isError: true };
  }

  const nodeId = args.node_id;
  const params = await session.enqueue(() => session.client.getParameters(nodeId));

  if (params.length === 0) {
    return { content: [{ type: 'text', text: `## Parameters for node \`${nodeId}\`\n\n  (no editable parameters)\n` }] };
  }

  const lines = params.map((p) => {
    const range = p.min !== undefined && p.max !== undefined ? ` [${p.min} - ${p.max}]` : '';
    return `  - **${p.name}** (${p.type})${range}, default: ${p.default}`;
  });

  const text = [
    `## Parameters for node \`${nodeId}\``,
    ``,
    ...lines,
    ``,
    `Call hayba_set_parameter then hayba_cook_graph to apply changes.`
  ].join('\n');

  return { content: [{ type: 'text', text }] };
};
```

- [ ] **Step 6: Create hayba-set-parameter.ts**

`packages/hayba/src/tools/hayba-set-parameter.ts`:

```ts
import type { ToolHandler } from './hayba-bake-terrain.js';

export const setParameterHandler: ToolHandler = async (args, session) => {
  if (typeof args.node_id !== 'string' || !args.node_id.trim()) {
    return { content: [{ type: 'text', text: 'Error: node_id is required' }], isError: true };
  }
  if (typeof args.parameter !== 'string' || !args.parameter.trim()) {
    return { content: [{ type: 'text', text: 'Error: parameter is required' }], isError: true };
  }
  if (typeof args.value !== 'string' && typeof args.value !== 'number' && typeof args.value !== 'boolean') {
    return { content: [{ type: 'text', text: 'Error: value must be a string, number, or boolean' }], isError: true };
  }

  await session.enqueue(() => session.client.setParameter(args.node_id as string, args.parameter as string, args.value as string | number | boolean));

  return {
    content: [{
      type: 'text',
      text: `Set \`${args.node_id}.${args.parameter}\` = ${JSON.stringify(args.value)}.\nDownstream nodes are now dirty. Call hayba_cook_graph to re-render.`
    }]
  };
};
```

- [ ] **Step 7: Create hayba-cook-graph.ts**

`packages/hayba/src/tools/hayba-cook-graph.ts`:

```ts
import type { ToolHandler } from './hayba-bake-terrain.js';

export const cookGraphHandler: ToolHandler = async (args, session) => {
  if (args.nodes !== undefined && !Array.isArray(args.nodes)) {
    return { content: [{ type: 'text', text: 'Error: nodes must be an array of node id strings' }], isError: true };
  }

  const nodeIds = Array.isArray(args.nodes)
    ? (args.nodes as unknown[]).filter((x): x is string => typeof x === 'string')
    : undefined;

  const exported = await session.enqueue(async () => {
    await session.client.cook(nodeIds);
    return session.client.export(session.outputDir, 'EXR');
  });

  const lines = [
    nodeIds ? `Re-cooked nodes: ${nodeIds.join(', ')}` : 'Full graph cooked.',
    ``,
    `Updated output files:`,
    `  Heightmap: ${exported.heightmap}`,
    exported.normalmap ? `  Normal map: ${exported.normalmap}` : null,
    exported.splatmap  ? `  Splatmap: ${exported.splatmap}` : null,
  ].filter(Boolean).join('\n');

  return { content: [{ type: 'text', text: lines }] };
};
```

- [ ] **Step 8: Create hayba-add-node.ts**

`packages/hayba/src/tools/hayba-add-node.ts`:

```ts
import type { ToolHandler } from './hayba-bake-terrain.js';

export const addNodeHandler: ToolHandler = async (args, session) => {
  if (!session.terrainPath) {
    return { content: [{ type: 'text', text: 'No session open. Call hayba_open_session first.' }], isError: true };
  }
  if (typeof args.type !== 'string' || !args.type.trim()) {
    return { content: [{ type: 'text', text: 'Error: type is required. Call hayba_list_node_types to see options.' }], isError: true };
  }
  if (typeof args.id !== 'string' || !args.id.trim()) {
    return { content: [{ type: 'text', text: 'Error: id is required — a unique name for this node.' }], isError: true };
  }

  const params = (args.params as Record<string, unknown>) ?? {};
  const pos = args.position as { X: number; Y: number } | undefined;
  await session.enqueue(() => session.client.addNode(args.type as string, args.id as string, params, pos));

  return {
    content: [{ type: 'text', text: `Added ${args.type} node "${args.id}". Call hayba_connect_nodes to wire it, or hayba_cook_graph to build.` }]
  };
};
```

- [ ] **Step 9: Create hayba-remove-node.ts**

`packages/hayba/src/tools/hayba-remove-node.ts`:

```ts
import type { ToolHandler } from './hayba-bake-terrain.js';

export const removeNodeHandler: ToolHandler = async (args, session) => {
  if (!session.terrainPath) {
    return { content: [{ type: 'text', text: 'No session open. Call hayba_open_session first.' }], isError: true };
  }
  if (typeof args.id !== 'string' || !args.id.trim()) {
    return { content: [{ type: 'text', text: 'Error: id is required.' }], isError: true };
  }

  try {
    await session.enqueue(() => session.client.removeNode(args.id as string));
  } catch (e) {
    return { content: [{ type: 'text', text: `Error: ${(e as Error).message}` }], isError: true };
  }

  return { content: [{ type: 'text', text: `Removed node "${args.id}" and its connections.` }] };
};
```

- [ ] **Step 10: Create hayba-connect-nodes.ts**

`packages/hayba/src/tools/hayba-connect-nodes.ts`:

```ts
import type { ToolHandler } from './hayba-bake-terrain.js';

export const connectNodesHandler: ToolHandler = async (args, session) => {
  if (!session.terrainPath) {
    return { content: [{ type: 'text', text: 'No session open. Call hayba_open_session first.' }], isError: true };
  }
  for (const field of ['from_id', 'from_port', 'to_id', 'to_port'] as const) {
    if (typeof args[field] !== 'string') {
      return { content: [{ type: 'text', text: `Error: ${field} is required.` }], isError: true };
    }
  }

  try {
    await session.enqueue(() =>
      session.client.connectNodes(
        args.from_id as string, args.from_port as string,
        args.to_id as string, args.to_port as string
      )
    );
  } catch (e) {
    return { content: [{ type: 'text', text: `Error: ${(e as Error).message}` }], isError: true };
  }

  return { content: [{ type: 'text', text: `Connected ${args.from_id}:${args.from_port} → ${args.to_id}:${args.to_port}` }] };
};
```

- [ ] **Step 11: Create hayba-list-node-types.ts**

`packages/hayba/src/tools/hayba-list-node-types.ts`:

```ts
import type { ToolHandler, ToolResult } from './hayba-bake-terrain.js';
import type { SwarmNodeType } from '../gaea/types.js';

let cache: SwarmNodeType[] | null = null;

export function clearCache(): void { cache = null; }

export const listNodeTypesHandler: ToolHandler = async (args, session) => {
  const category = typeof args.category === 'string' ? args.category : undefined;
  if (!category && cache) return formatResult(cache);
  const nodes = await session.enqueue(() => session.client.listNodeTypes(category));
  if (!category) cache = nodes;
  return formatResult(nodes);
};

function formatResult(nodes: SwarmNodeType[]): ToolResult {
  const lines = nodes.map((n) => {
    const params = n.parameters.map((p) => `    - ${p.name} (${p.type}, default: ${p.default})`).join('\n');
    return [
      `## ${n.type}`,
      `Category: ${n.category}`,
      `Inputs: ${n.inputs.length ? n.inputs.join(', ') : 'none'}`,
      `Outputs: ${n.outputs.join(', ')}`,
      params ? `Parameters:\n${params}` : 'Parameters: none'
    ].join('\n');
  });
  return { content: [{ type: 'text', text: lines.join('\n\n') }] };
}
```

- [ ] **Step 12: Create hayba-open-in-gaea.ts**

`packages/hayba/src/tools/hayba-open-in-gaea.ts`:

```ts
import type { ToolHandler } from './hayba-bake-terrain.js';
import { launchGaea, detectGaeaPath } from '../gaea/gaea-launcher.js';

export const openInGaeaTool: ToolHandler = async (args, session) => {
  const terrainPath = (args.path as string | undefined) ?? session.terrainPath;
  if (!terrainPath) {
    return { content: [{ type: 'text', text: 'Error: no terrain path provided and no terrain currently loaded.' }], isError: true };
  }

  const gaeaExePath = session.gaeaExePath || detectGaeaPath();
  if (!gaeaExePath) {
    return { content: [{ type: 'text', text: 'Error: Gaea.exe not found. Set gaeaExePath in swarmhost.config.json.' }], isError: true };
  }

  try {
    const pid = launchGaea(gaeaExePath, terrainPath);
    return {
      content: [{
        type: 'text',
        text: [
          `Gaea launched successfully.`,
          `File: ${terrainPath}`,
          `PID: ${pid}`,
          ``,
          `Note: Gaea does not auto-reload open files. If this file was already open, close and reopen it.`,
        ].join('\n')
      }]
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { content: [{ type: 'text', text: `Failed to open in Gaea: ${message}` }], isError: true };
  }
};
```

- [ ] **Step 13: Create hayba-read-terrain-variables.ts**

`packages/hayba/src/tools/hayba-read-terrain-variables.ts`:

```ts
import type { ToolHandler } from './hayba-bake-terrain.js';

export const readTerrainVariablesTool: ToolHandler = async (args, session) => {
  const terrainPath = (args.path as string | undefined) ?? session.terrainPath;
  if (!terrainPath) {
    return { content: [{ type: 'text', text: 'Error: no terrain is currently loaded and no path was provided.' }], isError: true };
  }

  const variables = session.client.readTerrainVariables(terrainPath);
  const count = Object.keys(variables).length;

  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        terrainPath,
        variableCount: count,
        variables,
        usage: count === 0
          ? 'No variables declared. Set up variable bindings in the Gaea UI, or use a template that declares variable contracts.'
          : 'Pass these variable names in hayba_bake_terrain({ variables: { key: value } }) to override at bake time.',
      }, null, 2)
    }]
  };
};
```

- [ ] **Step 14: Create hayba-set-terrain-variables.ts**

`packages/hayba/src/tools/hayba-set-terrain-variables.ts`:

```ts
import type { ToolHandler } from './hayba-bake-terrain.js';
import type { TemplateVariableContract } from '../gaea/types.js';

export const setTerrainVariablesTool: ToolHandler = async (args, session) => {
  const terrainPath = (args.path as string | undefined) ?? session.terrainPath;
  if (!terrainPath) {
    return { content: [{ type: 'text', text: 'Error: no terrain path provided.' }], isError: true };
  }
  if (!args.contract || typeof args.contract !== 'object') {
    return { content: [{ type: 'text', text: 'Error: contract is required — provide a variable contract object.' }], isError: true };
  }

  const contract = args.contract as TemplateVariableContract;
  const values = (args.values as Record<string, unknown>) ?? {};

  try {
    session.client.setTerrainVariables(contract, values, terrainPath);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
  }

  const updated = session.client.readTerrainVariables(terrainPath);
  return {
    content: [{
      type: 'text',
      text: JSON.stringify({ terrainPath, variablesWritten: Object.keys(contract).length, variables: updated }, null, 2)
    }]
  };
};
```

- [ ] **Step 15: Create hayba-create-terrain.ts**

`packages/hayba/src/tools/hayba-create-terrain.ts`:

```ts
import type { ToolHandler } from './hayba-bake-terrain.js';
import { GraphSchema } from '../gaea/types.js';
import { getTemplate, listTemplates } from '../gaea/templates/index.js';

export const createTerrainHandler: ToolHandler = async (args, session) => {
  if (typeof args.prompt !== 'string' || !args.prompt.trim()) {
    return { content: [{ type: 'text', text: 'Error: prompt is required and must be a non-empty string' }], isError: true };
  }

  const resolution = (args.resolution as number) ?? 1024;
  const outputDir = (args.output_dir as string) ?? session.outputDir;

  if (typeof args.template === 'string') {
    const overrides = (args.template_overrides as Record<string, unknown>) ?? {};
    const graph = getTemplate(args.template, overrides);
    if (!graph) {
      const available = listTemplates().map(t => `  - ${t.name}: ${t.description}`).join('\n');
      return {
        content: [{ type: 'text', text: `Unknown template "${args.template}". Available templates:\n${available}` }],
        isError: true
      };
    }
    args.graph = graph;
  }

  if (args.graph) {
    const validation = GraphSchema.safeParse(args.graph);
    if (!validation.success) {
      return {
        content: [{ type: 'text', text: `Graph validation failed: ${validation.error.message}` }],
        isError: true
      };
    }

    await session.enqueue(async () => { await session.client.createGraph(validation.data); });
    const terrainPath = session.client.currentTerrainPath;

    let exported: { heightmap: string; normalmap?: string; splatmap?: string } | null = null;
    let cookError: string | null = null;
    try {
      await session.enqueue(async () => { await session.client.cook(); });
      exported = await session.enqueue(() =>
        session.client.export(outputDir, resolution > 1024 ? 'EXR' : 'PNG')
      );
    } catch (e) { cookError = (e as Error).message; }

    if (terrainPath) session.setTerrainPath(terrainPath);

    if (exported) {
      const lines = [
        `Terrain generated and cooked successfully.`,
        `Prompt: "${args.prompt}"`,
        ``,
        `Output files:`,
        `  Heightmap: ${exported.heightmap}`,
        exported.normalmap ? `  Normal map: ${exported.normalmap}` : null,
        exported.splatmap  ? `  Splatmap: ${exported.splatmap}` : null,
        ``,
        `You can call hayba_get_graph_state to inspect the graph.`
      ].filter(Boolean).join('\n');
      return { content: [{ type: 'text', text: lines }] };
    }

    const lines = [
      `Terrain graph created successfully.`,
      `Prompt: "${args.prompt}"`,
      terrainPath ? `\nTerrain file: ${terrainPath}` : ``,
      `\nNote: Cooking/export failed — open the .terrain file in Gaea to cook manually.`,
      cookError ? `  Error: ${cookError}` : ``,
      ``,
      `You can call hayba_get_graph_state to inspect the graph.`
    ].filter(Boolean).join('\n');
    return { content: [{ type: 'text', text: lines }] };
  }

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
    `If you cannot build a full graph, use a template instead:`,
    ...templates.map(t => `  - **${t.name}**: ${t.description} (tweakable: ${(t.tweakable ?? []).join(', ')})`),
    ``,
    `Call: hayba_create_terrain(prompt="...", template="desert", template_overrides={"Seed": 42})`,
    ``,
    `## Advanced: Build a Custom Graph`
  ].join('\n');

  return {
    content: [{
      type: 'text',
      text: [
        templateSection,
        ``,
        `No graph provided. Please build a graph JSON and call again with the "graph" parameter.`,
        ``,
        `The graph must have: { "nodes": [...], "edges": [...] }`,
        `Each node: { "id": "unique_id", "type": "NodeType", "params": { ... } }`,
        `Each edge: { "from": "node_id", "fromPort": "port", "to": "node_id", "toPort": "port" }`,
        ``,
        `Available nodes:`,
        ``,
        catalog,
        ``,
        `Prompt to fulfill: "${args.prompt}"`
      ].join('\n')
    }]
  };
};
```

- [ ] **Step 16: Build to verify new tool files compile**

```bash
cd packages/hayba && npm run build
```

Expected: No TypeScript errors. The new `hayba-*.ts` tool files compile, even though they aren't registered yet.

- [ ] **Step 17: Commit**

```bash
cd ../..
git add packages/hayba/src/tools/hayba-bake-terrain.ts \
        packages/hayba/src/tools/hayba-open-session.ts \
        packages/hayba/src/tools/hayba-close-session.ts \
        packages/hayba/src/tools/hayba-get-graph-state.ts \
        packages/hayba/src/tools/hayba-get-parameters.ts \
        packages/hayba/src/tools/hayba-set-parameter.ts \
        packages/hayba/src/tools/hayba-cook-graph.ts \
        packages/hayba/src/tools/hayba-add-node.ts \
        packages/hayba/src/tools/hayba-remove-node.ts \
        packages/hayba/src/tools/hayba-connect-nodes.ts \
        packages/hayba/src/tools/hayba-list-node-types.ts \
        packages/hayba/src/tools/hayba-open-in-gaea.ts \
        packages/hayba/src/tools/hayba-read-terrain-variables.ts \
        packages/hayba/src/tools/hayba-set-terrain-variables.ts \
        packages/hayba/src/tools/hayba-create-terrain.ts
git commit -m "feat: add gaea tool handlers to packages/hayba/src/tools/"
```

---

## Task 4: Update tools/index.ts — centralized registration, hayba_ prefix on all tools

**Files:**
- Modify: `packages/hayba/src/tools/index.ts`

Replace the entire file with the version below. All pcgex tool names gain the `hayba_` prefix. All gaea tools are added via `server.tool()`, receiving the session from the new `registerTools(server, session)` signature.

- [ ] **Step 1: Rewrite tools/index.ts**

`packages/hayba/src/tools/index.ts`:

```ts
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { SessionManager } from '../gaea/session.js';

// ── PCGEx tool handlers ───────────────────────────────────────────────────────
import { searchNodeCatalog } from './search-node-catalog.js';
import { getNodeDetails } from './get-node-details.js';
import { createPcgGraph } from './create-pcg-graph.js';
import { validatePcgGraph } from './validate-pcg-graph.js';
import { listPcgAssets } from './list-pcg-assets.js';
import { exportPcgGraph } from './export-pcg-graph.js';
import { executePcgGraph } from './execute-pcg-graph.js';
import { checkUeStatus } from './check-ue-status.js';
import { scrapeNodeRegistry } from './scrape-node-registry.js';
import { matchPinNames } from './match-pin-names.js';
import { validateAttributeFlow } from './validate-attribute-flow.js';
import { diffAgainstWorkingAsset } from './diff-against-working-asset.js';
import { formatGraphTopology } from './format-graph-topology.js';
import { abstractToSubgraph } from './abstract-to-subgraph.js';
import { parameterizeGraphInputs } from './parameterize-graph-inputs.js';
import { queryPcgexDocs } from './query-pcgex-docs.js';
import { initiateInfrastructureBrainstorm } from './initiate-infrastructure-brainstorm.js';
import { injectDebugNodes, DEBUG_SUBGRAPHS } from './inject-debug-nodes.js';
import { autoWireDebugOverlay } from './auto-wire-debug-overlay.js';

// ── Gaea tool handlers ────────────────────────────────────────────────────────
import { bakeTerrain } from './hayba-bake-terrain.js';
import { createTerrainHandler } from './hayba-create-terrain.js';
import { openInGaeaTool } from './hayba-open-in-gaea.js';
import { readTerrainVariablesTool } from './hayba-read-terrain-variables.js';
import { setTerrainVariablesTool } from './hayba-set-terrain-variables.js';
import { openSessionHandler } from './hayba-open-session.js';
import { closeSessionHandler } from './hayba-close-session.js';
import { addNodeHandler } from './hayba-add-node.js';
import { removeNodeHandler } from './hayba-remove-node.js';
import { connectNodesHandler } from './hayba-connect-nodes.js';
import { getGraphStateHandler } from './hayba-get-graph-state.js';
import { getParametersHandler } from './hayba-get-parameters.js';
import { setParameterHandler } from './hayba-set-parameter.js';
import { listNodeTypesHandler } from './hayba-list-node-types.js';
import { cookGraphHandler } from './hayba-cook-graph.js';

export function registerTools(server: McpServer, session: SessionManager): void {

  // ── PCGEx tools ─────────────────────────────────────────────────────────────

  server.tool(
    'hayba_search_node_catalog',
    { query: z.string().describe('Search query — keyword, node class, or category') },
    async ({ query }) => {
      const result = await searchNodeCatalog({ query });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    'hayba_get_node_details',
    { class: z.string().describe('PCGEx node class name') },
    async (params) => {
      const result = await getNodeDetails({ class: params.class });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    'hayba_create_pcg_graph',
    {
      graph: z.string().describe('JSON string of the PCGEx graph topology'),
      name: z.string().describe('Asset name for the new PCGGraph')
    },
    async ({ graph, name }) => {
      const result = await createPcgGraph({ graph, name });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    'hayba_validate_pcg_graph',
    { graph: z.string().describe('JSON string of the PCGEx graph to validate') },
    async ({ graph }) => {
      const result = await validatePcgGraph({ graph });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    'hayba_list_pcg_assets',
    { path: z.string().optional().describe('Content path filter (default: /Game/)') },
    async ({ path }) => {
      const result = await listPcgAssets({ path });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    'hayba_export_pcg_graph',
    { assetPath: z.string().describe('Full UE asset path to the PCGGraph') },
    async ({ assetPath }) => {
      const result = await exportPcgGraph({ assetPath });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    'hayba_execute_pcg_graph',
    { assetPath: z.string().describe('Full UE asset path to execute') },
    async ({ assetPath }) => {
      const result = await executePcgGraph({ assetPath });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    'hayba_check_ue_status',
    {},
    async () => {
      const result = await checkUeStatus();
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    'hayba_scrape_node_registry',
    {
      pluginSourcePath: z.string().optional().describe('Path to PCGExtendedToolkit/Source/'),
      outputDbPath: z.string().optional().describe('Output SQLite DB path'),
      forceRescan: z.boolean().optional().describe('Force re-scan even if DB exists'),
    },
    async (params) => {
      const result = await scrapeNodeRegistry(params as any);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    'hayba_match_pin_names',
    {
      fromClass: z.string().describe('Source node class'),
      fromPin: z.string().describe('Pin name on source node'),
      toClass: z.string().describe('Target node class'),
    },
    async (params) => {
      const result = await matchPinNames(params);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    'hayba_validate_attribute_flow',
    {
      graph: z.string().describe('JSON string of the PCGEx graph to validate attribute flow'),
      strictMode: z.boolean().optional().describe('Also flag orphan writes'),
    },
    async (params) => {
      const result = await validateAttributeFlow(params as any);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    'hayba_diff_against_working_asset',
    {
      wipGraph: z.string().describe('JSON string of the work-in-progress graph'),
      referenceAssetPath: z.string().describe('Full UE asset path to the reference PCGGraph'),
      diffMode: z.enum(['structural', 'properties', 'full']).optional(),
    },
    async (params) => {
      const result = await diffAgainstWorkingAsset(params as any);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    'hayba_format_graph_topology',
    {
      graph: z.string().describe('JSON string of the PCGEx graph to layout'),
      algorithm: z.enum(['layered', 'grid']).optional(),
      nodeWidth: z.number().int().optional(),
      nodeHeight: z.number().int().optional(),
      horizontalSpacing: z.number().int().optional(),
      verticalSpacing: z.number().int().optional(),
      addCommentBlocks: z.boolean().optional(),
    },
    async (params) => {
      const result = await formatGraphTopology(params as any);
      return { content: [{ type: 'text', text: result }] };
    }
  );

  server.tool(
    'hayba_abstract_to_subgraph',
    {
      graph: z.string().describe('JSON string of the full PCGEx graph'),
      nodeIds: z.array(z.string()).describe('Node IDs to extract'),
      subgraphName: z.string().optional(),
    },
    async (params) => {
      const result = await abstractToSubgraph(params as any);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    'hayba_parameterize_graph_inputs',
    {
      graph: z.string().describe('JSON string of the PCGEx graph'),
      targets: z.array(z.object({
        nodeId: z.string(),
        property: z.string(),
        parameterName: z.string().optional(),
      })),
    },
    async (params) => {
      const result = await parameterizeGraphInputs(params);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    'hayba_query_pcgex_docs',
    {
      query: z.string().describe('Node class name or keyword'),
      includeSourceSnippet: z.boolean().optional().default(false),
    },
    async (params) => {
      const result = await queryPcgexDocs(params as any);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    'hayba_initiate_infrastructure_brainstorm',
    'Plan complex graph architectures. IMPORTANT: After calling this tool, do NOT call hayba_create_pcg_graph or any graph-mutation tool until the user explicitly approves an approach.',
    {
      topic: z.string().describe('The infrastructure or system design topic to brainstorm'),
      context: z.string().optional(),
      constraints: z.array(z.string()).optional(),
    },
    async (params) => {
      const result = await initiateInfrastructureBrainstorm(params);
      return {
        content: [{
          type: 'text',
          text: JSON.stringify(result, null, 2) +
            '\n\n---\nIMPORTANT: This is a PROPOSAL ONLY. Do NOT call hayba_create_pcg_graph, ' +
            'hayba_validate_attribute_flow, hayba_abstract_to_subgraph, or any graph-mutation tool ' +
            'until the user has explicitly approved an approach above.',
        }]
      };
    }
  );

  server.tool(
    'hayba_inject_debug_nodes',
    'Insert a PCGEx debug subgraph node onto specific edges of a live PCGGraph asset. ' +
    'Requires UE to be running with the TCP bridge active. ' +
    'IMPORTANT: call hayba_export_pcg_graph first to get current node IDs.',
    {
      assetPath: z.string().describe('Full UE asset path to the PCGGraph'),
      edges: z.array(z.object({
        fromNode: z.string(),
        fromPin: z.string(),
        toNode: z.string(),
        toPin: z.string(),
      })).min(1),
      label: z.string().optional(),
      debugSubgraph: z.enum(DEBUG_SUBGRAPHS).optional(),
    },
    async (params) => {
      const result = await injectDebugNodes(params as any);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    'hayba_auto_wire_debug_overlay',
    'Automatically inject PCGEx debug subgraph nodes on all (or filtered) edges of a PCGGraph asset. ' +
    'Use dryRun:true first to preview. Requires UE running with TCP bridge active.',
    {
      assetPath: z.string().describe('Full UE asset path to the PCGGraph'),
      debugSubgraph: z.enum(DEBUG_SUBGRAPHS).optional(),
      edgeFilter: z.object({
        fromClass: z.string().optional(),
        toClass: z.string().optional(),
        pinName: z.string().optional(),
      }).optional(),
      dryRun: z.boolean().optional(),
    },
    async (params) => {
      const result = await autoWireDebugOverlay(params as any);
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  );

  // ── Gaea tools ───────────────────────────────────────────────────────────────

  server.tool(
    'hayba_bake_terrain',
    {
      path: z.string().optional().describe('Absolute path to the .terrain file (uses loaded terrain if omitted)'),
      variables: z.record(z.unknown()).optional().describe('Variable overrides to inject as -v key=value flags'),
      ignorecache: z.boolean().optional().describe('Force full re-bake ignoring cache (default: true)'),
    },
    async (params) => {
      const result = await bakeTerrain(params as Record<string, unknown>, session);
      return { content: result.content, isError: result.isError };
    }
  );

  server.tool(
    'hayba_create_terrain',
    {
      prompt: z.string().describe('Natural language terrain description'),
      template: z.string().optional().describe('Predefined terrain template: desert, mountains, tropical, volcanic'),
      template_overrides: z.record(z.unknown()).optional().describe('Override specific template parameters'),
      graph: z.unknown().optional().describe('Full Gaea node graph JSON with nodes and edges arrays'),
      output_dir: z.string().optional().describe('Output directory (uses config default if omitted)'),
      resolution: z.number().optional().describe('Output heightmap resolution: 1024, 2048, or 4096 (default: 1024)'),
    },
    async (params) => {
      const result = await createTerrainHandler(params as Record<string, unknown>, session);
      return { content: result.content, isError: result.isError };
    }
  );

  server.tool(
    'hayba_open_in_gaea',
    { path: z.string().optional().describe('Absolute path to the .terrain file (uses current terrain if omitted)') },
    async (params) => {
      const result = await openInGaeaTool(params as Record<string, unknown>, session);
      return { content: result.content, isError: result.isError };
    }
  );

  server.tool(
    'hayba_read_terrain_variables',
    { path: z.string().optional().describe('Absolute path to the .terrain file (uses current terrain if omitted)') },
    async (params) => {
      const result = await readTerrainVariablesTool(params as Record<string, unknown>, session);
      return { content: result.content, isError: result.isError };
    }
  );

  server.tool(
    'hayba_set_terrain_variables',
    {
      path: z.string().optional().describe('Absolute path to the .terrain file (uses current terrain if omitted)'),
      contract: z.record(z.unknown()).describe('Variable contract: keys are variable names, values define type/default/min/max'),
      values: z.record(z.unknown()).optional().describe('Values to write; missing keys use contract defaults'),
    },
    async (params) => {
      const result = await setTerrainVariablesTool(params as Record<string, unknown>, session);
      return { content: result.content, isError: result.isError };
    }
  );

  server.tool(
    'hayba_open_session',
    { path: z.string().describe('Absolute path to the .terrain file to open') },
    async (params) => {
      const result = await openSessionHandler(params as Record<string, unknown>, session);
      return { content: result.content, isError: result.isError };
    }
  );

  server.tool(
    'hayba_close_session',
    {},
    async () => {
      const result = await closeSessionHandler({}, session);
      return { content: result.content, isError: result.isError };
    }
  );

  server.tool(
    'hayba_add_node',
    {
      type: z.string().describe('Node type, e.g. "Mountain", "Erosion2". Call hayba_list_node_types to see options.'),
      id: z.string().describe('Unique name for this node, e.g. "peaks", "erode"'),
      params: z.record(z.unknown()).optional().describe('Optional parameter overrides'),
      position: z.object({ X: z.number(), Y: z.number() }).optional(),
    },
    async (params) => {
      const result = await addNodeHandler(params as Record<string, unknown>, session);
      return { content: result.content, isError: result.isError };
    }
  );

  server.tool(
    'hayba_remove_node',
    { id: z.string().describe('Node id to remove') },
    async (params) => {
      const result = await removeNodeHandler(params as Record<string, unknown>, session);
      return { content: result.content, isError: result.isError };
    }
  );

  server.tool(
    'hayba_connect_nodes',
    {
      from_id: z.string().describe('Source node id'),
      from_port: z.string().describe('Source port, e.g. "Out"'),
      to_id: z.string().describe('Target node id'),
      to_port: z.string().describe('Target port, e.g. "In"'),
    },
    async (params) => {
      const result = await connectNodesHandler(params as Record<string, unknown>, session);
      return { content: result.content, isError: result.isError };
    }
  );

  server.tool(
    'hayba_get_graph_state',
    {},
    async () => {
      const result = await getGraphStateHandler({}, session);
      return { content: result.content, isError: result.isError };
    }
  );

  server.tool(
    'hayba_get_parameters',
    { node_id: z.string().describe('Node id as shown in hayba_get_graph_state') },
    async (params) => {
      const result = await getParametersHandler(params as Record<string, unknown>, session);
      return { content: result.content, isError: result.isError };
    }
  );

  server.tool(
    'hayba_set_parameter',
    {
      node_id: z.string(),
      parameter: z.string().describe('Parameter name as returned by hayba_get_parameters'),
      value: z.union([z.string(), z.number(), z.boolean()]).describe('New value within valid range'),
    },
    async (params) => {
      const result = await setParameterHandler(params as Record<string, unknown>, session);
      return { content: result.content, isError: result.isError };
    }
  );

  server.tool(
    'hayba_list_node_types',
    { category: z.string().optional().describe('Filter by category, e.g. "erosion", "primitives"') },
    async (params) => {
      const result = await listNodeTypesHandler(params as Record<string, unknown>, session);
      return { content: result.content, isError: result.isError };
    }
  );

  server.tool(
    'hayba_cook_graph',
    { nodes: z.array(z.string()).optional().describe('Node ids for partial re-cook; omit for full cook') },
    async (params) => {
      const result = await cookGraphHandler(params as Record<string, unknown>, session);
      return { content: result.content, isError: result.isError };
    }
  );
}
```

- [ ] **Step 2: Build**

```bash
cd packages/hayba && npm run build
```

Expected: No TypeScript errors.

- [ ] **Step 3: Commit**

```bash
cd ../..
git add packages/hayba/src/tools/index.ts
git commit -m "feat: unify tool registration — all tools prefixed hayba_"
```

---

## Task 5: Update src/index.ts — unified server with gaea session

**Files:**
- Modify: `packages/hayba/src/index.ts`

The existing `index.ts` calls `registerTools(server)`. We need to change the signature to `registerTools(server, session)` and add the gaea session initialization (loading `swarmhost.config.json`, creating `SessionManager`).

- [ ] **Step 1: Rewrite src/index.ts**

`packages/hayba/src/index.ts`:

```ts
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { listCatalogResources, readCatalogResource } from './resources.js';
import { registerTools } from './tools/index.js';
import { startDashboard } from './dashboard/server.js';
import { SessionManager } from './gaea/session.js';
import { detectGaeaPath } from './gaea/gaea-launcher.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Gaea session setup ────────────────────────────────────────────────────────
const swarmConfigPath = resolve(__dirname, '..', 'swarmhost.config.json');
const swarmConfig = JSON.parse(readFileSync(swarmConfigPath, 'utf-8').replace(/^\uFEFF/, ''));

if (!swarmConfig.gaeaExePath) {
  const detected = detectGaeaPath();
  if (detected) swarmConfig.gaeaExePath = detected;
}

const gaeaSession = new SessionManager(swarmConfig);

// ── MCP server setup ─────────────────────────────────────────────────────────
const server = new McpServer({
  name: 'hayba-mcp',
  version: '1.0.0'
});

// Register catalog resources (PCGEx node catalog)
const catalogTemplate = new ResourceTemplate('pcgex://catalog/{category}', {
  list: async () => {
    const resources = await listCatalogResources();
    return { resources: resources.map(r => ({ uri: r.uri, name: r.name, description: r.description, mimeType: r.mimeType })) };
  }
});

server.resource('pcgex_catalog', catalogTemplate, async (uri, { category }) => {
  const content = await readCatalogResource(category as string);
  return {
    contents: [{ uri: uri.href, mimeType: 'application/json', text: content }]
  };
});

// Register all tools (PCGEx + Gaea)
registerTools(server, gaeaSession);

// ── Start ─────────────────────────────────────────────────────────────────────
async function main() {
  await startDashboard(config.dashboardPort, '127.0.0.1');
  console.error(`Dashboard: http://127.0.0.1:${config.dashboardPort}`);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`Hayba MCP Toolkit v1.0.0 started on stdio`);
  console.error(`UE TCP target: ${config.ueTcpHost}:${config.ueTcpPort}`);
}

main().catch(console.error);
```

- [ ] **Step 2: Build**

```bash
cd packages/hayba && npm run build
```

Expected: No errors. The dist/index.js is emitted.

- [ ] **Step 3: Run tests**

```bash
npm test
```

Expected: All pcgex tests still pass. Gaea tests are not yet moved — that's Task 6.

- [ ] **Step 4: Commit**

```bash
cd ../..
git add packages/hayba/src/index.ts
git commit -m "feat: unified MCP server with gaea session in src/index.ts"
```

---

## Task 6: Move gaea tests into packages/hayba and fix import paths

All gaea tests move to `packages/hayba/tests/gaea/`. Three import path changes per file:
1. `../../src/tools/{name}` → `../../src/tools/hayba-{name}` (tool files renamed)
2. `../../src/session` → `../../src/gaea/session`
3. `../../src/gaea-launcher` → `../../src/gaea/gaea-launcher` (for launcher tests)

**Files:**
- Move + update: all files under `packages/gaea/tests/` → `packages/hayba/tests/gaea/`

- [ ] **Step 1: Create destination directories**

```bash
mkdir -p packages/hayba/tests/gaea/tools
```

- [ ] **Step 2: Move non-tool test files**

```bash
git mv packages/gaea/tests/session.test.ts packages/hayba/tests/gaea/session.test.ts
git mv packages/gaea/tests/swarmhost.test.ts packages/hayba/tests/gaea/swarmhost.test.ts
git mv packages/gaea/tests/swarmhost-mutations.test.ts packages/hayba/tests/gaea/swarmhost-mutations.test.ts
git mv packages/gaea/tests/swarmhost-cook.test.ts packages/hayba/tests/gaea/swarmhost-cook.test.ts
git mv packages/gaea/tests/swarmhost-variables.test.ts packages/hayba/tests/gaea/swarmhost-variables.test.ts
git mv packages/gaea/tests/templates.test.ts packages/hayba/tests/gaea/templates.test.ts
git mv packages/gaea/tests/types.test.ts packages/hayba/tests/gaea/types.test.ts
git mv packages/gaea/tests/gaea-launcher.test.ts packages/hayba/tests/gaea/gaea-launcher.test.ts
```

- [ ] **Step 3: Move tool test files**

```bash
git mv packages/gaea/tests/tools/bake-terrain.test.ts packages/hayba/tests/gaea/tools/bake-terrain.test.ts
git mv packages/gaea/tests/tools/cook-graph.test.ts packages/hayba/tests/gaea/tools/cook-graph.test.ts
git mv packages/gaea/tests/tools/create-terrain.test.ts packages/hayba/tests/gaea/tools/create-terrain.test.ts
git mv packages/gaea/tests/tools/get-graph-state.test.ts packages/hayba/tests/gaea/tools/get-graph-state.test.ts
git mv packages/gaea/tests/tools/get-parameters.test.ts packages/hayba/tests/gaea/tools/get-parameters.test.ts
git mv packages/gaea/tests/tools/list-node-types.test.ts packages/hayba/tests/gaea/tools/list-node-types.test.ts
git mv packages/gaea/tests/tools/open-in-gaea.test.ts packages/hayba/tests/gaea/tools/open-in-gaea.test.ts
git mv packages/gaea/tests/tools/read-terrain-variables.test.ts packages/hayba/tests/gaea/tools/read-terrain-variables.test.ts
git mv packages/gaea/tests/tools/set-parameter.test.ts packages/hayba/tests/gaea/tools/set-parameter.test.ts
git mv packages/gaea/tests/tools/set-terrain-variables.test.ts packages/hayba/tests/gaea/tools/set-terrain-variables.test.ts
```

- [ ] **Step 4: Update import paths in all moved gaea test files**

For each test under `packages/hayba/tests/gaea/`, change:
- `from '../../src/` → `from '../../../src/` (one more `../` since tests are now one level deeper)
- `from '../../src/session` → `from '../../../src/gaea/session`
- `from '../../src/gaea-launcher` → `from '../../../src/gaea/gaea-launcher`
- `from '../../src/swarmhost` → `from '../../../src/gaea/swarmhost`
- `from '../../src/file-watcher` → `from '../../../src/gaea/file-watcher`
- `from '../../src/types` → `from '../../../src/gaea/types`
- `from '../../src/templates` → `from '../../../src/gaea/templates`

And for tool tests under `packages/hayba/tests/gaea/tools/`, change:
- `from '../../../src/tools/bake-terrain` → `from '../../../src/tools/hayba-bake-terrain`
- `from '../../../src/tools/cook-graph` → `from '../../../src/tools/hayba-cook-graph`
- `from '../../../src/tools/create-terrain` → `from '../../../src/tools/hayba-create-terrain`
- `from '../../../src/tools/get-graph-state` → `from '../../../src/tools/hayba-get-graph-state`
- `from '../../../src/tools/get-parameters` → `from '../../../src/tools/hayba-get-parameters`
- `from '../../../src/tools/list-node-types` → `from '../../../src/tools/hayba-list-node-types`
- `from '../../../src/tools/open-in-gaea` → `from '../../../src/tools/hayba-open-in-gaea`
- `from '../../../src/tools/read-terrain-variables` → `from '../../../src/tools/hayba-read-terrain-variables`
- `from '../../../src/tools/set-parameter` → `from '../../../src/tools/hayba-set-parameter`
- `from '../../../src/tools/set-terrain-variables` → `from '../../../src/tools/hayba-set-terrain-variables`
- `from '../../../../src/session` → `from '../../../../src/gaea/session` (tool tests are at depth 4)

Also update the tsconfig to include tests:

`packages/hayba/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "."
  },
  "include": ["src/**/*", "tests/**/*"]
}
```

Note: `rootDir` changes from `"./src"` to `"."` so TypeScript can resolve both `src/` and `tests/` from the same root.

- [ ] **Step 5: Run all tests**

```bash
cd packages/hayba && npm test
```

Expected: All previously passing pcgex tests pass. All moved gaea tests pass (minus the 2 pre-existing failures in `swarmhost-mutations.test.ts`).

- [ ] **Step 6: Commit**

```bash
cd ../..
git add packages/hayba/tests/gaea packages/hayba/tsconfig.json
git commit -m "feat: move gaea tests into packages/hayba/tests/gaea/"
```

---

## Task 7: Create the HaybaMCPToolkit UE plugin

The merged plugin is based on the `Hayba_PcgEx_MCP` source with: (a) all identifiers renamed from `PCGExBridge`/`Hayba_PcgEx_MCP` to `HaybaMCP`/`HaybaMCPToolkit`; (b) the `FHaybaGaeaLandscapeImporter` and `FHaybaMCPSettings::HeightmapOutputFolder` added from the HaybaGaea plugin; (c) a landscape import command registered in the command handler.

The non-modified files from `Hayba_PcgEx_MCP` (TCP server, Claude client, wizard widget/state, command handler implementation) are copied with class/identifier renames only.

- [ ] **Step 1: Create plugin directory structure**

```bash
mkdir -p packages/hayba/Plugins/HaybaMCPToolkit/Source/HaybaMCPToolkit/Public
mkdir -p packages/hayba/Plugins/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private
```

- [ ] **Step 2: Create HaybaMCPToolkit.uplugin**

`packages/hayba/Plugins/HaybaMCPToolkit/HaybaMCPToolkit.uplugin`:

```json
{
  "FileVersion": 3,
  "Version": 1,
  "VersionName": "1.0.0",
  "FriendlyName": "Hayba MCP Toolkit",
  "Description": "AI-powered terrain and PCG authoring for Unreal Engine 5 via MCP",
  "Category": "Editor",
  "CreatedBy": "Hayba",
  "EngineVersion": "5.7.0",
  "EnabledByDefault": true,
  "CanContainContent": false,
  "Installed": false,
  "Modules": [
    {
      "Name": "HaybaMCPToolkit",
      "Type": "Editor",
      "LoadingPhase": "PostEngineInit"
    }
  ],
  "Plugins": [
    { "Name": "PCG", "Enabled": true },
    { "Name": "Landscape", "Enabled": true }
  ]
}
```

- [ ] **Step 3: Create HaybaMCPToolkit.Build.cs**

`packages/hayba/Plugins/HaybaMCPToolkit/Source/HaybaMCPToolkit/HaybaMCPToolkit.Build.cs`:

```csharp
using System.IO;
using UnrealBuildTool;

public class HaybaMCPToolkit : ModuleRules
{
    public HaybaMCPToolkit(ReadOnlyTargetRules Target) : base(Target)
    {
        PCHUsage = PCHUsageMode.UseExplicitOrSharedPCHs;

        // FLandscapeImportHelper lives in LandscapeEditor's private headers
        var EngineDir = Path.GetFullPath(Target.RelativeEnginePath);
        PublicSystemIncludePaths.Add(
            Path.Combine(EngineDir, "Source/Editor/LandscapeEditor/Private")
        );

        PublicDependencyModuleNames.AddRange(new string[] {
            "Core", "CoreUObject", "Engine", "Slate", "SlateCore",
            "EditorStyle", "InputCore"
        });

        PrivateDependencyModuleNames.AddRange(new string[] {
            "UnrealEd", "Projects", "ToolMenus", "WorkspaceMenuStructure",
            "Sockets", "Networking", "Json", "JsonUtilities",
            "PCG", "HTTP",
            "Landscape", "LandscapeEditor", "ImageWrapper"
        });
    }
}
```

- [ ] **Step 4: Create HaybaMCPModule.h**

`packages/hayba/Plugins/HaybaMCPToolkit/Source/HaybaMCPToolkit/Public/HaybaMCPModule.h`:

```cpp
#pragma once
#include "CoreMinimal.h"
#include "Modules/ModuleManager.h"
#include "Dom/JsonObject.h"

class FHaybaMCPTcpServer;
class FHaybaMCPCommandHandler;

class FHaybaMCPModule : public IModuleInterface
{
public:
    virtual void StartupModule() override;
    virtual void ShutdownModule() override;

    bool StartTcpServer();
    void StopTcpServer();
    bool IsTcpServerRunning() const;

    bool StartMCPServer();
    void StopMCPServer();
    bool IsMCPServerRunning() const;

    FString GetDashboardURL() const;
    bool IsServerRunning() const;

    void SendTcpCommand(
        const FString& Cmd,
        const TSharedRef<FJsonObject>& Params,
        TFunction<void(bool bOk, const TSharedPtr<FJsonObject>& Response)> Callback
    );

private:
    TSharedRef<class SDockTab> OnSpawnTab(const class FSpawnTabArgs& Args);

    FString FindNodeExecutable() const;
    FString GetMCPServerPath() const;

    TSharedPtr<FHaybaMCPTcpServer> TcpServer;
    TSharedPtr<FHaybaMCPCommandHandler> CommandHandler;
    mutable FProcHandle MCPProcessHandle;
    int32 MCPPort = 0;
    int32 TcpPort = 52342;
    FString PluginBaseDir;
};
```

- [ ] **Step 5: Create HaybaMCPModule.cpp**

`packages/hayba/Plugins/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/HaybaMCPModule.cpp`:

```cpp
#include "HaybaMCPModule.h"
#include "HaybaMCPWizardWidget.h"
#include "HaybaMCPTcpServer.h"
#include "HaybaMCPCommandHandler.h"
#include "HaybaMCPSettings.h"
#include "Json.h"
#include "HAL/PlatformProcess.h"
#include "HAL/PlatformMisc.h"
#include "Misc/Paths.h"
#include "Logging/LogMacros.h"
#include "ToolMenus.h"
#include "Styling/AppStyle.h"
#include "WorkspaceMenuStructure.h"
#include "WorkspaceMenuStructureModule.h"
#include "Widgets/Docking/SDockTab.h"
#include "Interfaces/IPluginManager.h"

DEFINE_LOG_CATEGORY_STATIC(LogHaybaMCP, Log, All);

void FHaybaMCPModule::StartupModule()
{
    PluginBaseDir = IPluginManager::Get().FindPlugin(TEXT("HaybaMCPToolkit"))->GetBaseDir();
    UE_LOG(LogHaybaMCP, Log, TEXT("HaybaMCPToolkit module started. Base dir: %s"), *PluginBaseDir);

    FHaybaMCPSettings::Get().Load();

    CommandHandler = MakeShared<FHaybaMCPCommandHandler>();

    FGlobalTabmanager::Get()->RegisterNomadTabSpawner(
        TEXT("HaybaMCPToolkit"),
        FOnSpawnTab::CreateRaw(this, &FHaybaMCPModule::OnSpawnTab))
        .SetDisplayName(NSLOCTEXT("HaybaMCPToolkit", "TabTitle", "Hayba MCP Toolkit"))
        .SetTooltipText(NSLOCTEXT("HaybaMCPToolkit", "TabTooltip", "Open the Hayba MCP Toolkit panel"))
        .SetGroup(WorkspaceMenu::GetMenuStructure().GetToolsCategory())
        .SetIcon(FSlateIcon(FAppStyle::GetAppStyleSetName(), "ClassIcon.UserDefinedStruct"));

    IConsoleManager::Get().RegisterConsoleCommand(
        TEXT("Hayba.MCP.Open"),
        TEXT("Opens the Hayba MCP Toolkit panel"),
        FConsoleCommandDelegate::CreateLambda([]()
        {
            FGlobalTabmanager::Get()->TryInvokeTab(FName(TEXT("HaybaMCPToolkit")));
        }),
        ECVF_Default
    );
}

void FHaybaMCPModule::ShutdownModule()
{
    FGlobalTabmanager::Get()->UnregisterNomadTabSpawner(TEXT("HaybaMCPToolkit"));
    StopTcpServer();
    StopMCPServer();
    UE_LOG(LogHaybaMCP, Log, TEXT("HaybaMCPToolkit module shut down."));
}

bool FHaybaMCPModule::StartTcpServer()
{
    if (TcpServer.IsValid() && TcpServer->IsRunning())
    {
        UE_LOG(LogHaybaMCP, Warning, TEXT("TCP server already running on port %d"), TcpPort);
        return false;
    }
    TcpServer = MakeShared<FHaybaMCPTcpServer>(TcpPort);
    if (!TcpServer->Start())
    {
        UE_LOG(LogHaybaMCP, Error, TEXT("Failed to start TCP server on port %d"), TcpPort);
        TcpServer.Reset();
        return false;
    }
    UE_LOG(LogHaybaMCP, Log, TEXT("TCP server started on port %d"), TcpPort);
    return true;
}

void FHaybaMCPModule::StopTcpServer()
{
    if (TcpServer.IsValid())
    {
        TcpServer->Shutdown();
        TcpServer.Reset();
        UE_LOG(LogHaybaMCP, Log, TEXT("TCP server stopped."));
    }
}

bool FHaybaMCPModule::IsTcpServerRunning() const
{
    return TcpServer.IsValid() && TcpServer->IsRunning();
}

bool FHaybaMCPModule::StartMCPServer()
{
    if (IsMCPServerRunning())
    {
        UE_LOG(LogHaybaMCP, Warning, TEXT("MCP server is already running."));
        return false;
    }
    if (!IsTcpServerRunning())
    {
        if (!StartTcpServer()) return false;
    }

    FString NodePath = FindNodeExecutable();
    if (NodePath.IsEmpty())
    {
        UE_LOG(LogHaybaMCP, Error, TEXT("Node.js not found."));
        return false;
    }

    FString ServerPath = GetMCPServerPath();
    if (!FPaths::FileExists(ServerPath))
    {
        UE_LOG(LogHaybaMCP, Error, TEXT("MCP server not found at: %s"), *ServerPath);
        return false;
    }

    FPlatformMisc::SetEnvironmentVar(TEXT("DASHBOARD_PORT"), TEXT("52341"));
    FPlatformMisc::SetEnvironmentVar(TEXT("UE_TCP_PORT"), *FString::FromInt(TcpPort));

    FString Params = FString::Printf(TEXT("\"%s\""), *ServerPath);
    uint32 ProcessID = 0;
    MCPProcessHandle = FPlatformProcess::CreateProc(*NodePath, *Params, false, true, true, &ProcessID, 0, nullptr, nullptr, nullptr);

    if (!MCPProcessHandle.IsValid())
    {
        UE_LOG(LogHaybaMCP, Error, TEXT("Failed to start MCP server process."));
        return false;
    }

    MCPPort = 52341;
    UE_LOG(LogHaybaMCP, Log, TEXT("MCP server started. Dashboard: http://127.0.0.1:%d"), MCPPort);
    return true;
}

void FHaybaMCPModule::StopMCPServer()
{
    if (MCPProcessHandle.IsValid())
    {
        FPlatformProcess::TerminateProc(MCPProcessHandle, true);
        FPlatformProcess::CloseProc(MCPProcessHandle);
        MCPProcessHandle = FProcHandle();
        MCPPort = 0;
        UE_LOG(LogHaybaMCP, Log, TEXT("MCP server stopped."));
    }
}

bool FHaybaMCPModule::IsMCPServerRunning() const
{
    return MCPProcessHandle.IsValid() && FPlatformProcess::IsProcRunning(MCPProcessHandle);
}

FString FHaybaMCPModule::GetDashboardURL() const
{
    if (MCPPort > 0) return FString::Printf(TEXT("http://127.0.0.1:%d"), MCPPort);
    return TEXT("");
}

bool FHaybaMCPModule::IsServerRunning() const
{
    return IsTcpServerRunning() && IsMCPServerRunning();
}

void FHaybaMCPModule::SendTcpCommand(
    const FString& Cmd,
    const TSharedRef<FJsonObject>& Params,
    TFunction<void(bool bOk, const TSharedPtr<FJsonObject>& Response)> Callback)
{
    if (!CommandHandler.IsValid()) { Callback(false, nullptr); return; }

    FString RequestId = FString::Printf(TEXT("module_%lld"), FPlatformTime::Cycles64());
    TSharedRef<FJsonObject> Command = MakeShareable(new FJsonObject());
    Command->SetStringField(TEXT("cmd"), Cmd);
    Command->SetStringField(TEXT("id"), RequestId);
    Command->SetObjectField(TEXT("params"), Params);

    FString CommandStr;
    TSharedRef<TJsonWriter<TCHAR, TCondensedJsonPrintPolicy<TCHAR>>> Writer =
        TJsonWriterFactory<TCHAR, TCondensedJsonPrintPolicy<TCHAR>>::Create(&CommandStr);
    FJsonSerializer::Serialize(Command, Writer);

    FString ResponseStr = CommandHandler->ProcessCommand(CommandStr);

    TSharedPtr<FJsonObject> ResponseObj;
    TSharedRef<TJsonReader<>> Reader = TJsonReaderFactory<>::Create(ResponseStr);
    if (FJsonSerializer::Deserialize(Reader, ResponseObj) && ResponseObj.IsValid())
    {
        bool bOk = false;
        ResponseObj->TryGetBoolField(TEXT("ok"), bOk);
        TSharedPtr<FJsonObject> Data = ResponseObj->GetObjectField(TEXT("data"));
        Callback(bOk, Data);
    }
    else { Callback(false, nullptr); }
}

FString FHaybaMCPModule::FindNodeExecutable() const
{
    FString BundledNode = FPaths::Combine(PluginBaseDir, TEXT("ThirdParty"), TEXT("node"), TEXT("node.exe"));
    if (FPaths::FileExists(BundledNode)) return BundledNode;
    TArray<FString> Candidates = {
        TEXT("C:/Program Files/nodejs/node.exe"),
        TEXT("C:/Program Files (x86)/nodejs/node.exe")
    };
    for (const FString& C : Candidates) { if (FPaths::FileExists(C)) return C; }
    return TEXT("");
}

FString FHaybaMCPModule::GetMCPServerPath() const
{
    return FPaths::Combine(PluginBaseDir, TEXT("ThirdParty"), TEXT("mcp_server"), TEXT("dist"), TEXT("index.js"));
}

TSharedRef<SDockTab> FHaybaMCPModule::OnSpawnTab(const FSpawnTabArgs& Args)
{
    return SNew(SDockTab)
        .TabRole(ETabRole::NomadTab)
        [
            SNew(SHaybaMCPWizardWidget, this)
        ];
}

IMPLEMENT_MODULE(FHaybaMCPModule, HaybaMCPToolkit)
```

- [ ] **Step 6: Create HaybaMCPSettings.h**

`packages/hayba/Plugins/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/HaybaMCPSettings.h`:

```cpp
#pragma once
#include "CoreMinimal.h"

UENUM()
enum class EHaybaMCPOperationMode : uint8
{
    Integrated,
    ApiKey
};

class FHaybaMCPSettings
{
public:
    static FHaybaMCPSettings& Get();

    // Claude API settings
    FString ApiKey;
    FString BaseURL = TEXT("https://api.anthropic.com/v1/messages");
    FString Model = TEXT("claude-opus-4-6-20251101");

    // PCGEx output
    FString OutputPath = TEXT("/Game/PCGExBridge/Generated");

    // Gaea heightmap output folder (from HaybaGaea)
    FString HeightmapOutputFolder;

    bool bHasSeenWizard = false;
    EHaybaMCPOperationMode OperationMode = EHaybaMCPOperationMode::Integrated;

    static FString GetSharedApiKey();
    static void SetSharedApiKey(const FString& Key);

    void Load();
    void Save() const;

    bool HasApiKey() const { return !GetSharedApiKey().IsEmpty(); }
    bool IsAnthropicEndpoint() const { return BaseURL.Contains(TEXT("anthropic.com")); }

private:
    static constexpr const TCHAR* Section       = TEXT("HaybaMCPToolkit");
    static constexpr const TCHAR* SharedSection = TEXT("HaybaShared");
    static constexpr const TCHAR* KeyApiKey     = TEXT("ApiKey");
    static constexpr const TCHAR* KeyBaseURL    = TEXT("BaseURL");
    static constexpr const TCHAR* KeyModel      = TEXT("Model");
    static constexpr const TCHAR* KeyOutputPath = TEXT("OutputPath");
};
```

- [ ] **Step 7: Create HaybaMCPSettings.cpp**

`packages/hayba/Plugins/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/HaybaMCPSettings.cpp`:

```cpp
#include "HaybaMCPSettings.h"
#include "Misc/ConfigCacheIni.h"
#include "Misc/Paths.h"

FHaybaMCPSettings& FHaybaMCPSettings::Get()
{
    static FHaybaMCPSettings Instance;
    return Instance;
}

FString FHaybaMCPSettings::GetSharedApiKey()
{
    FString Key;
    GConfig->GetString(SharedSection, KeyApiKey, Key, GEditorPerProjectIni);
    return Key;
}

void FHaybaMCPSettings::SetSharedApiKey(const FString& Key)
{
    GConfig->SetString(SharedSection, KeyApiKey, *Key, GEditorPerProjectIni);
    GConfig->Flush(false, GEditorPerProjectIni);
}

void FHaybaMCPSettings::Load()
{
    GConfig->GetString(Section, KeyApiKey,     ApiKey,      GEditorPerProjectIni);
    GConfig->GetString(Section, KeyBaseURL,    BaseURL,     GEditorPerProjectIni);
    GConfig->GetString(Section, KeyModel,      Model,       GEditorPerProjectIni);
    GConfig->GetString(Section, KeyOutputPath, OutputPath,  GEditorPerProjectIni);
    GConfig->GetString(Section, TEXT("HeightmapOutputFolder"), HeightmapOutputFolder, GEditorPerProjectIni);
    GConfig->GetBool(Section, TEXT("bHasSeenWizard"), bHasSeenWizard, GEditorPerProjectIni);

    FString ModeStr;
    GConfig->GetString(Section, TEXT("OperationMode"), ModeStr, GEditorPerProjectIni);
    OperationMode = (ModeStr == TEXT("ApiKey")) ? EHaybaMCPOperationMode::ApiKey : EHaybaMCPOperationMode::Integrated;

    if (BaseURL.IsEmpty())             BaseURL    = TEXT("https://api.anthropic.com/v1/messages");
    if (Model.IsEmpty())               Model      = TEXT("claude-opus-4-6-20251101");
    if (OutputPath.IsEmpty())          OutputPath = TEXT("/Game/PCGExBridge/Generated");
    if (HeightmapOutputFolder.IsEmpty())
        HeightmapOutputFolder = FPaths::ProjectSavedDir() / TEXT("HaybaGaea");
}

void FHaybaMCPSettings::Save() const
{
    GConfig->SetString(Section, KeyApiKey,     *ApiKey,      GEditorPerProjectIni);
    GConfig->SetString(Section, KeyBaseURL,    *BaseURL,     GEditorPerProjectIni);
    GConfig->SetString(Section, KeyModel,      *Model,       GEditorPerProjectIni);
    GConfig->SetString(Section, KeyOutputPath, *OutputPath,  GEditorPerProjectIni);
    GConfig->SetString(Section, TEXT("HeightmapOutputFolder"), *HeightmapOutputFolder, GEditorPerProjectIni);
    GConfig->SetBool(Section, TEXT("bHasSeenWizard"), bHasSeenWizard, GEditorPerProjectIni);
    GConfig->SetString(Section, TEXT("OperationMode"),
        OperationMode == EHaybaMCPOperationMode::ApiKey ? TEXT("ApiKey") : TEXT("Integrated"),
        GEditorPerProjectIni);
    GConfig->Flush(false, GEditorPerProjectIni);
}
```

- [ ] **Step 8: Copy landscape importer files**

Copy these two files verbatim, replacing the log category name only:

`packages/hayba/Plugins/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/HaybaMCPLandscapeImporter.h`:

```cpp
#pragma once
#include "CoreMinimal.h"

class FHaybaMCPLandscapeImporter
{
public:
    /**
     * Create an ALandscape actor in the current level from a heightmap PNG/R16 file.
     * Must be called on the game thread.
     * @return true if the landscape actor was created successfully.
     */
    static bool ImportHeightmap(const FString& HeightmapPath);
};
```

`packages/hayba/Plugins/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/HaybaMCPLandscapeImporter.cpp`:

```cpp
#include "HaybaMCPLandscapeImporter.h"
#include "LandscapeProxy.h"
#include "Landscape.h"
#include "LandscapeImportHelper.h"
#include "Editor.h"
#include "Engine/World.h"
#include "HAL/PlatformFileManager.h"
#include "Logging/LogMacros.h"
#include "Misc/Paths.h"

DEFINE_LOG_CATEGORY_STATIC(LogHaybaMCPImporter, Log, All);

bool FHaybaMCPLandscapeImporter::ImportHeightmap(const FString& HeightmapPath)
{
    if (!FPlatformFileManager::Get().GetPlatformFile().FileExists(*HeightmapPath))
    {
        UE_LOG(LogHaybaMCPImporter, Error, TEXT("Heightmap not found: %s"), *HeightmapPath);
        return false;
    }

    UWorld* World = GEditor ? GEditor->GetEditorWorldContext().World() : nullptr;
    if (!World)
    {
        UE_LOG(LogHaybaMCPImporter, Error, TEXT("No editor world available"));
        return false;
    }

    FLandscapeImportDescriptor OutDescriptor;
    FText OutMessage;
    ELandscapeImportResult ImportResult = FLandscapeImportHelper::GetHeightmapImportDescriptor(
        HeightmapPath, /*bSingleFile=*/true, /*bFlipYAxis=*/false, OutDescriptor, OutMessage);

    if (ImportResult == ELandscapeImportResult::Error)
    {
        UE_LOG(LogHaybaMCPImporter, Error, TEXT("Failed to read heightmap descriptor: %s"), *OutMessage.ToString());
        return false;
    }

    if (OutDescriptor.ImportResolutions.Num() == 0)
    {
        UE_LOG(LogHaybaMCPImporter, Error, TEXT("Heightmap has no valid resolutions: %s"), *HeightmapPath);
        return false;
    }

    const int32 DescriptorIndex = 0;
    int32 OutQuadsPerSection = 0, OutSectionsPerComponent = 0;
    FIntPoint OutComponentCount;
    FLandscapeImportHelper::ChooseBestComponentSizeForImport(
        OutDescriptor.ImportResolutions[DescriptorIndex].Width,
        OutDescriptor.ImportResolutions[DescriptorIndex].Height,
        OutQuadsPerSection, OutSectionsPerComponent, OutComponentCount);

    TArray<uint16> ImportData;
    ImportResult = FLandscapeImportHelper::GetHeightmapImportData(
        OutDescriptor, DescriptorIndex, ImportData, OutMessage);

    if (ImportResult == ELandscapeImportResult::Error)
    {
        UE_LOG(LogHaybaMCPImporter, Error, TEXT("Failed to load heightmap data: %s"), *OutMessage.ToString());
        return false;
    }

    const int32 QuadsPerComponent = OutSectionsPerComponent * OutQuadsPerSection;
    const int32 SizeX = OutComponentCount.X * QuadsPerComponent + 1;
    const int32 SizeY = OutComponentCount.Y * QuadsPerComponent + 1;

    TArray<uint16> FinalHeightData;
    FLandscapeImportHelper::TransformHeightmapImportData(
        ImportData, FinalHeightData,
        OutDescriptor.ImportResolutions[DescriptorIndex],
        FLandscapeImportResolution(SizeX, SizeY),
        ELandscapeImportTransformType::ExpandCentered);

    FGuid LayerGuid = FGuid::NewGuid();
    TMap<FGuid, TArray<uint16>> HeightmapDataPerLayers;
    HeightmapDataPerLayers.Add(LayerGuid, FinalHeightData);
    TMap<FGuid, TArray<FLandscapeImportLayerInfo>> MaterialLayerDataPerLayers;

    FTransform LandscapeTransform;
    LandscapeTransform.SetLocation(FVector(0.0, 0.0, 0.0));
    LandscapeTransform.SetScale3D(FVector(100.0, 100.0, 100.0));

    ALandscape* Landscape = World->SpawnActor<ALandscape>(ALandscape::StaticClass(), LandscapeTransform);
    if (!Landscape)
    {
        UE_LOG(LogHaybaMCPImporter, Error, TEXT("Failed to spawn ALandscape actor"));
        return false;
    }

    Landscape->Import(
        LayerGuid, 0, 0, SizeX - 1, SizeY - 1,
        OutSectionsPerComponent, OutQuadsPerSection,
        HeightmapDataPerLayers, *HeightmapPath,
        MaterialLayerDataPerLayers,
        ELandscapeImportAlphamapType::Additive,
        TArrayView<const FLandscapeLayer>()
    );

    Landscape->SetActorLabel(TEXT("Hayba_Terrain"));
    UE_LOG(LogHaybaMCPImporter, Log, TEXT("Landscape created: %dx%d from %s"), SizeX, SizeY, *HeightmapPath);
    return true;
}
```

- [ ] **Step 9: Copy and rename remaining PCGEx plugin files**

Copy the following files from `packages/gaea/Plugins/Hayba_PcgEx_MCP/Hayba_PcgEx_MCP/` to `packages/hayba/Plugins/HaybaMCPToolkit/Source/HaybaMCPToolkit/`, renaming class prefixes `PCGExBridge` → `HaybaMCP` and `FPCGEx` → `FHaybaMCP` throughout each file's content:

| Source file | Destination file | Rename |
|---|---|---|
| `Private/PCGExBridgeTcpServer.h` | `Private/HaybaMCPTcpServer.h` | `FPCGExBridgeTcpServer` → `FHaybaMCPTcpServer` |
| `Private/PCGExBridgeTcpServer.cpp` | `Private/HaybaMCPTcpServer.cpp` | same, include updated |
| `Public/PCGExBridgeCommandHandler.h` | `Public/HaybaMCPCommandHandler.h` | `FPCGExBridgeCommandHandler` → `FHaybaMCPCommandHandler` |
| `Private/PCGExBridgeCommandHandler.cpp` | `Private/HaybaMCPCommandHandler.cpp` | same, include updated, also rename `Cmd_WizardChat` |
| `Private/PCGExClaudeClient.h` | `Private/HaybaMCPClaudeClient.h` | `FPCGExClaudeClient` → `FHaybaMCPClaudeClient` |
| `Private/PCGExClaudeClient.cpp` | `Private/HaybaMCPClaudeClient.cpp` | same |
| `Private/PCGExWizardState.h` | `Private/HaybaMCPWizardState.h` | `FPCGExWizardSession` → `FHaybaMCPWizardSession`, `FPCGExChatMessage` → `FHaybaMCPChatMessage` |
| `Private/PCGExWizardPrompt.h` | `Private/HaybaMCPWizardPrompt.h` | rename enums/structs with `HaybaMCP` prefix |
| `Private/PCGExWizardWidget.h` | `Private/HaybaMCPWizardWidget.h` | `SPCGExWizardWidget` → `SHaybaMCPWizardWidget`, `EPCGExScreen` → `EHaybaMCPScreen`, `EPCGExOperationMode` → `EHaybaMCPOperationMode` |
| `Private/PCGExWizardWidget.cpp` | `Private/HaybaMCPWizardWidget.cpp` | same renames, all includes updated |

For each file: open source, find-replace class/type prefixes as listed, update `#include` lines to use new filenames.

```bash
# Copy all files first, then do the renames in each
cp packages/gaea/Plugins/Hayba_PcgEx_MCP/Hayba_PcgEx_MCP/Private/PCGExBridgeTcpServer.h \
   packages/hayba/Plugins/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/HaybaMCPTcpServer.h

cp packages/gaea/Plugins/Hayba_PcgEx_MCP/Hayba_PcgEx_MCP/Private/PCGExBridgeTcpServer.cpp \
   packages/hayba/Plugins/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/HaybaMCPTcpServer.cpp

cp packages/gaea/Plugins/Hayba_PcgEx_MCP/Hayba_PcgEx_MCP/Public/PCGExBridgeCommandHandler.h \
   packages/hayba/Plugins/HaybaMCPToolkit/Source/HaybaMCPToolkit/Public/HaybaMCPCommandHandler.h

cp packages/gaea/Plugins/Hayba_PcgEx_MCP/Hayba_PcgEx_MCP/Private/PCGExBridgeCommandHandler.cpp \
   packages/hayba/Plugins/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/HaybaMCPCommandHandler.cpp

cp packages/gaea/Plugins/Hayba_PcgEx_MCP/Hayba_PcgEx_MCP/Private/PCGExClaudeClient.h \
   packages/hayba/Plugins/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/HaybaMCPClaudeClient.h

cp packages/gaea/Plugins/Hayba_PcgEx_MCP/Hayba_PcgEx_MCP/Private/PCGExClaudeClient.cpp \
   packages/hayba/Plugins/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/HaybaMCPClaudeClient.cpp

cp packages/gaea/Plugins/Hayba_PcgEx_MCP/Hayba_PcgEx_MCP/Private/PCGExWizardState.h \
   packages/hayba/Plugins/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/HaybaMCPWizardState.h

cp packages/gaea/Plugins/Hayba_PcgEx_MCP/Hayba_PcgEx_MCP/Private/PCGExWizardPrompt.h \
   packages/hayba/Plugins/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/HaybaMCPWizardPrompt.h

cp packages/gaea/Plugins/Hayba_PcgEx_MCP/Hayba_PcgEx_MCP/Private/PCGExWizardWidget.h \
   packages/hayba/Plugins/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/HaybaMCPWizardWidget.h

cp packages/gaea/Plugins/Hayba_PcgEx_MCP/Hayba_PcgEx_MCP/Private/PCGExWizardWidget.cpp \
   packages/hayba/Plugins/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/HaybaMCPWizardWidget.cpp
```

Then in each copied file, replace all occurrences of:
- `PCGExBridge` → `HaybaMCP`
- `FPCGEx` → `FHaybaMCP`
- `SPCGEx` → `SHaybaMCP`
- `EPCGEx` → `EHaybaMCP`
- `Hayba_PcgEx_MCP` → `HaybaMCPToolkit` (in include paths and plugin name references)
- `#include "PCGExBridgeSettings.h"` → `#include "HaybaMCPSettings.h"`
- `FPCGExBridgeSettings` → `FHaybaMCPSettings`
- `EPCGExOperationMode` → `EHaybaMCPOperationMode`

- [ ] **Step 10: Commit UE plugin**

```bash
git add packages/hayba/Plugins/HaybaMCPToolkit
git commit -m "feat: add HaybaMCPToolkit UE plugin (merged from HaybaGaea + Hayba_PcgEx_MCP)"
```

---

## Task 8: Update README with installation instructions

**Files:**
- Modify: `README.md` (root)

- [ ] **Step 1: Read current README**

Read `README.md` to find the existing installation section (or top of file if none exists).

- [ ] **Step 2: Add/replace installation section**

Add or replace the installation section with:

```markdown
## Installation

### 1. UE Plugin

Copy `packages/hayba/Plugins/HaybaMCPToolkit/` into your UE project's `Plugins/` folder:

```
YourProject/
  Plugins/
    HaybaMCPToolkit/   ← copy here
```

Right-click your `.uproject` file → **Generate Visual Studio project files**, then recompile. Enable in **Edit > Plugins > Hayba MCP Toolkit**.

### 2. MCP Server

Add to `~/.claude/claude_desktop_config.json` (create it if it doesn't exist):

```json
{
  "mcpServers": {
    "hayba-mcp": {
      "command": "npx",
      "args": ["-y", "@hayba/mcp"]
    }
  }
}
```

Restart Claude Desktop. You should see **hayba-mcp** connected in the MCP panel.

### 3. First launch

Open UE, go to **Tools > Hayba MCP Toolkit**, and follow the setup wizard to configure your API key and output paths.
```

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: add Hayba MCP Toolkit installation instructions to README"
```

---

## Task 9: Delete packages/gaea and clean up

- [ ] **Step 1: Verify nothing in packages/hayba still imports from packages/gaea**

```bash
grep -r "packages/gaea" packages/hayba/src packages/hayba/tests 2>/dev/null
```

Expected: No output.

- [ ] **Step 2: Verify the old Hayba_PcgEx_MCP plugin in packages/hayba is not referenced**

The `packages/hayba/Plugins/Hayba_PcgEx_MCP/` directory (the original pcgex plugin) should be replaced by `HaybaMCPToolkit`. If it still exists:

```bash
git rm -r packages/hayba/Plugins/Hayba_PcgEx_MCP
```

- [ ] **Step 3: Delete packages/gaea**

```bash
git rm -r packages/gaea
```

- [ ] **Step 4: Run final test suite**

```bash
cd packages/hayba && npm run build && npm test
```

Expected: TypeScript build clean. All pcgex tests pass. All gaea tests pass (minus the 2 pre-existing failures in `swarmhost-mutations.test.ts`).

- [ ] **Step 5: Final commit**

```bash
cd ../..
git add -A
git commit -m "feat: complete Hayba MCP Toolkit unification — packages/gaea removed"
```

---

## Self-Review

**Spec coverage check:**

| Spec requirement | Covered by |
|---|---|
| `packages/pcgex` renamed to `packages/hayba` | Task 1 |
| All gaea TS domain code moved to `src/gaea/` | Task 2 |
| All gaea tools ported to `src/tools/hayba-*` with updated imports | Task 3 |
| Centralized `registerTools(server, session)` | Task 4 |
| All tools prefixed `hayba_` | Task 4 |
| Unified `src/index.ts` with single server | Task 5 |
| Gaea tests moved and import paths fixed | Task 6 |
| Single `HaybaMCPToolkit` UE plugin | Task 7 |
| Merged settings (API key + HeightmapOutputFolder) | Task 7 steps 6–7 |
| Landscape importer in unified plugin | Task 7 step 8 |
| One UE Tools menu entry | Task 7 step 5 |
| GitHub README install instructions | Task 8 |
| `packages/gaea` deleted | Task 9 |
| `@hayba/mcp` package name, `hayba-mcp` binary | Task 1 step 3 |

**Placeholder scan:** No TBDs or TODOs in task steps. ✓

**Type consistency:**
- `ToolHandler` and `ToolResult` types are defined once in `hayba-bake-terrain.ts` and re-exported. All other gaea tool files import them from `./hayba-bake-terrain.js`. ✓
- `registerTools(server: McpServer, session: SessionManager)` — signature is consistent in `tools/index.ts` and `src/index.ts`. ✓
- `FHaybaMCPSettings` used in `HaybaMCPModule.cpp` and wizard widget — consistent. ✓
- `FHaybaMCPLandscapeImporter` defined in `HaybaMCPLandscapeImporter.h` — consistent. ✓
