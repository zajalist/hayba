import { describe, it, expect, afterEach } from "vitest";
import { writeFileSync, unlinkSync, readFileSync } from "fs";
import path from "path";
import os from "os";
import { SwarmHostClient } from '../../src/gaea/swarmhost.js';

const TMP = path.join(os.tmpdir(), "gaea-mcp-test.terrain");

const BLANK_TERRAIN = JSON.stringify({
  Assets: [{
    Terrain: {
      Id: "test-id",
      Metadata: {},
      Nodes: {},
      Groups: {}, Notes: {}, GraphTabs: [], Width: 4096, Height: 4096, Ratio: 1, Regions: []
    },
    Automation: { Bindings: [], Expressions: {}, Variables: {} },
    BuildDefinition: {
      Type: "Standard", Destination: os.tmpdir(), Resolution: 1024,
      BakeResolution: 1024, TileResolution: 1024, BucketResolution: 1024,
      NumberOfTiles: 1, EdgeBlending: 0, TileZeroIndex: false,
      TilePattern: "", OrganizeFiles: "", PostBuildScript: "", ColorSpace: "Linear"
    },
    State: {}, BuildProfiles: {}
  }],
  Id: "root-id", Branch: 0, Metadata: {}
});

function makeClient(): SwarmHostClient {
  writeFileSync(TMP, BLANK_TERRAIN);
  const client = new SwarmHostClient({ execPath: "fake", port: 0, outputDir: os.tmpdir() });
  client["_currentTerrainPath"] = TMP;
  return client;
}

function readNodes(): Record<string, unknown> {
  const t = JSON.parse(readFileSync(TMP, "utf-8"));
  return t.Assets[0].Terrain.Nodes;
}

afterEach(() => { try { unlinkSync(TMP); } catch {} });

describe("SwarmHostClient.addNode", () => {
  it("adds a node to the terrain file", async () => {
    const client = makeClient();
    await client.addNode("Mountain", "peaks", { Seed: 42 });
    const nodes = readNodes();
    const node = Object.values(nodes)[0] as Record<string, unknown>;
    expect(node.Name).toBe("peaks");
    expect(node.$type).toBe("QuadSpinner.Gaea.Nodes.Mountain, Gaea.Nodes");
    expect(node.Seed).toBe(42);
  });

  it("assigns incrementing integer IDs", async () => {
    const client = makeClient();
    await client.addNode("Mountain", "a", {});
    await client.addNode("Erosion2", "b", {});
    const nodes = readNodes();
    const ids = Object.values(nodes).map((n: unknown) => (n as Record<string, unknown>).Id as number);
    expect(ids[0]).toBeLessThan(ids[1]);
  });

  it("auto-places node to the right of existing nodes", async () => {
    const client = makeClient();
    await client.addNode("Mountain", "a", {}, { X: 1000, Y: 500 });
    await client.addNode("Erosion2", "b", {});
    const nodes = readNodes();
    const vals = Object.values(nodes) as Array<{ Position: { X: number } }>;
    expect(vals[1].Position.X).toBeGreaterThan(vals[0].Position.X);
  });
});

describe("SwarmHostClient.connectNodes", () => {
  it("adds a Record to the target port", async () => {
    const client = makeClient();
    await client.addNode("Mountain", "src", {});
    await client.addNode("Erosion2", "dst", {});
    await client.connectNodes("src", "Out", "dst", "In");
    const nodes = readNodes();
    const dst = Object.values(nodes).find((n: unknown) => (n as { Name: string }).Name === "dst") as Record<string, unknown>;
    const ports = dst.Ports as Array<{ Name: string; Record?: { From: number } }>;
    const inPort = ports.find(p => p.Name === "In");
    expect(inPort?.Record).toBeDefined();
    expect(typeof inPort?.Record?.From).toBe("number");
  });
});

describe("SwarmHostClient.removeNode", () => {
  it("removes node and clears referencing connections", async () => {
    const client = makeClient();
    await client.addNode("Mountain", "src", {});
    await client.addNode("Erosion2", "dst", {});
    await client.connectNodes("src", "Out", "dst", "In");
    await client.removeNode("src");
    const nodes = readNodes();
    const names = Object.values(nodes).map((n: unknown) => (n as { Name: string }).Name);
    expect(names).not.toContain("src");
    const dst = Object.values(nodes).find((n: unknown) => (n as { Name: string }).Name === "dst") as Record<string, unknown>;
    const ports = dst.Ports as Array<{ Record?: unknown }>;
    expect(ports.every(p => !p.Record)).toBe(true);
  });
});
