import type { Graph, TemplateVariableContract } from "../types.js";

export const variables: TemplateVariableContract = {
  Seed:            { type: "Int",   default: 0,    min: 0,    max: 9999, description: "Random seed" },
  Scale:           { type: "Float", default: 1.0,  min: 0.5,  max: 3.0,  description: "Mountain scale" },
  Height:          { type: "Float", default: 0.6,  min: 0.1,  max: 1.0,  description: "Peak height" },
  TerraceSpacing:  { type: "Float", default: 0.15, min: 0.05, max: 0.5,  description: "Terrace spacing" },
  ErosionStrength: { type: "Float", default: 0.6,  min: 0.0,  max: 1.0,  description: "Monsoon erosion strength" },
};

export const meta = {
  name: "tropical",
  description: "Lush tropical valley with monsoon erosion and terraced hillsides",
  tweakable: ["Seed", "Scale", "Height", "Spacing", "Downcutting"],
  variables,
};

export function build(overrides: Record<string, unknown> = {}): Graph {
  const seed = (overrides.Seed as number) ?? 0;
  return {
    nodes: [
      { id: "base",     type: "Mountain",        params: { Seed: seed, Scale: (overrides.Scale as number) ?? 1.0, Height: (overrides.Height as number) ?? 0.6 } },
      { id: "terraces", type: "FractalTerraces",  params: { Spacing: (overrides.TerraceSpacing as number) ?? 0.15, Intensity: 0.4, Seed: seed } },
      { id: "erode",    type: "Erosion2",         params: { Downcutting: (overrides.ErosionStrength as number) ?? 0.6, ErosionScale: 600, Seed: seed } },
      { id: "level",    type: "Autolevel",        params: {} }
    ],
    edges: [
      { from: "base",     fromPort: "Out", to: "terraces", toPort: "In" },
      { from: "terraces", fromPort: "Out", to: "erode",    toPort: "In" },
      { from: "erode",    fromPort: "Out", to: "level",    toPort: "In" }
    ]
  };
}
