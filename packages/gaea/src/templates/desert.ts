import type { Graph, TemplateVariableContract } from "../types.js";

export const variables: TemplateVariableContract = {
  Seed:            { type: "Int",   default: 0,   min: 0,   max: 9999, description: "Random seed" },
  Scale:           { type: "Float", default: 2.5, min: 0.5, max: 5.0,  description: "Dune scale" },
  ErosionStrength: { type: "Float", default: 0.2, min: 0.0, max: 1.0,  description: "Wind erosion strength" },
};

export const meta = {
  name: "desert",
  description: "Arid desert with sand dunes and wind-carved ridges",
  tweakable: ["Seed", "Scale", "Height", "Downcutting"],
  variables,
};

export function build(overrides: Record<string, unknown> = {}): Graph {
  const seed = (overrides.Seed as number) ?? 0;
  const scale = (overrides.Scale as number) ?? 2.5;
  const downcutting = (overrides.ErosionStrength as number) ?? 0.2;
  return {
    nodes: [
      { id: "base", type: "Perlin", params: { Seed: seed, Scale: scale, Octaves: 6 } },
      { id: "dunes", type: "Perlin", params: { Seed: seed + 1, Scale: 5.0, Octaves: 3 } },
      { id: "blend", type: "Combine", params: { Ratio: 0.3, Mode: "Add" } },
      { id: "erode", type: "Erosion2", params: { Downcutting: downcutting, ErosionScale: 200, Seed: seed } },
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
