import { describe, it, expect, vi, afterEach } from "vitest";
import * as gaeaLauncher from "../../src/gaea-launcher.js";
import { openInGaeaTool } from "../../src/tools/open-in-gaea.js";
import type { SessionManager } from "../../src/session.js";

const mockSession = {
  terrainPath: "C:\\tmp\\test.terrain",
  gaeaExePath: "C:\\fake\\Gaea.exe",
} as unknown as SessionManager;

afterEach(() => vi.restoreAllMocks());

describe("open_in_gaea tool", () => {
  it("calls launchGaea with the provided path", async () => {
    const launchSpy = vi.spyOn(gaeaLauncher, "launchGaea").mockReturnValue(1234);
    const result = await openInGaeaTool({ path: "C:\\tmp\\test.terrain" }, mockSession);
    expect(result.isError).toBeFalsy();
    expect(launchSpy).toHaveBeenCalledWith(expect.any(String), "C:\\tmp\\test.terrain");
    expect(result.content[0].text).toContain("launched");
  });

  it("uses session terrainPath when no path provided", async () => {
    const launchSpy = vi.spyOn(gaeaLauncher, "launchGaea").mockReturnValue(5678);
    await openInGaeaTool({}, mockSession);
    expect(launchSpy).toHaveBeenCalledWith(expect.any(String), "C:\\tmp\\test.terrain");
  });

  it("returns error when no terrain path available", async () => {
    const noPathSession = { ...mockSession, terrainPath: null } as unknown as SessionManager;
    const result = await openInGaeaTool({}, noPathSession);
    expect(result.isError).toBe(true);
  });

  it("returns error when launchGaea throws", async () => {
    vi.spyOn(gaeaLauncher, "launchGaea").mockImplementation(() => { throw new Error("Gaea.exe not found"); });
    const result = await openInGaeaTool({ path: "C:\\tmp\\test.terrain" }, mockSession);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Gaea.exe not found");
  });
});
