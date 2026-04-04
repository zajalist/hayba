import { describe, it, expect, vi, beforeEach } from "vitest";
import { cookGraphHandler } from "../../src/tools/cook-graph.js";
import type { SessionManager } from "../../src/session.js";

const mockSession = {
  client: {
    cook: vi.fn().mockResolvedValue(undefined),
    export: vi.fn().mockResolvedValue({ heightmap: "C:\\tmp\\heightmap.exr", normalmap: "C:\\tmp\\normal.exr" })
  },
  enqueue: vi.fn((fn: () => Promise<unknown>) => fn()),
  outputDir: "C:\\tmp"
} as unknown as SessionManager;

describe("cook_graph", () => {
  beforeEach(() => vi.clearAllMocks());

  it("cooks and returns updated file paths", async () => {
    const result = await cookGraphHandler({}, mockSession);
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain("heightmap");
    expect(mockSession.client.cook).toHaveBeenCalledWith(undefined);
  });

  it("passes node list for partial re-cook", async () => {
    await cookGraphHandler({ nodes: ["erosion_01", "output_01"] }, mockSession);
    expect(mockSession.client.cook).toHaveBeenCalledWith(["erosion_01", "output_01"]);
  });

  it("returns error when nodes is not an array", async () => {
    const result = await cookGraphHandler({ nodes: "erosion_01" }, mockSession);
    expect(result.isError).toBe(true);
  });
});
