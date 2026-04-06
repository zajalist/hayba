import type { Graph, TemplateVariableContract } from "../types.js";

export const variables: TemplateVariableContract = {
  Seed:            { type: "Int",   default: 0,   min: 0,   max: 9999, description: "Random seed for generation" },
  Scale:           { type: "Float", default: 1.5, min: 0.5, max: 4.0,  description: "Overall terrain scale" },
  Height:          { type: "Float", default: 0.8, min: 0.1, max: 1.0,  description: "Peak height multiplier" },
  ErosionStrength: { type: "Float", default: 0.7, min: 0.0, max: 1.0,  description: "Erosion downcutting intensity" },
};

export const meta = {
  name: "mountains",
  description: "Dramatic mountain range with snow-capped peaks and deep erosion valleys",
  tweakable: ["Seed", "Scale", "Height", "Downcutting"],
  variables,
};

export function build(overrides: Record<string, unknown> = {}): Graph {
  const seed = (overrides.Seed as number) ?? 0;
  const downcutting = (overrides.ErosionStrength as number) ?? 0.7;
  return {
    nodes: [
      { id: "peaks", type: "Mountain", params: { Seed: seed, Scale: (overrides.Scale as number) ?? 1.5, Height: (overrides.Height as number) ?? 0.8 } },
      { id: "rugged", type: "Rugged", params: { Seed: seed } },
      { id: "erode", type: "Erosion2", params: { Downcutting: downcutting, ErosionScale: 800, Seed: seed } },
      { id: "level", type: "Autolevel", params: {} }
    ],
    edges: [
      { from: "peaks", fromPort: "Out", to: "rugged", toPort: "In" },
      { from: "rugged", fromPort: "Out", to: "erode", toPort: "In" },
      { from: "erode", fromPort: "Out", to: "level", toPort: "In" }
    ]
  };
}
