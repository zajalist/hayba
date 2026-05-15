import { describe, it, expect } from "vitest";
import { GraphSchema, NodeSchema, EdgeSchema } from '../../src/gaea/types.js';
import type { TemplateMeta, TemplateVariableContract } from '../../src/gaea/types.js';

describe("GraphSchema", () => {
  it("accepts a valid minimal graph", () => {
    const result = GraphSchema.safeParse({
      nodes: [
        { id: "mountain_01", type: "Mountain", params: { Height: 0.7 } },
        { id: "output_01", type: "Output", params: {} }
      ],
      edges: [
        { from: "mountain_01", fromPort: "Primary", to: "output_01", toPort: "Primary" }
      ]
    });
    expect(result.success).toBe(true);
  });

  it("rejects a graph with no nodes", () => {
    const result = GraphSchema.safeParse({ nodes: [], edges: [] });
    expect(result.success).toBe(false);
  });

  it("rejects an edge referencing unknown node ids", () => {
    const result = GraphSchema.safeParse({
      nodes: [{ id: "a", type: "Mountain", params: {} }],
      edges: [{ from: "nonexistent", fromPort: "Primary", to: "a", toPort: "Primary" }]
    });
    expect(result.success).toBe(false);
  });

  it("rejects a graph with duplicate node ids", () => {
    const result = GraphSchema.safeParse({
      nodes: [
        { id: "a", type: "Mountain", params: {} },
        { id: "a", type: "Erosion", params: {} }
      ],
      edges: []
    });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error)).toContain("duplicate");
  });

  it("accepts a valid graph with zero edges", () => {
    const result = GraphSchema.safeParse({
      nodes: [{ id: "output_01", type: "Output", params: {} }],
      edges: []
    });
    expect(result.success).toBe(true);
  });
});

describe("GraphSchema circular edge detection", () => {
  it("rejects a direct self-loop", () => {
    const graph = {
      nodes: [{ id: "a", type: "Mountain" }],
      edges: [{ from: "a", fromPort: "Out", to: "a", toPort: "In" }]
    };
    const result = GraphSchema.safeParse(graph);
    expect(result.success).toBe(false);
    expect(result.error!.message).toContain("circular");
  });

  it("rejects a two-node cycle", () => {
    const graph = {
      nodes: [
        { id: "a", type: "Mountain" },
        { id: "b", type: "Erosion2" }
      ],
      edges: [
        { from: "a", fromPort: "Out", to: "b", toPort: "In" },
        { from: "b", fromPort: "Out", to: "a", toPort: "In" }
      ]
    };
    const result = GraphSchema.safeParse(graph);
    expect(result.success).toBe(false);
    expect(result.error!.message).toContain("circular");
  });

  it("accepts a valid DAG", () => {
    const graph = {
      nodes: [
        { id: "a", type: "Mountain" },
        { id: "b", type: "Erosion2" },
        { id: "c", type: "Autolevel" }
      ],
      edges: [
        { from: "a", fromPort: "Out", to: "b", toPort: "In" },
        { from: "b", fromPort: "Out", to: "c", toPort: "In" }
      ]
    };
    const result = GraphSchema.safeParse(graph);
    expect(result.success).toBe(true);
  });
});

describe("TemplateVariableContract and TemplateMeta", () => {
  it("TemplateVariableContract type accepts valid contracts", () => {
    const contract: TemplateVariableContract = {
      Seed: { type: "Int", default: 0, min: 0, max: 9999, description: "Random seed" },
      Scale: { type: "Float", default: 1.5, min: 0.5, max: 4.0, description: "Terrain scale" },
    };
    expect(contract.Seed.type).toBe("Int");
    expect(contract.Scale.default).toBe(1.5);
  });

  it("TemplateMeta accepts optional variables field", () => {
    const meta: TemplateMeta = {
      name: "test",
      description: "test template",
      tweakable: ["Seed"],
      variables: {
        Seed: { type: "Int", default: 0, min: 0, max: 9999, description: "Seed" }
      }
    };
    expect(meta.variables?.Seed.type).toBe("Int");
  });
});
