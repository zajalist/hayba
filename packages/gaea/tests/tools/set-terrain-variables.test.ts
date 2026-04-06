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
