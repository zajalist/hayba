import type { Graph, TemplateVariableContract } from "../types.js";

export const variables: TemplateVariableContract = {
  Seed:            { type: "Int",   default: 0,   min: 0,   max: 9999, description: "Random seed" },
  Scale:           { type: "Float", default: 0.8, min: 0.3, max: 2.0,  description: "Cone scale" },
  Height:          { type: "Float", default: 0.9, min: 0.3, max: 1.0,  description: "Peak height" },
  ErosionStrength: { type: "Float", default: 0.4, min: 0.0, max: 1.0,  description: "Lava channel erosion" },
};

export const meta = {
  name: "volcanic",
  description: "Volcanic landscape with sharp peaks, lava flow channels, and rugged terrain",
  tweakable: ["Seed", "Scale", "Height", "Downcutting"],
  variables,
};

export function build(overrides: Record<string, unknown> = {}): Graph {
  const seed = (overrides.Seed as number) ?? 0;
  return {
    nodes: [
      { id: "cone",   type: "Mountain",  params: { Seed: seed, Scale: (overrides.Scale as number) ?? 0.8, Height: (overrides.Height as number) ?? 0.9 } },
      { id: "noise",  type: "Perlin",    params: { Seed: seed + 1, Scale: 3.0, Octaves: 10 } },
      { id: "blend",  type: "Combine",   params: { Ratio: 0.2, Mode: "Add" } },
      { id: "rugged", type: "Rugged",    params: { Seed: seed } },
      { id: "erode",  type: "Erosion2",  params: { Downcutting: (overrides.ErosionStrength as number) ?? 0.4, ErosionScale: 400, Seed: seed } },
      { id: "level",  type: "Autolevel", params: {} }
    ],
    edges: [
      { from: "cone",   fromPort: "Out", to: "blend",  toPort: "In" },
      { from: "noise",  fromPort: "Out", to: "blend",  toPort: "Input2" },
      { from: "blend",  fromPort: "Out", to: "rugged", toPort: "In" },
      { from: "rugged", fromPort: "Out", to: "erode",  toPort: "In" },
      { from: "erode",  fromPort: "Out", to: "level",  toPort: "In" }
    ]
  };
}
