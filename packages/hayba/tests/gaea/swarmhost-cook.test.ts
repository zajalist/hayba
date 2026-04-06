import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as cp from "child_process";
import * as gaeaLauncher from '../../src/gaea/gaea-launcher.js';

vi.mock("child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("child_process")>();
  return { ...actual };
});
import { SwarmHostClient } from '../../src/gaea/swarmhost.js';
import { mkdirSync, writeFileSync, rmSync } from "fs";
import path from "path";
import os from "os";

const TMP = path.join(os.tmpdir(), "gaea-cook-test");
const TERRAIN = path.join(TMP, "test.terrain");

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

  it("injects -v flags for each variable and -v comes after -ignorecache", () => {
    vi.spyOn(gaeaLauncher, "detectSwarmPath").mockReturnValue("C:\\fake\\Gaea.Swarm.exe");
    const spawnSpy = vi.spyOn(cp, "spawnSync").mockReturnValue({
      status: 0, stdout: "", stderr: "", error: undefined, pid: 1, output: [], signal: null
    } as any);

    const client = new SwarmHostClient({ execPath: "", port: 0, outputDir: TMP, swarmExePath: "C:\\fake\\Gaea.Swarm.exe" });
    (client as any)._currentTerrainPath = TERRAIN;

    return client.cook(undefined, { Seed: 42, Scale: 2.0 }).then(() => {
      const args: string[] = spawnSpy.mock.calls[0][1] as string[];
      expect(args).toContain("-v");
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
