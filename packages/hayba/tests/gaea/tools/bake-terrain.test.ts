import { describe, it, expect, vi, beforeEach } from "vitest";
import { bakeTerrain } from '../../../src/tools/hayba-bake-terrain.js';
import type { SessionManager } from '../../../src/gaea/session.js';

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
