import { registerTool, type ToolHandler, type ToolResult } from "./index.js";
import type { SwarmNodeType } from "../types.js";
import type { SessionManager } from "../session.js";

let cache: SwarmNodeType[] | null = null;

// Export for testing purposes
export function clearCache(): void {
  cache = null;
}

export const listNodeTypesHandler: ToolHandler = async (args, session) => {
  const category = typeof args.category === "string" ? args.category : undefined;

  // Use cache only for uncategorized full-catalog requests
  if (!category && cache) {
    return formatResult(cache);
  }

  const nodes = await session.enqueue(() => session.client.listNodeTypes(category));

  if (!category) cache = nodes;

  return formatResult(nodes);
};

function formatResult(nodes: SwarmNodeType[]): ToolResult {
  const lines = nodes.map((n) => {
    const params = n.parameters.map((p) => `    - ${p.name} (${p.type}, default: ${p.default})`).join("\n");
    return [
      `## ${n.type}`,
      `Category: ${n.category}`,
      `Inputs: ${n.inputs.length ? n.inputs.join(", ") : "none"}`,
      `Outputs: ${n.outputs.join(", ")}`,
      params ? `Parameters:\n${params}` : "Parameters: none"
    ].join("\n");
  });

  return {
    content: [{ type: "text", text: lines.join("\n\n") }]
  };
}

registerTool(
  {
    name: "list_node_types",
    description:
      `List all Gaea node types available for terrain graphs. Categories:
- **primitives**: Base generators (Mountain, Perlin, Voronoi, Range) — starting points
- **erosion**: Weathering (Erosion2 for hydraulic, Thermal for talus slopes)
- **filter**: Shape modifiers (FractalTerraces, Rugged, Autolevel, Clamp, Blur, Invert)
- **transform**: Spatial ops (Combine for blending, Transform for offset/rotation)
- **data**: Visualization (SatMap for satellite coloring)

Call this before create_terrain if building a custom graph. Results are cached.`,
    inputSchema: {
      type: "object",
      properties: {
        category: {
          type: "string",
          description: 'Filter by category, e.g. "erosion", "primitives", "output"'
        }
      }
    }
  },
  listNodeTypesHandler
);
