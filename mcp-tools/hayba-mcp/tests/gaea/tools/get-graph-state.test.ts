import { describe, it, expect, vi, beforeEach } from "vitest";
import { getGraphStateHandler } from '../../../src/tools/hayba-get-graph-state.js';
import type { SessionManager } from '../../../src/gaea/session.js';

const mockSession = {
  client: {
    getGraphState: vi.fn().mockResolvedValue({
      nodes: [
        { id: "mountain_01", type: "Mountain", params: { Height: 0.7 }, cookStatus: "clean" },
        { id: "output_01", type: "Output", params: {}, cookStatus: "clean" }
      ],
      edges: [
        { from: "mountain_01", fromPort: "Primary", to: "output_01", toPort: "Primary" }
      ]
    })
  },
  enqueue: vi.fn((fn: () => Promise<unknown>) => fn())
} as unknown as SessionManager;

describe("get_graph_state", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns a readable summary of nodes and edges", async () => {
    const result = await getGraphStateHandler({}, mockSession);
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain("mountain_01");
    expect(result.content[0].text).toContain("Mountain");
    expect(result.content[0].text).toContain("clean");
    expect(result.content[0].text).toContain("→");
  });

  it("handles empty graph gracefully", async () => {
    (mockSession.client.getGraphState as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      nodes: [],
      edges: []
    });
    const result = await getGraphStateHandler({}, mockSession);
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain("Nodes (0)");
    expect(result.content[0].text).toContain("(no connections)");
  });
});
