import { describe, it, expect, vi, beforeEach } from "vitest";
import { listNodeTypesHandler, clearCache } from '../../../src/tools/hayba-list-node-types.js';
import type { SessionManager } from '../../../src/gaea/session.js';

const mockSession = {
  client: {
    listNodeTypes: vi.fn().mockResolvedValue([
      {
        type: "Mountain",
        category: "primitives",
        parameters: [{ name: "Height", type: "float", min: 0, max: 1, default: 0.5 }],
        inputs: [],
        outputs: ["Primary"]
      }
    ])
  },
  enqueue: vi.fn((fn: () => Promise<unknown>) => fn())
} as unknown as SessionManager;

describe("list_node_types", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearCache();
  });

  it("returns formatted node catalog", async () => {
    const result = await listNodeTypesHandler({}, mockSession);
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain("Mountain");
    expect(result.content[0].text).toContain("primitives");
  });

  it("filters by category when provided", async () => {
    await listNodeTypesHandler({ category: "erosion" }, mockSession);
    expect(mockSession.client.listNodeTypes).toHaveBeenCalledWith("erosion");
  });

  it("caches result — only calls SwarmHost once on repeated calls", async () => {
    await listNodeTypesHandler({}, mockSession);
    await listNodeTypesHandler({}, mockSession);
    // second call should not hit SwarmHost again (no category = use cache)
    expect(mockSession.client.listNodeTypes).toHaveBeenCalledTimes(1);
  });
});
