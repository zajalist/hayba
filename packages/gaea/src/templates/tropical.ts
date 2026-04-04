import type { Graph } from "../types.js";

export const meta = {
  name: "tropical",
  description: "Lush tropical valley with monsoon erosion and terraced hillsides",
  tweakable: ["Seed", "Scale", "Height", "Spacing", "Downcutting"]
};

export function build(overrides: Record<string, unknown> = {}): Graph {
  const seed = (overrides.Seed as number) ?? 0;
  return {
    nodes: [
      { id: "base", type: "Mountain", params: { Seed: seed, Scale: 1.0, Height: 0.6, ...pick(overrides, ["Scale", "Height"]) } },
      { id: "terraces", type: "FractalTerraces", params: { Spacing: 0.15, Intensity: 0.4, Seed: seed, ...pick(overrides, ["Spacing", "Intensity"]) } },
      { id: "erode", type: "Erosion2", params: { Downcutting: 0.6, ErosionScale: 600, Seed: seed, ...pick(overrides, ["Downcutting", "ErosionScale"]) } },
      { id: "level", type: "Autolevel", params: {} }
    ],
    edges: [
      { from: "base", fromPort: "Out", to: "terraces", toPort: "In" },
      { from: "terraces", fromPort: "Out", to: "erode", toPort: "In" },
      { from: "erode", fromPort: "Out", to: "level", toPort: "In" }
    ]
  };
}

function pick(obj: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const k of keys) { if (k in obj) result[k] = obj[k]; }
  return result;
}
