# Gaea Pipeline Rework Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the broken Gaea bake pipeline, expose the variable system to Claude, add an editor reload trigger, and upgrade templates with variable contracts.

**Architecture:** Four layers built on the existing `SwarmHostClient` in `swarmhost.ts`: (1) replace `Gaea.BuildManager.exe` with `Gaea.Swarm.exe` using proper CLI flags, (2) read/write Gaea Variables from `.terrain` JSON and pass them as `-v key=val` at bake time, (3) add `open_in_gaea` to relaunch the file in the Gaea editor after writes, (4) upgrade the 4 template modules to declare variable contracts so Claude knows what's parameterizable.

**Tech Stack:** TypeScript, Node.js, Vitest, `spawnSync` (Node built-in), existing `serializeGaea()` JSON serializer

---

## File Map

| File | Change |
|------|--------|
| `packages/gaea/src/types.ts` | Add `TemplateVariableSpec`, `TemplateVariableContract`; update `TemplateMeta` |
| `packages/gaea/src/gaea-launcher.ts` | Add `GAEA_SWARM_CANDIDATE_PATHS`, `detectSwarmPath()` |
| `packages/gaea/src/swarmhost.ts` | Rewrite `cook()`, add `readTerrainVariables()`, `setTerrainVariables()`, `bakeWithVariables()` |
| `packages/gaea/src/tools/read-terrain-variables.ts` | New MCP tool |
| `packages/gaea/src/tools/set-terrain-variables.ts` | New MCP tool |
| `packages/gaea/src/tools/bake-terrain.ts` | New MCP tool |
| `packages/gaea/src/tools/open-in-gaea.ts` | New MCP tool |
| `packages/gaea/src/tools/index.ts` | Register 4 new tools |
| `packages/gaea/src/templates/mountains.ts` | Add `variables` export |
| `packages/gaea/src/templates/desert.ts` | Add `variables` export |
| `packages/gaea/src/templates/tropical.ts` | Add `variables` export |
| `packages/gaea/src/templates/volcanic.ts` | Add `variables` export |
| `packages/gaea/src/templates/index.ts` | Expose `variables` from `listTemplates()` |
| `tests/tools/bake-terrain.test.ts` | New test |
| `tests/tools/read-terrain-variables.test.ts` | New test |
| `tests/tools/set-terrain-variables.test.ts` | New test |
| `tests/tools/open-in-gaea.test.ts` | New test |

---

## Task 1: Add TemplateVariableContract types + update TemplateMeta

**Files:**
- Modify: `packages/gaea/src/types.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/types.test.ts — add to existing describe block
import type { TemplateMeta, TemplateVariableContract } from "../src/types.js";

it("TemplateVariableContract type accepts valid contracts", () => {
  const contract: TemplateVariableContract = {
    Seed: { type: "Int", default: 0, min: 0, max: 9999, description: "Random seed" },
    Scale: { type: "Float", default: 1.5, min: 0.5, max: 4.0, description: "Terrain scale" },
  };
  expect(contract.Seed.type).toBe("Int");
  expect(contract.Scale.default).toBe(1.5);
});

it("TemplateMeta accepts optional variables field", () => {
  const meta: TemplateMeta = {
    name: "test",
    description: "test template",
    tweakable: ["Seed"],
    variables: {
      Seed: { type: "Int", default: 0, min: 0, max: 9999, description: "Seed" }
    }
  };
  expect(meta.variables?.Seed.type).toBe("Int");
});
```

- [ ] **Step 2: Run to confirm failure**

```bash
cd packages/gaea && npm test -- --reporter=verbose 2>&1 | grep -E "TemplateVariable|FAIL|error"
```
Expected: TypeScript error — `TemplateVariableContract` not found.

- [ ] **Step 3: Add types to `types.ts`**

Append to the end of `packages/gaea/src/types.ts`:

```ts
export type TemplateVariableType = "Int" | "Float" | "Bool" | "String" | "Choice";

export interface TemplateVariableSpec {
  type: TemplateVariableType;
  default: unknown;
  min?: number;
  max?: number;
  choices?: string[];
  description: string;
}

export type TemplateVariableContract = Record<string, TemplateVariableSpec>;
```

Replace the existing `TemplateMeta` interface:

```ts
export interface TemplateMeta {
  name: string;
  description: string;
  tweakable: string[];
  variables?: TemplateVariableContract;
}
```

- [ ] **Step 4: Run tests — must pass**

```bash
cd packages/gaea && npm test -- --reporter=verbose 2>&1 | grep -E "✓|×|Tests"
```
Expected: same 45 passing, 2 pre-existing failures, no new failures.

- [ ] **Step 5: Commit**

```bash
cd packages/gaea && git add src/types.ts tests/types.test.ts
git commit -m "feat(gaea): add TemplateVariableContract type and update TemplateMeta"
```

---

## Task 2: Add Swarm path detection to gaea-launcher.ts

**Files:**
- Modify: `packages/gaea/src/gaea-launcher.ts`

- [ ] **Step 1: Write the failing test**

Add to `tests/session.test.ts` (or create `tests/gaea-launcher.test.ts`):

```ts
// tests/gaea-launcher.test.ts
import { describe, it, expect } from "vitest";
import { GAEA_SWARM_CANDIDATE_PATHS, detectSwarmPath } from "../src/gaea-launcher.js";

describe("Swarm path detection", () => {
  it("GAEA_SWARM_CANDIDATE_PATHS contains multiple version paths", () => {
    expect(GAEA_SWARM_CANDIDATE_PATHS.length).toBeGreaterThanOrEqual(4);
    expect(GAEA_SWARM_CANDIDATE_PATHS.some(p => p.includes("Gaea.Swarm.exe"))).toBe(true);
    expect(GAEA_SWARM_CANDIDATE_PATHS.some(p => p.includes("2.0"))).toBe(true);
    expect(GAEA_SWARM_CANDIDATE_PATHS.some(p => p.includes("2.2"))).toBe(true);
  });

  it("detectSwarmPath returns null when no Swarm.exe found", () => {
    // On CI / dev machines without Gaea installed, returns null — not an error
    const result = detectSwarmPath();
    expect(result === null || typeof result === "string").toBe(true);
  });
});
```

- [ ] **Step 2: Run to confirm failure**

```bash
cd packages/gaea && npm test -- --reporter=verbose 2>&1 | grep -E "Swarm|FAIL"
```
Expected: `GAEA_SWARM_CANDIDATE_PATHS` not exported.

- [ ] **Step 3: Add to `gaea-launcher.ts`**

The full updated `packages/gaea/src/gaea-launcher.ts`:

```ts
import { spawn } from "child_process";
import { existsSync } from "fs";
import path from "path";
import os from "os";

const LOCALAPPDATA = process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local");

export const GAEA_CANDIDATE_PATHS = [
  path.join(LOCALAPPDATA, "Programs", "Gaea 2.0", "Gaea.exe"),
  path.join(LOCALAPPDATA, "Programs", "Gaea 2.2", "Gaea.exe"),
  path.join(LOCALAPPDATA, "Programs", "Gaea", "Gaea.exe"),
  "C:\\Program Files\\QuadSpinner\\Gaea 2\\Gaea.exe",
];

export const GAEA_SWARM_CANDIDATE_PATHS = [
  path.join(LOCALAPPDATA, "Programs", "Gaea 2.0", "Gaea.Swarm.exe"),
  path.join(LOCALAPPDATA, "Programs", "Gaea 2.1", "Gaea.Swarm.exe"),
  path.join(LOCALAPPDATA, "Programs", "Gaea 2.2", "Gaea.Swarm.exe"),
  path.join(LOCALAPPDATA, "Programs", "Gaea 2.3", "Gaea.Swarm.exe"),
  path.join(LOCALAPPDATA, "Programs", "Gaea", "Gaea.Swarm.exe"),
  "C:\\Program Files\\QuadSpinner\\Gaea 2\\Gaea.Swarm.exe",
];

export function detectGaeaPath(): string | null {
  return GAEA_CANDIDATE_PATHS.find(p => existsSync(p)) ?? null;
}

export function detectSwarmPath(): string | null {
  return GAEA_SWARM_CANDIDATE_PATHS.find(p => existsSync(p)) ?? null;
}

export function launchGaea(gaeaExePath: string, terrainPath: string): number {
  if (!existsSync(gaeaExePath)) {
    throw new Error(`Gaea.exe not found at ${gaeaExePath}. Update gaeaExePath in swarmhost.config.json.`);
  }
  const child = spawn(gaeaExePath, [terrainPath], { detached: true, stdio: "ignore" });
  child.unref();
  return child.pid!;
}

export function isProcessRunning(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
```

- [ ] **Step 4: Run tests — must pass**

```bash
cd packages/gaea && npm test -- --reporter=verbose 2>&1 | grep -E "✓|×|Tests"
```
Expected: 47+ passing, 2 pre-existing failures, new Swarm detection tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/gaea/src/gaea-launcher.ts tests/gaea-launcher.test.ts
git commit -m "feat(gaea): add Gaea.Swarm.exe path detection"
```

---

## Task 3: Rewrite cook() to use Gaea.Swarm.exe

**Files:**
- Modify: `packages/gaea/src/swarmhost.ts`

The current `cook()` method (lines ~1044–1080) uses `Gaea.BuildManager.exe path --automation`. This is the wrong binary. The correct CLI is:

```
Gaea.Swarm.exe -filename "path\to\file.terrain" -ignorecache -v key1=val1 -v key2=val2
```

- [ ] **Step 1: Write the failing test**

```ts
// tests/swarmhost-cook.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as cp from "child_process";
import * as gaeaLauncher from "../src/gaea-launcher.js";
import { SwarmHostClient } from "../src/swarmhost.js";
import { mkdirSync, writeFileSync, rmSync } from "fs";
import path from "path";
import os from "os";

const TMP = path.join(os.tmpdir(), "gaea-cook-test");
const TERRAIN = path.join(TMP, "test.terrain");

// Minimal valid terrain JSON
const BLANK_TERRAIN = JSON.stringify({
  "$id": "1",
  Assets: { "$id": "2", "$values": [{
    "$id": "3",
    Terrain: { "$id": "4", Id: "test-id", Metadata: {}, Nodes: { "$id": "5" }, Groups: { "$id": "6" }, Notes: { "$id": "7" }, GraphTabs: { "$id": "8", "$values": [] }, Width: 8000, Height: 4000, Ratio: 0.5, Regions: { "$id": "9", "$values": [] } },
    Automation: { "$id": "10", Bindings: { "$id": "11", "$values": [] }, Expressions: { "$id": "12" }, VariablesEx: { "$id": "13" }, Variables: { "$id": "14" } },
    BuildDefinition: { "$id": "15", Type: "Standard", Destination: TMP, Resolution: 1024, BakeResolution: 1024, TileResolution: 512, BucketResolution: 1024, NumberOfTiles: 1, EdgeBlending: 0, TileZeroIndex: false, TilePattern: "", OrganizeFiles: "", PostBuildScript: "", ColorSpace: "Linear" },
    State: { "$id": "16" }, BuildProfiles: { "$id": "17" }
  }] },
  Id: "root-id", Branch: 0, Metadata: { "$id": "18" }
});

beforeEach(() => {
  mkdirSync(TMP, { recursive: true });
  writeFileSync(TERRAIN, BLANK_TERRAIN, "utf-8");
});

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("SwarmHostClient.cook() — CLI mode with Swarm.exe", () => {
  it("calls Gaea.Swarm.exe with -filename flag", () => {
    vi.spyOn(gaeaLauncher, "detectSwarmPath").mockReturnValue("C:\\fake\\Gaea.Swarm.exe");
    const spawnSpy = vi.spyOn(cp, "spawnSync").mockReturnValue({
      status: 0, stdout: "Build complete", stderr: "", error: undefined, pid: 1, output: [], signal: null
    } as any);

    const client = new SwarmHostClient({ execPath: "", port: 0, outputDir: TMP, swarmExePath: "C:\\fake\\Gaea.Swarm.exe" });
    (client as any)._currentTerrainPath = TERRAIN;

    return client.cook().then(() => {
      expect(spawnSpy).toHaveBeenCalledWith(
        "C:\\fake\\Gaea.Swarm.exe",
        expect.arrayContaining(["-filename", TERRAIN, "-ignorecache"]),
        expect.any(Object)
      );
    });
  });

  it("injects -v flags for each variable", () => {
    vi.spyOn(gaeaLauncher, "detectSwarmPath").mockReturnValue("C:\\fake\\Gaea.Swarm.exe");
    const spawnSpy = vi.spyOn(cp, "spawnSync").mockReturnValue({
      status: 0, stdout: "", stderr: "", error: undefined, pid: 1, output: [], signal: null
    } as any);

    const client = new SwarmHostClient({ execPath: "", port: 0, outputDir: TMP, swarmExePath: "C:\\fake\\Gaea.Swarm.exe" });
    (client as any)._currentTerrainPath = TERRAIN;

    return client.cook(undefined, { Seed: 42, Scale: 2.0 }).then(() => {
      const args: string[] = spawnSpy.mock.calls[0][1] as string[];
      expect(args).toContain("-v");
      // -v must come after -ignorecache (Gaea requirement: -v flags must be last)
      const vIndex = args.indexOf("-v");
      const ignoreIndex = args.indexOf("-ignorecache");
      expect(vIndex).toBeGreaterThan(ignoreIndex);
      expect(args).toContain("Seed=42");
      expect(args).toContain("Scale=2");
    });
  });

  it("throws with helpful message when Swarm.exe not found", () => {
    vi.spyOn(gaeaLauncher, "detectSwarmPath").mockReturnValue(null);

    const client = new SwarmHostClient({ execPath: "", port: 0, outputDir: TMP });
    (client as any)._currentTerrainPath = TERRAIN;

    return expect(client.cook()).rejects.toThrow("Gaea.Swarm.exe not found");
  });

  it("throws with build output when Swarm exits non-zero", () => {
    vi.spyOn(gaeaLauncher, "detectSwarmPath").mockReturnValue("C:\\fake\\Gaea.Swarm.exe");
    vi.spyOn(cp, "spawnSync").mockReturnValue({
      status: 1, stdout: "", stderr: "Build error: missing node", error: undefined, pid: 1, output: [], signal: null
    } as any);

    const client = new SwarmHostClient({ execPath: "", port: 0, outputDir: TMP, swarmExePath: "C:\\fake\\Gaea.Swarm.exe" });
    (client as any)._currentTerrainPath = TERRAIN;

    return expect(client.cook()).rejects.toThrow("Gaea build failed");
  });
});
```

- [ ] **Step 2: Run to confirm failure**

```bash
cd packages/gaea && npm test tests/swarmhost-cook.test.ts 2>&1 | tail -15
```
Expected: fails — `cook()` doesn't accept variable param yet, still calls BuildManager.exe.

- [ ] **Step 3: Update `SwarmHostConfig` and rewrite `cook()`**

In `packages/gaea/src/swarmhost.ts`:

**3a.** Add `swarmExePath?: string` to `SwarmHostConfig`:

```ts
export interface SwarmHostConfig {
  execPath: string;
  port: number;
  outputDir: string;
  gaeaExePath?: string;
  swarmExePath?: string;  // ← add this line
}
```

**3b.** Add import at top of file (after existing imports):

```ts
import { detectSwarmPath } from "./gaea-launcher.js";
```

**3c.** Replace the entire `cook()` method (lines ~1044–1080):

```ts
async cook(nodeIds?: string[], variables?: Record<string, unknown>, ignorecache = true): Promise<void> {
  if (this.base) {
    await this.request("POST", "/graph/cook", nodeIds ? { nodes: nodeIds } : {});
    return;
  }
  if (!this._currentTerrainPath) {
    throw new Error("No terrain loaded. Call createGraph or loadGraph first.");
  }

  const swarmExe = this.cfg!.swarmExePath ?? detectSwarmPath();
  if (!swarmExe) {
    throw new Error(
      "Gaea.Swarm.exe not found. Install Gaea 2.x or set swarmExePath in swarmhost.config.json.\n" +
      "Checked paths: " + (await import("./gaea-launcher.js")).GAEA_SWARM_CANDIDATE_PATHS.join(", ")
    );
  }

  // Build args — -v flags MUST come last (Gaea requirement)
  const args: string[] = ["-filename", this._currentTerrainPath];
  if (ignorecache) args.push("-ignorecache");

  if (variables && Object.keys(variables).length > 0) {
    for (const [key, val] of Object.entries(variables)) {
      args.push("-v", `${key}=${val}`);
    }
  }

  const result = spawnSync(swarmExe, args, { encoding: "utf-8", timeout: 300_000 });

  if (result.error) {
    throw new Error(`Failed to start Gaea.Swarm.exe: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const output = result.stderr?.slice(0, 500) || result.stdout?.slice(0, 500) || "";
    throw new Error(`Gaea build failed (exit ${result.status}): ${output}`);
  }
}
```

- [ ] **Step 4: Run tests — all 4 new tests must pass**

```bash
cd packages/gaea && npm test tests/swarmhost-cook.test.ts -- --reporter=verbose 2>&1 | tail -15
```
Expected: 4/4 passing.

- [ ] **Step 5: Run full suite — no regressions**

```bash
cd packages/gaea && npm test 2>&1 | grep -E "Tests|passed|failed"
```
Expected: 51+ passing, same 2 pre-existing failures.

- [ ] **Step 6: Commit**

```bash
git add packages/gaea/src/swarmhost.ts tests/swarmhost-cook.test.ts
git commit -m "fix(gaea): rewrite cook() to use Gaea.Swarm.exe with -v variable injection"
```

---

## Task 4: Add readTerrainVariables + setTerrainVariables to SwarmHostClient

**Files:**
- Modify: `packages/gaea/src/swarmhost.ts`

Variables live at `Assets[0].Automation.Variables` in the terrain JSON. We store them as:
```json
{ "$id": "10", "Seed": { "Type": "Int", "Value": 0, "Min": 0, "Max": 9999, "Name": "Seed" } }
```

- [ ] **Step 1: Write the failing test**

```ts
// tests/swarmhost-variables.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { SwarmHostClient } from "../src/swarmhost.js";
import { mkdirSync, writeFileSync, readFileSync, rmSync } from "fs";
import path from "path";
import os from "os";

const TMP = path.join(os.tmpdir(), "gaea-vars-test");
const TERRAIN = path.join(TMP, "test.terrain");

function makeTerrainWithVars(vars: Record<string, unknown>) {
  return JSON.stringify({
    "$id": "1",
    Assets: { "$id": "2", "$values": [{
      "$id": "3",
      Terrain: { "$id": "4", Id: "tid", Metadata: {}, Nodes: { "$id": "5" }, Groups: { "$id": "6" }, Notes: { "$id": "7" }, GraphTabs: { "$id": "8", "$values": [] }, Width: 8000, Height: 4000, Ratio: 0.5, Regions: { "$id": "9", "$values": [] } },
      Automation: { "$id": "10", Bindings: { "$id": "11", "$values": [] }, Expressions: { "$id": "12" }, VariablesEx: { "$id": "13" }, Variables: { "$id": "14", ...vars } },
      BuildDefinition: { "$id": "15", Type: "Standard", Destination: TMP, Resolution: 1024, BakeResolution: 1024, TileResolution: 512, BucketResolution: 1024, NumberOfTiles: 1, EdgeBlending: 0, TileZeroIndex: false, TilePattern: "", OrganizeFiles: "", PostBuildScript: "", ColorSpace: "Linear" },
      State: { "$id": "16" }, BuildProfiles: { "$id": "17" }
    }] },
    Id: "root", Branch: 0, Metadata: { "$id": "18" }
  });
}

beforeEach(() => {
  mkdirSync(TMP, { recursive: true });
});
afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
});

describe("readTerrainVariables", () => {
  it("returns empty object when no variables defined", () => {
    writeFileSync(TERRAIN, makeTerrainWithVars({}), "utf-8");
    const client = new SwarmHostClient({ execPath: "", port: 0, outputDir: TMP });
    (client as any)._currentTerrainPath = TERRAIN;
    const vars = client.readTerrainVariables();
    expect(vars).toEqual({});
  });

  it("reads declared variables from terrain file", () => {
    writeFileSync(TERRAIN, makeTerrainWithVars({
      Seed: { Type: "Int", Value: 42, Min: 0, Max: 9999, Name: "Seed" }
    }), "utf-8");
    const client = new SwarmHostClient({ execPath: "", port: 0, outputDir: TMP });
    (client as any)._currentTerrainPath = TERRAIN;
    const vars = client.readTerrainVariables();
    expect(vars.Seed).toBeDefined();
    expect(vars.Seed.Value).toBe(42);
  });
});

describe("setTerrainVariables", () => {
  it("writes variables into terrain file Automation.Variables", () => {
    writeFileSync(TERRAIN, makeTerrainWithVars({}), "utf-8");
    const client = new SwarmHostClient({ execPath: "", port: 0, outputDir: TMP });
    (client as any)._currentTerrainPath = TERRAIN;

    client.setTerrainVariables({
      Seed: { type: "Int", default: 0, min: 0, max: 9999, description: "Random seed" }
    }, { Seed: 77 });

    const raw = JSON.parse(readFileSync(TERRAIN, "utf-8"));
    const vars = raw.Assets["$values"][0].Automation.Variables;
    expect(vars.Seed).toBeDefined();
    expect(vars.Seed.Value).toBe(77);
  });

  it("reads back what was written", () => {
    writeFileSync(TERRAIN, makeTerrainWithVars({}), "utf-8");
    const client = new SwarmHostClient({ execPath: "", port: 0, outputDir: TMP });
    (client as any)._currentTerrainPath = TERRAIN;

    client.setTerrainVariables({
      Scale: { type: "Float", default: 1.5, min: 0.5, max: 4.0, description: "Scale" }
    }, { Scale: 2.5 });

    const vars = client.readTerrainVariables();
    expect(vars.Scale.Value).toBe(2.5);
  });
});
```

- [ ] **Step 2: Run to confirm failure**

```bash
cd packages/gaea && npm test tests/swarmhost-variables.test.ts 2>&1 | tail -10
```
Expected: `readTerrainVariables is not a function`.

- [ ] **Step 3: Add methods to `SwarmHostClient` in `swarmhost.ts`**

Add these two public methods after `cook()` (around line 1082):

```ts
readTerrainVariables(terrainPath?: string): Record<string, Record<string, unknown>> {
  const p = terrainPath ?? this._currentTerrainPath;
  if (!p) throw new Error("No terrain path provided and no terrain currently loaded.");
  const terrain = JSON.parse(readFileSync(p, "utf-8"));
  const vars = getAssets(terrain)[0]?.Automation?.Variables ?? {};
  // Strip JSON.NET metadata key
  const result: Record<string, Record<string, unknown>> = {};
  for (const [k, v] of Object.entries(vars)) {
    if (k === "$id") continue;
    result[k] = v as Record<string, unknown>;
  }
  return result;
}

setTerrainVariables(
  contract: Record<string, { type: string; default: unknown; min?: number; max?: number; description: string }>,
  values: Record<string, unknown>,
  terrainPath?: string
): void {
  const p = terrainPath ?? this._currentTerrainPath;
  if (!p) throw new Error("No terrain path provided and no terrain currently loaded.");
  const terrain = JSON.parse(readFileSync(p, "utf-8"));
  const automation = getAssets(terrain)[0].Automation;
  const existing = automation.Variables ?? {};
  const existingId = (existing as Record<string, unknown>)["$id"] ?? String(findMaxJsonId(terrain) + 1);

  const newVars: Record<string, unknown> = { "$id": existingId };
  for (const [name, spec] of Object.entries(contract)) {
    const value = name in values ? values[name] : spec.default;
    newVars[name] = {
      Type: spec.type,
      Value: value,
      ...(spec.min !== undefined && { Min: spec.min }),
      ...(spec.max !== undefined && { Max: spec.max }),
      Name: name,
    };
  }
  automation.Variables = newVars;
  writeFileSync(p, serializeGaea(terrain), "utf-8");
}
```

- [ ] **Step 4: Run tests — all 4 must pass**

```bash
cd packages/gaea && npm test tests/swarmhost-variables.test.ts -- --reporter=verbose 2>&1 | tail -15
```
Expected: 4/4 passing.

- [ ] **Step 5: Run full suite**

```bash
cd packages/gaea && npm test 2>&1 | grep -E "Tests|passed|failed"
```
Expected: 55+ passing, same 2 pre-existing failures.

- [ ] **Step 6: Commit**

```bash
git add packages/gaea/src/swarmhost.ts tests/swarmhost-variables.test.ts
git commit -m "feat(gaea): add readTerrainVariables + setTerrainVariables to SwarmHostClient"
```

---

## Task 5: MCP tool — bake_terrain

**Files:**
- Create: `packages/gaea/src/tools/bake-terrain.ts`
- Create: `tests/tools/bake-terrain.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/tools/bake-terrain.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { bakeTerrain } from "../../src/tools/bake-terrain.js";
import type { SessionManager } from "../../src/session.js";

const mockSession = {
  client: {
    cook: vi.fn().mockResolvedValue(undefined),
    export: vi.fn().mockResolvedValue({ heightmap: "C:\\tmp\\heightmap.exr" }),
  },
  enqueue: vi.fn((fn: () => Promise<unknown>) => fn()),
  outputDir: "C:\\tmp",
  terrainPath: "C:\\tmp\\test.terrain",
} as unknown as SessionManager;

describe("bake_terrain tool", () => {
  beforeEach(() => vi.clearAllMocks());

  it("calls cook with no variables when none provided", async () => {
    const result = await bakeTerrain({ path: "C:\\tmp\\test.terrain" }, mockSession);
    expect(result.isError).toBeFalsy();
    expect(mockSession.client.cook).toHaveBeenCalledWith(undefined, undefined, true);
    expect(result.content[0].text).toContain("heightmap");
  });

  it("passes variables to cook as second argument", async () => {
    await bakeTerrain(
      { path: "C:\\tmp\\test.terrain", variables: { Seed: 42, Scale: 2.0 } },
      mockSession
    );
    expect(mockSession.client.cook).toHaveBeenCalledWith(undefined, { Seed: 42, Scale: 2.0 }, true);
  });

  it("passes ignorecache=false when specified", async () => {
    await bakeTerrain(
      { path: "C:\\tmp\\test.terrain", ignorecache: false },
      mockSession
    );
    expect(mockSession.client.cook).toHaveBeenCalledWith(undefined, undefined, false);
  });

  it("returns error object when cook throws", async () => {
    (mockSession.client.cook as any).mockRejectedValueOnce(new Error("Gaea.Swarm.exe not found"));
    const result = await bakeTerrain({ path: "C:\\tmp\\test.terrain" }, mockSession);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Gaea.Swarm.exe not found");
  });
});
```

- [ ] **Step 2: Run to confirm failure**

```bash
cd packages/gaea && npm test tests/tools/bake-terrain.test.ts 2>&1 | tail -10
```
Expected: module not found.

- [ ] **Step 3: Create `bake-terrain.ts`**

```ts
// packages/gaea/src/tools/bake-terrain.ts
import { registerTool, type ToolHandler, type ToolResult } from "./index.js";

export const bakeTerrain: ToolHandler = async (args, session) => {
  const terrainPath = (args.path as string | undefined) ?? session.terrainPath;
  if (!terrainPath) {
    return {
      content: [{ type: "text", text: "Error: path is required — no terrain is currently loaded." }],
      isError: true,
    };
  }

  const variables = args.variables as Record<string, unknown> | undefined;
  const ignorecache = args.ignorecache !== false; // default true

  // Load the terrain if it isn't already the active one
  if (terrainPath !== session.terrainPath) {
    await session.enqueue(() => session.client.loadGraph(terrainPath));
    session.setTerrainPath(terrainPath);
  }

  try {
    await session.enqueue(() => session.client.cook(undefined, variables, ignorecache));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { content: [{ type: "text", text: `Bake failed: ${message}` }], isError: true };
  }

  let exported: { heightmap: string; normalmap?: string; splatmap?: string } | null = null;
  try {
    exported = await session.enqueue(() => session.client.export(session.outputDir, "EXR"));
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
  ].filter(Boolean).join("\n");

  return { content: [{ type: "text", text: lines }] };
};

registerTool(
  {
    name: "bake_terrain",
    description:
      `Bake a Gaea terrain file using Gaea.Swarm.exe. Optionally inject variable overrides via -v flags without modifying the file.

Use read_terrain_variables first to see what variables are available in the file.
Variables are passed as CLI flags only and do not persist to the .terrain file.

Examples:
- bake_terrain({ path: "/path/to/file.terrain" })
- bake_terrain({ path: "/path/to/file.terrain", variables: { Seed: 42, Scale: 2.0 } })`,
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute path to the .terrain file to bake" },
        variables: {
          type: "object",
          description: "Variable overrides to inject as -v key=value CLI flags. Keys must match variable names declared in the terrain file."
        },
        ignorecache: {
          type: "boolean",
          description: "Whether to ignore baked cache and force a full re-bake (default: true)"
        }
      }
    }
  },
  bakeTerrain
);
```

- [ ] **Step 4: Run tests — all 4 must pass**

```bash
cd packages/gaea && npm test tests/tools/bake-terrain.test.ts -- --reporter=verbose 2>&1 | tail -15
```
Expected: 4/4 passing.

- [ ] **Step 5: Commit**

```bash
git add packages/gaea/src/tools/bake-terrain.ts tests/tools/bake-terrain.test.ts
git commit -m "feat(gaea): add bake_terrain MCP tool"
```

---

## Task 6: MCP tool — read_terrain_variables

**Files:**
- Create: `packages/gaea/src/tools/read-terrain-variables.ts`
- Create: `tests/tools/read-terrain-variables.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/tools/read-terrain-variables.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readTerrainVariablesTool } from "../../src/tools/read-terrain-variables.js";
import type { SessionManager } from "../../src/session.js";

const mockVars = {
  Seed: { Type: "Int", Value: 42, Min: 0, Max: 9999, Name: "Seed" },
  Scale: { Type: "Float", Value: 1.5, Min: 0.5, Max: 4.0, Name: "Scale" },
};

const mockSession = {
  client: { readTerrainVariables: vi.fn().mockReturnValue(mockVars) },
  enqueue: vi.fn((fn: () => unknown) => Promise.resolve(fn())),
  terrainPath: "C:\\tmp\\test.terrain",
} as unknown as SessionManager;

describe("read_terrain_variables tool", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns variable list from current terrain", async () => {
    const result = await readTerrainVariablesTool({}, mockSession);
    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0].text);
    expect(data.variables.Seed).toBeDefined();
    expect(data.variables.Scale.Value).toBe(1.5);
  });

  it("uses provided path over session terrainPath", async () => {
    await readTerrainVariablesTool({ path: "C:\\other.terrain" }, mockSession);
    expect(mockSession.client.readTerrainVariables).toHaveBeenCalledWith("C:\\other.terrain");
  });

  it("returns error when no terrain loaded and no path provided", async () => {
    const noPathSession = { ...mockSession, terrainPath: null } as unknown as SessionManager;
    const result = await readTerrainVariablesTool({}, noPathSession);
    expect(result.isError).toBe(true);
  });
});
```

- [ ] **Step 2: Run to confirm failure**

```bash
cd packages/gaea && npm test tests/tools/read-terrain-variables.test.ts 2>&1 | tail -8
```
Expected: module not found.

- [ ] **Step 3: Create `read-terrain-variables.ts`**

```ts
// packages/gaea/src/tools/read-terrain-variables.ts
import { registerTool, type ToolHandler } from "./index.js";

export const readTerrainVariablesTool: ToolHandler = async (args, session) => {
  const terrainPath = (args.path as string | undefined) ?? session.terrainPath;
  if (!terrainPath) {
    return {
      content: [{ type: "text", text: "Error: no terrain is currently loaded and no path was provided." }],
      isError: true,
    };
  }

  const variables = session.client.readTerrainVariables(terrainPath);
  const count = Object.keys(variables).length;

  return {
    content: [{
      type: "text",
      text: JSON.stringify({
        terrainPath,
        variableCount: count,
        variables,
        usage: count === 0
          ? "No variables declared. Set up variable bindings in the Gaea UI, or use a template that declares variable contracts."
          : "Pass these variable names in bake_terrain({ variables: { key: value } }) to override at bake time.",
      }, null, 2)
    }]
  };
};

registerTool(
  {
    name: "read_terrain_variables",
    description:
      `List all variables declared in a Gaea .terrain file. Variables are named parameters bound to node properties that can be overridden at bake time via CLI flags.

Use this before bake_terrain to discover what's parameterizable.
Returns variable names, types, current values, and min/max ranges.`,
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute path to the .terrain file (uses currently loaded terrain if omitted)" }
      }
    }
  },
  readTerrainVariablesTool
);
```

- [ ] **Step 4: Run tests — all 3 must pass**

```bash
cd packages/gaea && npm test tests/tools/read-terrain-variables.test.ts -- --reporter=verbose 2>&1 | tail -12
```
Expected: 3/3 passing.

- [ ] **Step 5: Commit**

```bash
git add packages/gaea/src/tools/read-terrain-variables.ts tests/tools/read-terrain-variables.test.ts
git commit -m "feat(gaea): add read_terrain_variables MCP tool"
```

---

## Task 7: MCP tool — set_terrain_variables

**Files:**
- Create: `packages/gaea/src/tools/set-terrain-variables.ts`
- Create: `tests/tools/set-terrain-variables.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/tools/set-terrain-variables.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { setTerrainVariablesTool } from "../../src/tools/set-terrain-variables.js";
import type { SessionManager } from "../../src/session.js";

const mockSession = {
  client: {
    setTerrainVariables: vi.fn(),
    readTerrainVariables: vi.fn().mockReturnValue({ Seed: { Type: "Int", Value: 77, Name: "Seed" } }),
  },
  enqueue: vi.fn((fn: () => unknown) => Promise.resolve(fn())),
  terrainPath: "C:\\tmp\\test.terrain",
} as unknown as SessionManager;

describe("set_terrain_variables tool", () => {
  beforeEach(() => vi.clearAllMocks());

  it("calls setTerrainVariables with contract and values", async () => {
    const result = await setTerrainVariablesTool({
      path: "C:\\tmp\\test.terrain",
      contract: { Seed: { type: "Int", default: 0, min: 0, max: 9999, description: "Seed" } },
      values: { Seed: 77 }
    }, mockSession);
    expect(result.isError).toBeFalsy();
    expect(mockSession.client.setTerrainVariables).toHaveBeenCalledWith(
      { Seed: { type: "Int", default: 0, min: 0, max: 9999, description: "Seed" } },
      { Seed: 77 },
      "C:\\tmp\\test.terrain"
    );
  });

  it("returns updated variable list in response", async () => {
    await setTerrainVariablesTool({
      path: "C:\\tmp\\test.terrain",
      contract: { Seed: { type: "Int", default: 0, min: 0, max: 9999, description: "Seed" } },
      values: { Seed: 77 }
    }, mockSession);
    expect(mockSession.client.readTerrainVariables).toHaveBeenCalled();
  });

  it("returns error when contract is missing", async () => {
    const result = await setTerrainVariablesTool({ path: "C:\\tmp\\test.terrain", values: { Seed: 1 } }, mockSession);
    expect(result.isError).toBe(true);
  });
});
```

- [ ] **Step 2: Run to confirm failure**

```bash
cd packages/gaea && npm test tests/tools/set-terrain-variables.test.ts 2>&1 | tail -8
```
Expected: module not found.

- [ ] **Step 3: Create `set-terrain-variables.ts`**

```ts
// packages/gaea/src/tools/set-terrain-variables.ts
import { registerTool, type ToolHandler } from "./index.js";
import type { TemplateVariableContract } from "../types.js";

export const setTerrainVariablesTool: ToolHandler = async (args, session) => {
  const terrainPath = (args.path as string | undefined) ?? session.terrainPath;
  if (!terrainPath) {
    return { content: [{ type: "text", text: "Error: no terrain path provided." }], isError: true };
  }
  if (!args.contract || typeof args.contract !== "object") {
    return { content: [{ type: "text", text: "Error: contract is required — provide a variable contract object." }], isError: true };
  }

  const contract = args.contract as TemplateVariableContract;
  const values = (args.values as Record<string, unknown>) ?? {};

  try {
    session.client.setTerrainVariables(contract, values, terrainPath);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
  }

  const updated = session.client.readTerrainVariables(terrainPath);
  return {
    content: [{
      type: "text",
      text: JSON.stringify({ terrainPath, variablesWritten: Object.keys(contract).length, variables: updated }, null, 2)
    }]
  };
};

registerTool(
  {
    name: "set_terrain_variables",
    description:
      `Write variable declarations and values into a Gaea .terrain file's Automation.Variables section.
This persists variables to the file (unlike bake_terrain which passes them as transient CLI flags).

Use this when you want variables to be visible in Gaea's UI after opening the file,
or to pre-populate a template with specific values before sharing.

contract: variable specs (name, type, default, min, max, description)
values: actual values to write (falls back to contract defaults if omitted)`,
    inputSchema: {
      type: "object",
      required: ["contract"],
      properties: {
        path: { type: "string", description: "Absolute path to the .terrain file (uses current terrain if omitted)" },
        contract: {
          type: "object",
          description: "Variable contract: keys are variable names, values define type/default/min/max/description"
        },
        values: {
          type: "object",
          description: "Values to write for each variable. Missing keys use contract defaults."
        }
      }
    }
  },
  setTerrainVariablesTool
);
```

- [ ] **Step 4: Run tests — all 3 must pass**

```bash
cd packages/gaea && npm test tests/tools/set-terrain-variables.test.ts -- --reporter=verbose 2>&1 | tail -12
```
Expected: 3/3 passing.

- [ ] **Step 5: Commit**

```bash
git add packages/gaea/src/tools/set-terrain-variables.ts tests/tools/set-terrain-variables.test.ts
git commit -m "feat(gaea): add set_terrain_variables MCP tool"
```

---

## Task 8: MCP tool — open_in_gaea

**Files:**
- Create: `packages/gaea/src/tools/open-in-gaea.ts`
- Create: `tests/tools/open-in-gaea.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/tools/open-in-gaea.test.ts
import { describe, it, expect, vi, afterEach } from "vitest";
import * as gaeaLauncher from "../../src/gaea-launcher.js";
import { openInGaeaTool } from "../../src/tools/open-in-gaea.js";
import type { SessionManager } from "../../src/session.js";

const mockSession = {
  terrainPath: "C:\\tmp\\test.terrain",
  gaeaExePath: "C:\\fake\\Gaea.exe",
} as unknown as SessionManager;

afterEach(() => vi.restoreAllMocks());

describe("open_in_gaea tool", () => {
  it("calls launchGaea with the provided path", async () => {
    const launchSpy = vi.spyOn(gaeaLauncher, "launchGaea").mockReturnValue(1234);
    const result = await openInGaeaTool({ path: "C:\\tmp\\test.terrain" }, mockSession);
    expect(result.isError).toBeFalsy();
    expect(launchSpy).toHaveBeenCalledWith(expect.any(String), "C:\\tmp\\test.terrain");
    expect(result.content[0].text).toContain("launched");
  });

  it("uses session terrainPath when no path provided", async () => {
    const launchSpy = vi.spyOn(gaeaLauncher, "launchGaea").mockReturnValue(5678);
    await openInGaeaTool({}, mockSession);
    expect(launchSpy).toHaveBeenCalledWith(expect.any(String), "C:\\tmp\\test.terrain");
  });

  it("returns error when no terrain path available", async () => {
    const noPathSession = { ...mockSession, terrainPath: null } as unknown as SessionManager;
    const result = await openInGaeaTool({}, noPathSession);
    expect(result.isError).toBe(true);
  });

  it("returns error when launchGaea throws", async () => {
    vi.spyOn(gaeaLauncher, "launchGaea").mockImplementation(() => { throw new Error("Gaea.exe not found"); });
    const result = await openInGaeaTool({ path: "C:\\tmp\\test.terrain" }, mockSession);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Gaea.exe not found");
  });
});
```

- [ ] **Step 2: Run to confirm failure**

```bash
cd packages/gaea && npm test tests/tools/open-in-gaea.test.ts 2>&1 | tail -8
```
Expected: module not found.

- [ ] **Step 3: Create `open-in-gaea.ts`**

```ts
// packages/gaea/src/tools/open-in-gaea.ts
import { registerTool, type ToolHandler } from "./index.js";
import { launchGaea, detectGaeaPath } from "../gaea-launcher.js";

export const openInGaeaTool: ToolHandler = async (args, session) => {
  const terrainPath = (args.path as string | undefined) ?? session.terrainPath;
  if (!terrainPath) {
    return {
      content: [{ type: "text", text: "Error: no terrain path provided and no terrain currently loaded." }],
      isError: true,
    };
  }

  const gaeaExePath = session.gaeaExePath || detectGaeaPath();
  if (!gaeaExePath) {
    return {
      content: [{ type: "text", text: "Error: Gaea.exe not found. Set gaeaExePath in swarmhost.config.json." }],
      isError: true,
    };
  }

  try {
    const pid = launchGaea(gaeaExePath, terrainPath);
    return {
      content: [{
        type: "text",
        text: [
          `Gaea launched successfully.`,
          `File: ${terrainPath}`,
          `PID: ${pid}`,
          ``,
          `Note: Gaea does not auto-reload open files. If this file was already open, close and reopen it to see the latest changes.`,
        ].join("\n")
      }]
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { content: [{ type: "text", text: `Failed to open in Gaea: ${message}` }], isError: true };
  }
};

registerTool(
  {
    name: "open_in_gaea",
    description:
      `Open a .terrain file in the Gaea editor. Call this after writing changes to a terrain file so the user can see the updated graph.

Gaea does not auto-reload files that are already open — the user will need to close and reopen the file if it was already loaded.
This tool launches Gaea.exe with the terrain file as an argument.`,
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute path to the .terrain file (uses currently loaded terrain if omitted)" }
      }
    }
  },
  openInGaeaTool
);
```

- [ ] **Step 4: Run tests — all 4 must pass**

```bash
cd packages/gaea && npm test tests/tools/open-in-gaea.test.ts -- --reporter=verbose 2>&1 | tail -12
```
Expected: 4/4 passing.

- [ ] **Step 5: Commit**

```bash
git add packages/gaea/src/tools/open-in-gaea.ts tests/tools/open-in-gaea.test.ts
git commit -m "feat(gaea): add open_in_gaea MCP tool"
```

---

## Task 9: Template variable contracts + buildTerrainFile variable injection

**Files:**
- Modify: `packages/gaea/src/templates/mountains.ts`
- Modify: `packages/gaea/src/templates/desert.ts`
- Modify: `packages/gaea/src/templates/tropical.ts`
- Modify: `packages/gaea/src/templates/volcanic.ts`
- Modify: `packages/gaea/src/templates/index.ts`
- Modify: `packages/gaea/src/swarmhost.ts` (update `createGraph` to accept + inject variables)

- [ ] **Step 1: Write the failing test**

```ts
// tests/templates.test.ts — add to existing file
import { getTemplate, listTemplates, getTemplateVariables } from "../src/templates/index.js";

describe("template variable contracts", () => {
  it("listTemplates includes variables for all templates", () => {
    const templates = listTemplates();
    for (const t of templates) {
      expect(t.variables, `${t.name} is missing variables contract`).toBeDefined();
      expect(Object.keys(t.variables!).length).toBeGreaterThan(0);
    }
  });

  it("mountains contract has Seed, Scale, ErosionStrength", () => {
    const templates = listTemplates();
    const mountains = templates.find(t => t.name === "mountains")!;
    expect(mountains.variables!.Seed.type).toBe("Int");
    expect(mountains.variables!.Scale.type).toBe("Float");
    expect(mountains.variables!.ErosionStrength.type).toBe("Float");
  });

  it("getTemplateVariables returns contract for a named template", () => {
    const vars = getTemplateVariables("desert");
    expect(vars).toBeDefined();
    expect(vars!.Seed).toBeDefined();
  });

  it("getTemplateVariables returns null for unknown template", () => {
    expect(getTemplateVariables("nonexistent")).toBeNull();
  });
});
```

- [ ] **Step 2: Run to confirm failure**

```bash
cd packages/gaea && npm test tests/templates.test.ts 2>&1 | tail -10
```
Expected: `getTemplateVariables` not exported, `variables` undefined on templates.

- [ ] **Step 3: Add `variables` export to all 4 templates**

**`packages/gaea/src/templates/mountains.ts`** — add after `meta`:

```ts
import type { TemplateVariableContract } from "../types.js";

export const variables: TemplateVariableContract = {
  Seed:            { type: "Int",   default: 0,    min: 0,    max: 9999, description: "Random seed for generation" },
  Scale:           { type: "Float", default: 1.5,  min: 0.5,  max: 4.0,  description: "Overall terrain scale" },
  Height:          { type: "Float", default: 0.8,  min: 0.1,  max: 1.0,  description: "Peak height multiplier" },
  ErosionStrength: { type: "Float", default: 0.7,  min: 0.0,  max: 1.0,  description: "Erosion downcutting intensity" },
};
```

Update `meta` to include variables reference:
```ts
export const meta = {
  name: "mountains",
  description: "Dramatic mountain range with snow-capped peaks and deep erosion valleys",
  tweakable: ["Seed", "Scale", "Height", "ErosionStrength"],
  get variables() { return variables; }
};
```

Update `build()` to use `ErosionStrength` → maps to `Downcutting`:
```ts
export function build(overrides: Record<string, unknown> = {}): Graph {
  const seed = (overrides.Seed as number) ?? 0;
  const downcutting = (overrides.ErosionStrength as number) ?? 0.7;
  return {
    nodes: [
      { id: "peaks", type: "Mountain", params: { Seed: seed, Scale: (overrides.Scale as number) ?? 1.5, Height: (overrides.Height as number) ?? 0.8 } },
      { id: "rugged", type: "Rugged", params: { Seed: seed } },
      { id: "erode", type: "Erosion2", params: { Downcutting: downcutting, ErosionScale: 800, Seed: seed } },
      { id: "level", type: "Autolevel", params: {} }
    ],
    edges: [
      { from: "peaks", fromPort: "Out", to: "rugged", toPort: "In" },
      { from: "rugged", fromPort: "Out", to: "erode", toPort: "In" },
      { from: "erode", fromPort: "Out", to: "level", toPort: "In" }
    ]
  };
}
```

**`packages/gaea/src/templates/desert.ts`** — add after imports:

```ts
import type { TemplateVariableContract } from "../types.js";

export const variables: TemplateVariableContract = {
  Seed:            { type: "Int",   default: 0,   min: 0,   max: 9999, description: "Random seed" },
  Scale:           { type: "Float", default: 2.5, min: 0.5, max: 5.0,  description: "Dune scale" },
  ErosionStrength: { type: "Float", default: 0.2, min: 0.0, max: 1.0,  description: "Wind erosion strength" },
};
```

Update `meta`:
```ts
export const meta = {
  name: "desert",
  description: "Arid desert with sand dunes and wind-carved ridges",
  tweakable: ["Seed", "Scale", "ErosionStrength"],
  get variables() { return variables; }
};
```

Update `build()` to use `ErosionStrength`:
```ts
export function build(overrides: Record<string, unknown> = {}): Graph {
  const seed = (overrides.Seed as number) ?? 0;
  const scale = (overrides.Scale as number) ?? 2.5;
  const downcutting = (overrides.ErosionStrength as number) ?? 0.2;
  return {
    nodes: [
      { id: "base", type: "Perlin", params: { Seed: seed, Scale: scale, Octaves: 6 } },
      { id: "dunes", type: "Perlin", params: { Seed: seed + 1, Scale: 5.0, Octaves: 3 } },
      { id: "blend", type: "Combine", params: { Ratio: 0.3, Mode: "Add" } },
      { id: "erode", type: "Erosion2", params: { Downcutting: downcutting, ErosionScale: 200, Seed: seed } },
      { id: "final", type: "Autolevel", params: {} }
    ],
    edges: [
      { from: "base", fromPort: "Out", to: "blend", toPort: "In" },
      { from: "dunes", fromPort: "Out", to: "blend", toPort: "Input2" },
      { from: "blend", fromPort: "Out", to: "erode", toPort: "In" },
      { from: "erode", fromPort: "Out", to: "final", toPort: "In" }
    ]
  };
}
```

**`packages/gaea/src/templates/tropical.ts`** — add after imports:

```ts
import type { TemplateVariableContract } from "../types.js";

export const variables: TemplateVariableContract = {
  Seed:            { type: "Int",   default: 0,    min: 0,    max: 9999, description: "Random seed" },
  Scale:           { type: "Float", default: 1.0,  min: 0.5,  max: 3.0,  description: "Mountain scale" },
  Height:          { type: "Float", default: 0.6,  min: 0.1,  max: 1.0,  description: "Peak height" },
  TerraceSpacing:  { type: "Float", default: 0.15, min: 0.05, max: 0.5,  description: "Terrace spacing" },
  ErosionStrength: { type: "Float", default: 0.6,  min: 0.0,  max: 1.0,  description: "Monsoon erosion strength" },
};
```

Update `meta`:
```ts
export const meta = {
  name: "tropical",
  description: "Lush tropical valley with monsoon erosion and terraced hillsides",
  tweakable: ["Seed", "Scale", "Height", "TerraceSpacing", "ErosionStrength"],
  get variables() { return variables; }
};
```

Update `build()`:
```ts
export function build(overrides: Record<string, unknown> = {}): Graph {
  const seed = (overrides.Seed as number) ?? 0;
  return {
    nodes: [
      { id: "base",     type: "Mountain",       params: { Seed: seed, Scale: (overrides.Scale as number) ?? 1.0, Height: (overrides.Height as number) ?? 0.6 } },
      { id: "terraces", type: "FractalTerraces", params: { Spacing: (overrides.TerraceSpacing as number) ?? 0.15, Intensity: 0.4, Seed: seed } },
      { id: "erode",    type: "Erosion2",        params: { Downcutting: (overrides.ErosionStrength as number) ?? 0.6, ErosionScale: 600, Seed: seed } },
      { id: "level",    type: "Autolevel",       params: {} }
    ],
    edges: [
      { from: "base",     fromPort: "Out", to: "terraces", toPort: "In" },
      { from: "terraces", fromPort: "Out", to: "erode",    toPort: "In" },
      { from: "erode",    fromPort: "Out", to: "level",    toPort: "In" }
    ]
  };
}
```

**`packages/gaea/src/templates/volcanic.ts`** — add after imports:

```ts
import type { TemplateVariableContract } from "../types.js";

export const variables: TemplateVariableContract = {
  Seed:            { type: "Int",   default: 0,   min: 0,   max: 9999, description: "Random seed" },
  Scale:           { type: "Float", default: 0.8, min: 0.3, max: 2.0,  description: "Cone scale" },
  Height:          { type: "Float", default: 0.9, min: 0.3, max: 1.0,  description: "Peak height" },
  ErosionStrength: { type: "Float", default: 0.4, min: 0.0, max: 1.0,  description: "Lava channel erosion" },
};
```

Update `meta`:
```ts
export const meta = {
  name: "volcanic",
  description: "Volcanic landscape with sharp peaks, lava flow channels, and rugged terrain",
  tweakable: ["Seed", "Scale", "Height", "ErosionStrength"],
  get variables() { return variables; }
};
```

Update `build()`:
```ts
export function build(overrides: Record<string, unknown> = {}): Graph {
  const seed = (overrides.Seed as number) ?? 0;
  return {
    nodes: [
      { id: "cone",   type: "Mountain",  params: { Seed: seed, Scale: (overrides.Scale as number) ?? 0.8, Height: (overrides.Height as number) ?? 0.9 } },
      { id: "noise",  type: "Perlin",    params: { Seed: seed + 1, Scale: 3.0, Octaves: 10 } },
      { id: "blend",  type: "Combine",   params: { Ratio: 0.2, Mode: "Add" } },
      { id: "rugged", type: "Rugged",    params: { Seed: seed } },
      { id: "erode",  type: "Erosion2",  params: { Downcutting: (overrides.ErosionStrength as number) ?? 0.4, ErosionScale: 400, Seed: seed } },
      { id: "level",  type: "Autolevel", params: {} }
    ],
    edges: [
      { from: "cone",   fromPort: "Out", to: "blend",  toPort: "In" },
      { from: "noise",  fromPort: "Out", to: "blend",  toPort: "Input2" },
      { from: "blend",  fromPort: "Out", to: "rugged", toPort: "In" },
      { from: "rugged", fromPort: "Out", to: "erode",  toPort: "In" },
      { from: "erode",  fromPort: "Out", to: "level",  toPort: "In" }
    ]
  };
}
```

- [ ] **Step 4: Update `templates/index.ts`**

Replace the full file:

```ts
// packages/gaea/src/templates/index.ts
import type { Graph, TemplateMeta, TemplateVariableContract } from "../types.js";
import * as desert from "./desert.js";
import * as mountains from "./mountains.js";
import * as tropical from "./tropical.js";
import * as volcanic from "./volcanic.js";

interface TemplateModule {
  meta: TemplateMeta;
  variables: TemplateVariableContract;
  build: (overrides?: Record<string, unknown>) => Graph;
}

const registry: TemplateModule[] = [desert, mountains, tropical, volcanic];

export function listTemplates(): TemplateMeta[] {
  return registry.map(t => ({ ...t.meta, variables: t.variables }));
}

export function getTemplate(name: string, overrides?: Record<string, unknown>): Graph | null {
  const mod = registry.find(t => t.meta.name === name);
  if (!mod) return null;
  return mod.build(overrides ?? {});
}

export function getTemplateVariables(name: string): TemplateVariableContract | null {
  const mod = registry.find(t => t.meta.name === name);
  return mod?.variables ?? null;
}
```

- [ ] **Step 5: Run tests — all template tests must pass**

```bash
cd packages/gaea && npm test tests/templates.test.ts -- --reporter=verbose 2>&1 | tail -15
```
Expected: all 8+ tests passing including the 4 new contract tests.

- [ ] **Step 6: Run full suite**

```bash
cd packages/gaea && npm test 2>&1 | grep -E "Tests|passed|failed"
```
Expected: 65+ passing, same 2 pre-existing failures.

- [ ] **Step 7: Commit**

```bash
git add packages/gaea/src/templates/ packages/gaea/tests/templates.test.ts
git commit -m "feat(gaea): add variable contracts to all 4 templates"
```

---

## Task 10: Register all 4 new tools in tools/index.ts

**Files:**
- Modify: `packages/gaea/src/tools/index.ts`

The existing `tools/index.ts` doesn't import tool files — tools self-register via `registerTool()` when imported. The main entry point (`index.ts`) must import the tool modules to trigger registration.

- [ ] **Step 1: Check current main entry**

```bash
grep -n "import.*tools" packages/gaea/src/index.ts
```

Note which tool files are already imported.

- [ ] **Step 2: Add 4 new tool imports**

Find the block of tool imports in `packages/gaea/src/index.ts` (or wherever `open-session.ts`, `cook-graph.ts` etc. are imported) and add:

```ts
import "./tools/bake-terrain.js";
import "./tools/read-terrain-variables.js";
import "./tools/set-terrain-variables.js";
import "./tools/open-in-gaea.js";
```

- [ ] **Step 3: Verify all 4 tools appear in registration**

```bash
cd packages/gaea && node -e "
import('./src/index.js').then(m => {
  const defs = m.getToolDefinitions ? m.getToolDefinitions() : [];
  console.log(defs.map(d => d.name).join('\n'));
})
" 2>&1 | grep -E "bake|read_terrain|set_terrain|open_in"
```
Expected: all 4 tool names printed.

- [ ] **Step 4: Run full suite — no regressions**

```bash
cd packages/gaea && npm test 2>&1 | grep -E "Tests|passed|failed"
```
Expected: same passing count, same 2 pre-existing failures.

- [ ] **Step 5: Commit**

```bash
git add packages/gaea/src/index.ts
git commit -m "feat(gaea): register bake_terrain, read/set_terrain_variables, open_in_gaea tools"
```

---

## Task 11: Build + verify

**Files:** None new — compilation check only.

- [ ] **Step 1: TypeScript compile**

```bash
cd packages/gaea && npm run build 2>&1 | tail -10
```
Expected: exits 0 with no errors.

- [ ] **Step 2: Final full test run**

```bash
cd packages/gaea && npm test 2>&1 | grep -E "Tests|passed|failed|✓|×"
```
Expected: 65+ passing, 2 pre-existing failures (swarmhost-mutations), 0 new failures.

- [ ] **Step 3: Commit if any build artifacts tracked**

```bash
git status --short packages/gaea/
```
If there are build artifacts to commit (unlikely — dist is gitignored):
```bash
git add packages/gaea/dist/
git commit -m "chore(gaea): update build artifacts"
```

- [ ] **Step 4: Final status**

```bash
git log --oneline -10
```
Expected: 10 new commits on `feature/gaea-pipeline-rework` branch.
