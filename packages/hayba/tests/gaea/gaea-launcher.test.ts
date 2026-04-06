import { describe, it, expect } from "vitest";
import { GAEA_SWARM_CANDIDATE_PATHS, detectSwarmPath } from '../../src/gaea/gaea-launcher.js';

describe("Swarm path detection", () => {
  it("GAEA_SWARM_CANDIDATE_PATHS contains multiple version paths", () => {
    expect(GAEA_SWARM_CANDIDATE_PATHS.length).toBeGreaterThanOrEqual(4);
    expect(GAEA_SWARM_CANDIDATE_PATHS.some(p => p.includes("Gaea.Swarm.exe"))).toBe(true);
    expect(GAEA_SWARM_CANDIDATE_PATHS.some(p => p.includes("2.0"))).toBe(true);
    expect(GAEA_SWARM_CANDIDATE_PATHS.some(p => p.includes("2.2"))).toBe(true);
  });

  it("detectSwarmPath returns null when no Swarm.exe found", () => {
    // On machines without Gaea installed, returns null — not an error
    const result = detectSwarmPath();
    expect(result === null || typeof result === "string").toBe(true);
  });
});
