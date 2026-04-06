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

beforeEach(() => { mkdirSync(TMP, { recursive: true }); });
afterEach(() => { rmSync(TMP, { recursive: true, force: true }); });

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

    client.setTerrainVariables(
      { Seed: { type: "Int", default: 0, min: 0, max: 9999, description: "Random seed" } },
      { Seed: 77 }
    );

    const raw = JSON.parse(readFileSync(TERRAIN, "utf-8"));
    const vars = raw.Assets["$values"][0].Automation.Variables;
    expect(vars.Seed).toBeDefined();
    expect(vars.Seed.Value).toBe(77);
  });

  it("reads back what was written", () => {
    writeFileSync(TERRAIN, makeTerrainWithVars({}), "utf-8");
    const client = new SwarmHostClient({ execPath: "", port: 0, outputDir: TMP });
    (client as any)._currentTerrainPath = TERRAIN;

    client.setTerrainVariables(
      { Scale: { type: "Float", default: 1.5, min: 0.5, max: 4.0, description: "Scale" } },
      { Scale: 2.5 }
    );

    const vars = client.readTerrainVariables();
    expect(vars.Scale.Value).toBe(2.5);
  });
});
