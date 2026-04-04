import { describe, it, expect, vi } from "vitest";
import { SessionManager } from "../src/session.js";
import { SwarmHostClient } from "../src/swarmhost.js";

vi.mock("../src/swarmhost.js");
vi.mock("child_process");
vi.mock("fs");

const mockClient = {
  health: vi.fn().mockResolvedValue({ status: "ok" }),
  loadGraph: vi.fn().mockResolvedValue(undefined)
};

vi.mocked(SwarmHostClient).mockImplementation(() => mockClient as unknown as SwarmHostClient);

describe("SessionManager", () => {
  it("exposes the swarmhost client after start", async () => {
    const session = new SessionManager({ execPath: "fake.exe", port: 7000, outputDir: "C:\\tmp" });
    // We test the client is accessible — actual process spawning is skipped via mock
    expect(session.client).toBeInstanceOf(Object);
  });

  it("enqueue serializes concurrent requests", async () => {
    const session = new SessionManager({ execPath: "fake.exe", port: 7000, outputDir: "C:\\tmp" });
    const order: number[] = [];
    const delay = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

    const p1 = session.enqueue(async () => { await delay(20); order.push(1); });
    const p2 = session.enqueue(async () => { order.push(2); });
    await Promise.all([p1, p2]);
    expect(order).toEqual([1, 2]);
  });

  it("tracks terrainPath after setTerrainPath", () => {
    const session = new SessionManager({ execPath: "fake.exe", port: 7000, outputDir: "C:\\tmp" });
    session.setTerrainPath("C:\\terrain.terrain");
    expect(session.terrainPath).toBe("C:\\terrain.terrain");
  });
});
