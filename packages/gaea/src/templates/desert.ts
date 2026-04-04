import type { Graph } from "../types.js";

export const meta = {
  name: "desert",
  description: "Arid desert with sand dunes and wind-carved ridges",
  tweakable: ["Seed", "Scale", "Height", "Downcutting"]
};

export function build(overrides: Record<string, unknown> = {}): Graph {
  const seed = (overrides.Seed as number) ?? 0;
  return {
    nodes: [
      { id: "base", type: "Perlin", params: { Seed: seed, Scale: 2.5, Octaves: 6, ...pick(overrides, ["Scale", "Octaves"]) } },
      { id: "dunes", type: "Perlin", params: { Seed: seed + 1, Scale: 5.0, Octaves: 3 } },
      { id: "blend", type: "Combine", params: { Ratio: 0.3, Mode: "Add" } },
      { id: "erode", type: "Erosion2", params: { Downcutting: 0.2, ErosionScale: 200, Seed: seed, ...pick(overrides, ["Downcutting", "ErosionScale"]) } },
      { id: "final", type: "Autolevel", params: {} }
    ],
    edges: [
      { from: "base", fromPort: "Out", to: "blend", toPort: "In" },
      { from: "dunes", fromPort: "Out", to: "blend", toPort: "Input2" },
      { from: "blend", fromPort: "Out", to: "erode", toPort: "In" },
      { from: "erode", fromPort: "Out", to: "final", toPort: "In" }
    ]
  };
}

function pick(obj: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const k of keys) { if (k in obj) result[k] = obj[k]; }
  return result;
}
