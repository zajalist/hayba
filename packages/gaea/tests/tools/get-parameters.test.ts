import { describe, it, expect, vi, beforeEach } from "vitest";
import { getParametersHandler } from "../../src/tools/get-parameters.js";
import type { SessionManager } from "../../src/session.js";

const mockSession = {
  client: {
    getParameters: vi.fn().mockResolvedValue([
      { name: "Height", type: "float", min: 0, max: 1, default: 0.5 },
      { name: "Scale", type: "float", min: 0.1, max: 10, default: 1.0 }
    ])
  },
  enqueue: vi.fn((fn: () => Promise<unknown>) => fn())
} as unknown as SessionManager;

describe("get_parameters", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns formatted parameter list for a node", async () => {
    const result = await getParametersHandler({ node_id: "mountain_01" }, mockSession);
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain("Height");
    expect(result.content[0].text).toContain("0 - 1");
  });

  it("returns error when node_id is missing", async () => {
    const result = await getParametersHandler({}, mockSession);
    expect(result.isError).toBe(true);
  });

  it("handles node with no editable parameters", async () => {
    (mockSession.client.getParameters as ReturnType<typeof vi.fn>).mockResolvedValueOnce([]);
    const result = await getParametersHandler({ node_id: "output_01" }, mockSession);
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain("no editable parameters");
  });
});
