import type { Graph } from "../types.js";

export const meta = {
  name: "mountains",
  description: "Dramatic mountain range with snow-capped peaks and deep erosion valleys",
  tweakable: ["Seed", "Scale", "Height", "Downcutting"]
};

export function build(overrides: Record<string, unknown> = {}): Graph {
  const seed = (overrides.Seed as number) ?? 0;
  return {
    nodes: [
      { id: "peaks", type: "Mountain", params: { Seed: seed, Scale: 1.5, Height: 0.8, ...pick(overrides, ["Scale", "Height"]) } },
      { id: "rugged", type: "Rugged", params: { Seed: seed } },
      { id: "erode", type: "Erosion2", params: { Downcutting: 0.7, ErosionScale: 800, Seed: seed, ...pick(overrides, ["Downcutting", "ErosionScale"]) } },
      { id: "level", type: "Autolevel", params: {} }
    ],
    edges: [
      { from: "peaks", fromPort: "Out", to: "rugged", toPort: "In" },
      { from: "rugged", fromPort: "Out", to: "erode", toPort: "In" },
      { from: "erode", fromPort: "Out", to: "level", toPort: "In" }
    ]
  };
}

function pick(obj: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const k of keys) { if (k in obj) result[k] = obj[k]; }
  return result;
}
