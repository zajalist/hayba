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
