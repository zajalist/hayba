import type { Graph } from "../types.js";

export const meta = {
  name: "volcanic",
  description: "Volcanic landscape with sharp peaks, lava flow channels, and rugged terrain",
  tweakable: ["Seed", "Scale", "Height", "Downcutting"]
};

export function build(overrides: Record<string, unknown> = {}): Graph {
  const seed = (overrides.Seed as number) ?? 0;
  return {
    nodes: [
      { id: "cone", type: "Mountain", params: { Seed: seed, Scale: 0.8, Height: 0.9, ...pick(overrides, ["Scale", "Height"]) } },
      { id: "noise", type: "Perlin", params: { Seed: seed + 1, Scale: 3.0, Octaves: 10 } },
      { id: "blend", type: "Combine", params: { Ratio: 0.2, Mode: "Add" } },
      { id: "rugged", type: "Rugged", params: { Seed: seed } },
      { id: "erode", type: "Erosion2", params: { Downcutting: 0.4, ErosionScale: 400, Seed: seed, ...pick(overrides, ["Downcutting", "ErosionScale"]) } },
      { id: "level", type: "Autolevel", params: {} }
    ],
    edges: [
      { from: "cone", fromPort: "Out", to: "blend", toPort: "In" },
      { from: "noise", fromPort: "Out", to: "blend", toPort: "Input2" },
      { from: "blend", fromPort: "Out", to: "rugged", toPort: "In" },
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
