import { describe, it, expect, vi, beforeEach } from "vitest";
import { setParameterHandler } from "../../src/tools/set-parameter.js";
import type { SessionManager } from "../../src/session.js";

const mockSession = {
  client: {
    setParameter: vi.fn().mockResolvedValue(undefined)
  },
  enqueue: vi.fn((fn: () => Promise<unknown>) => fn())
} as unknown as SessionManager;

describe("set_parameter", () => {
  beforeEach(() => vi.clearAllMocks());

  it("calls setParameter and confirms success", async () => {
    const result = await setParameterHandler(
      { node_id: "erosion_01", parameter: "Duration", value: 0.8 },
      mockSession
    );
    expect(result.isError).toBeFalsy();
    expect(mockSession.client.setParameter).toHaveBeenCalledWith("erosion_01", "Duration", 0.8);
    expect(result.content[0].text).toContain("dirty");
  });

  it("returns error when required args are missing", async () => {
    const result = await setParameterHandler({ node_id: "erosion_01" }, mockSession);
    expect(result.isError).toBe(true);
  });

  it("returns error when value is null or an object", async () => {
    const result = await setParameterHandler(
      { node_id: "erosion_01", parameter: "Duration", value: null },
      mockSession
    );
    expect(result.isError).toBe(true);
  });
});
