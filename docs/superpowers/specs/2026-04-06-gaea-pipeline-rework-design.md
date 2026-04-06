# Gaea Pipeline Rework — Design Spec
**Date:** 2026-04-06
**Status:** Approved
**Scope:** Fix broken bake pipeline, add variable system integration, improve AI workflow

---

## Problem

The Gaea MCP integration can construct and modify `.terrain` files (node graph R/W works), but:

- `Gaea.BuildManager.exe` path detection is broken — baking always fails
- No fallback path detection for Gaea 2.0 / 2.1 / 2.2 install variants
- Variables system in Gaea (the mechanism for parameterized bakes) is not exposed to Claude at all
- Templates hardcode parameter values instead of declaring variable contracts
- No way to (re)open a modified `.terrain` file in the Gaea editor without manual steps
- The `cook()` and `export()` methods in `SwarmHostClient` use `Gaea.BuildManager.exe` — the wrong binary for Gaea 2.0 (should be `Gaea.Swarm.exe`)

---

## Solution Overview

Four layers:

1. **Fix the bake pipeline** — correct binary, auto-detect paths, proper CLI invocation
2. **Variable system integration** — read/write/bake with Gaea variables via `-v` flags
3. **Editor reload trigger** — `open_in_gaea` eliminates manual file-open step
4. **Template variable contracts** — templates declare named variables; Claude sets them at bake time

---

## Layer 1: Fix the Bake Pipeline

### Binary correction

Replace `Gaea.BuildManager.exe` with `Gaea.Swarm.exe` as the build binary. `Gaea.BuildManager.exe` is not the correct CLI tool for Gaea 2.0.

### Auto-detection candidates

Add to `gaea-launcher.ts` alongside the existing `GAEA_CANDIDATE_PATHS`:

```ts
export const GAEA_SWARM_CANDIDATE_PATHS = [
  path.join(LOCALAPPDATA, "Programs", "Gaea 2.0", "Gaea.Swarm.exe"),
  path.join(LOCALAPPDATA, "Programs", "Gaea 2.1", "Gaea.Swarm.exe"),
  path.join(LOCALAPPDATA, "Programs", "Gaea 2.2", "Gaea.Swarm.exe"),
  path.join(LOCALAPPDATA, "Programs", "Gaea 2.3", "Gaea.Swarm.exe"),
  path.join(LOCALAPPDATA, "Programs", "Gaea", "Gaea.Swarm.exe"),
  "C:\\Program Files\\QuadSpinner\\Gaea 2\\Gaea.Swarm.exe",
];

export function detectSwarmPath(): string | null {
  return GAEA_SWARM_CANDIDATE_PATHS.find(p => existsSync(p)) ?? null;
}
```

### CLI invocation

```
Gaea.Swarm.exe -filename "path\to\file.terrain" -seed 42 -v key1=val1 -v key2=val2
```

- `-v` flags must always come last (Gaea requirement)
- Variables file alternative: write a temp JSON to disk, pass via `-vars tempfile.json`
- `-ignorecache` flag added when Claude wants a fresh bake

### Config changes

`SwarmHostConfig` gains an optional `swarmExePath` field. At startup, if `swarmExePath` is not set, auto-detect. If auto-detect fails, log a clear error with install path instructions.

### `cook()` rewrite

Current `cook()` uses `spawnSync` with `Gaea.BuildManager.exe`. Rewrite to:
1. Resolve `swarmExePath`
2. Build args array: `["-filename", terrainPath, "-ignorecache", ...variableArgs]`
3. Use `spawnSync` with `{ encoding: "utf8", timeout: 300_000 }` (5 min timeout)
4. Parse stdout/stderr to detect success vs. failure
5. Return `{ ok: boolean, outputDir: string, error?: string }`

---

## Layer 2: Variable System Integration

### What Gaea variables are

Variables are declared inside the `Automation.Variables` section of a `.terrain` file and bound to node properties inside Gaea's UI. Once bound, Claude can override their values at bake time via CLI `-v key=value` without touching the graph structure.

### Reading variables from a terrain file

New function in `swarmhost.ts`:

```ts
function readTerrainVariables(terrainPath: string): Record<string, {
  type: "Float" | "Int" | "Bool" | "Choice" | "Color" | "Range" | "String";
  value: unknown;
  min?: number;
  max?: number;
  choices?: string[];
}> { ... }
```

Reads from `Assets[0].Automation.Variables` in the `.terrain` JSON.

### Writing variables into a terrain file

```ts
function setTerrainVariables(
  terrainPath: string,
  vars: Record<string, unknown>
): void { ... }
```

Merges provided values into `Assets[0].Automation.Variables`, validates types, writes back using the existing `serializeGaea()` serializer.

### New MCP tools

**`read_terrain_variables`**
- Params: `path: string`
- Returns: all declared variables with their types, current values, and ranges
- Use: Claude reads this to discover what's parameterizable before baking

**`set_terrain_variables`**
- Params: `path: string`, `variables: Record<string, unknown>`
- Persists variable values into the `.terrain` file
- Returns: updated variable list

**`bake_terrain`**
- Params: `path: string`, `variables?: Record<string, unknown>`, `ignorecache?: boolean`
- Calls `Gaea.Swarm.exe` with `-v key=value` per variable override
- Returns: `{ ok, outputFiles: { heightmap?, normalmap?, splatmap? }, error? }`
- Does NOT modify the `.terrain` file — variables are passed as CLI flags only, not persisted
- If `variables` are passed AND `set_terrain_variables` should persist them, Claude calls both

---

## Layer 3: Editor Reload Trigger

### Problem

Gaea does not auto-reload `.terrain` files when they change on disk. After Claude writes changes, the user must manually File → Open the file again.

### Solution

New MCP tool: **`open_in_gaea`**
- Params: `path: string`
- Calls `Gaea.exe path` via `spawn()` (detached, no wait)
- If Gaea is not running, this launches it with the file open
- If Gaea is already running, this typically opens the file in the existing instance (OS-dependent)
- Returns: `{ launched: true, path }`

**Placement in workflow:** Claude calls `open_in_gaea` after any `.terrain` write so the user sees the updated graph immediately. Claude does not call `open_in_gaea` before baking (baking is headless).

### Future SDK slot

When QuadSpinner ships "Building a Bridge with CLI" (currently documented as "Coming soon"), a `GaeaLiveClient` class will be added that replaces the file-write + `open_in_gaea` pattern with a live connection. The MCP tool interface stays identical — only the underlying transport changes.

---

## Layer 4: Template Variable Contracts

### Current state

Templates (`desert`, `mountains`, `tropical`, `volcanic`) hardcode all parameter values as literals. Claude can only override them via `template_overrides` which bypass type checking.

### New contract format

Each template module exports a `variables` object alongside `meta` and `build`:

```ts
export const variables: TemplateVariableContract = {
  Seed:            { type: "Int",   default: 0,    min: 0,    max: 9999, description: "Random seed" },
  Scale:           { type: "Float", default: 1.5,  min: 0.5,  max: 4.0,  description: "Overall terrain scale" },
  ErosionStrength: { type: "Float", default: 0.7,  min: 0.0,  max: 1.0,  description: "Erosion intensity" },
  SnowLine:        { type: "Float", default: 0.65, min: 0.2,  max: 0.95, description: "Altitude above which snow appears" },
  OutputPath:      { type: "String", default: "",              description: "Output directory for baked files" },
};
```

### `TemplateVariableContract` type

```ts
export type TemplateVariableContract = Record<string, {
  type: "Int" | "Float" | "Bool" | "String" | "Choice";
  default: unknown;
  min?: number;
  max?: number;
  choices?: string[];
  description: string;
}>;
```

Added to `types.ts`. `TemplateMeta` gains an optional `variables` field pointing to the contract.

### Build function change

`build(overrides)` injects variables into the `.terrain` JSON's `Automation.Variables` section (not just node params), so Gaea's variable system is populated from the start. Claude can then bake with `-v` overrides without any manual binding step for template-based terrains.

### Workflow

```
Claude: create_terrain(template="mountains", variables={ Seed: 42, SnowLine: 0.8 })
  → writes .terrain with Automation.Variables populated
  → calls bake_terrain(path, { Seed: 42, SnowLine: 0.8 })
  → returns heightmap path
```

---

## New Files

| File | Change |
|------|--------|
| `src/gaea-launcher.ts` | Add `GAEA_SWARM_CANDIDATE_PATHS`, `detectSwarmPath()` |
| `src/swarmhost.ts` | Rewrite `cook()`, add `readTerrainVariables()`, `setTerrainVariables()` |
| `src/types.ts` | Add `TemplateVariableContract`, update `TemplateMeta` |
| `src/tools/read-terrain-variables.ts` | New MCP tool |
| `src/tools/set-terrain-variables.ts` | New MCP tool |
| `src/tools/bake-terrain.ts` | New MCP tool (replaces broken cook path in create_terrain) |
| `src/tools/open-in-gaea.ts` | New MCP tool |
| `src/tools/index.ts` | Register 4 new tools |
| `src/templates/mountains.ts` | Add `variables` contract |
| `src/templates/desert.ts` | Add `variables` contract |
| `src/templates/tropical.ts` | Add `variables` contract |
| `src/templates/volcanic.ts` | Add `variables` contract |

---

## What This Does Not Cover

The following are separate specs:

- **UE Landscape Import** — importing Gaea heightmap into UE as a Landscape actor via TCP bridge
- **Gaea + PCGEx Joint Workflow** — single-prompt terrain + foliage orchestration tool
- **UE Material Creation** — procedural material authoring via MCP
- **TOR SDK custom nodes** — when QuadSpinner releases the C# SDK
- **Macros** — when Gaea 2.3 ships
