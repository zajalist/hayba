import { describe, it, expect, vi, beforeEach } from "vitest";
import { createTerrainHandler } from "../../src/tools/create-terrain.js";
import type { SessionManager } from "../../src/session.js";

const testGraph = {
  nodes: [
    { id: "mountain_01", type: "Mountain", params: { Height: 0.7 } },
    { id: "output_01", type: "Output", params: {} }
  ],
  edges: [
    { from: "mountain_01", fromPort: "Primary", to: "output_01", toPort: "Primary" }
  ]
};

const mockSession = {
  client: {
    listNodeTypes: vi.fn().mockResolvedValue([
      { type: "Mountain", category: "primitives", parameters: [], inputs: [], outputs: ["Primary"] },
      { type: "Output", category: "output", parameters: [], inputs: ["Primary"], outputs: [] }
    ]),
    createGraph: vi.fn().mockResolvedValue(undefined),
    cook: vi.fn().mockResolvedValue(undefined),
    export: vi.fn().mockResolvedValue({ heightmap: "C:\\tmp\\heightmap.exr" })
  },
  enqueue: vi.fn((fn: () => Promise<unknown>) => fn()),
  setTerrainPath: vi.fn(),
  outputDir: "C:\\tmp"
} as unknown as SessionManager;

describe("create_terrain", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns heightmap path on success when graph is provided", async () => {
    const result = await createTerrainHandler(
      { prompt: "alpine mountain", graph: testGraph },
      mockSession
    );
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain("heightmap");
  });

  it("calls createGraph, cook, and export when graph is provided", async () => {
    await createTerrainHandler({ prompt: "alpine mountain", graph: testGraph }, mockSession);
    expect(mockSession.client.createGraph).toHaveBeenCalledTimes(1);
    expect(mockSession.client.cook).toHaveBeenCalledTimes(1);
    expect(mockSession.client.export).toHaveBeenCalledTimes(1);
  });

  it("returns node catalog when no graph is provided", async () => {
    const result = await createTerrainHandler({ prompt: "alpine mountain" }, mockSession);
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain("No graph provided");
    expect(result.content[0].text).toContain("Mountain");
    expect(mockSession.client.createGraph).not.toHaveBeenCalled();
  });

  it("returns error when prompt is missing", async () => {
    const result = await createTerrainHandler({}, mockSession);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("prompt");
  });
});
