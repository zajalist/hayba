import { GraphSchema } from "../types.js";
import { registerTool, type ToolHandler, type ToolResult } from "./index.js";
import { getTemplate, listTemplates } from "../templates/index.js";

export const createTerrainHandler: ToolHandler = async (args, session) => {
  if (typeof args.prompt !== "string" || !args.prompt.trim()) {
    return { content: [{ type: "text", text: "Error: prompt is required and must be a non-empty string" }], isError: true };
  }

  const resolution = (args.resolution as number) ?? 1024;
  const outputDir = (args.output_dir as string) ?? session.outputDir;

  // Template path — for simpler models that can't build graphs from scratch
  if (typeof args.template === "string") {
    const overrides = (args.template_overrides as Record<string, unknown>) ?? {};
    const graph = getTemplate(args.template, overrides);
    if (!graph) {
      const available = listTemplates().map(t => `  - ${t.name}: ${t.description}`).join("\n");
      return {
        content: [{ type: "text", text: `Unknown template "${args.template}". Available templates:\n${available}` }],
        isError: true
      };
    }
    // Reuse the graph path by injecting the template graph
    args.graph = graph;
  }

  // If a graph is provided directly, use it; otherwise list available nodes
  // so the AI client can build the graph itself
  if (args.graph) {
    const validation = GraphSchema.safeParse(args.graph);
    if (!validation.success) {
      return {
        content: [{ type: "text", text: `Graph validation failed: ${validation.error.message}` }],
        isError: true
      };
    }

    await session.enqueue(async () => {
      await session.client.createGraph(validation.data);
    });

    const terrainPath = session.client.currentTerrainPath;

    // Try to cook and export — but don't fail the whole operation if it doesn't work
    let exported: { heightmap: string; normalmap?: string; splatmap?: string } | null = null;
    let cookError: string | null = null;
    try {
      await session.enqueue(async () => {
        await session.client.cook();
      });
      exported = await session.enqueue(() =>
        session.client.export(outputDir, resolution > 1024 ? "EXR" : "PNG")
      );
    } catch (e) {
      cookError = (e as Error).message;
    }

    if (terrainPath) session.setTerrainPath(terrainPath);

    if (exported) {
      const lines = [
        `Terrain generated and cooked successfully.`,
        `Prompt: "${args.prompt}"`,
        ``,
        `Output files:`,
        `  Heightmap: ${exported.heightmap}`,
        exported.normalmap ? `  Normal map: ${exported.normalmap}` : null,
        exported.splatmap ? `  Splatmap: ${exported.splatmap}` : null,
        ``,
        `You can now call get_graph_state() to inspect the graph, or get_parameters(node_id) to examine a specific node.`
      ].filter(Boolean).join("\n");
      return { content: [{ type: "text", text: lines }] };
    }

    // Graph was created but cook/export failed
    const lines = [
      `Terrain graph created successfully.`,
      `Prompt: "${args.prompt}"`,
      terrainPath ? `\nTerrain file: ${terrainPath}` : ``,
      `\nNote: Cooking/export failed — open the .terrain file in Gaea to cook and export manually.`,
      cookError ? `  Error: ${cookError}` : ``,
      ``,
      `You can now call get_graph_state() to inspect the graph, or get_parameters(node_id) to examine a specific node.`
    ].filter(Boolean).join("\n");
    return { content: [{ type: "text", text: lines }] };
  }

  // No graph provided — return the node catalog so the client can build one
  const nodeTypes = await session.enqueue(() => session.client.listNodeTypes());
  const catalog = nodeTypes
    .map((n) => {
      const params = n.parameters.map((p) => `  - ${p.name}: ${p.type} [${p.min ?? "?"} - ${p.max ?? "?"}], default ${p.default}`).join("\n");
      return `### ${n.type} (${n.category})\nInputs: ${n.inputs.join(", ") || "none"} | Outputs: ${n.outputs.join(", ")}\n${params}`;
    })
    .join("\n\n");

  const templates = listTemplates();
  const templateSection = [
    `## Quick Start: Use a Template`,
    `If you cannot build a full graph, use a template instead:`,
    ...templates.map(t => `  - **${t.name}**: ${t.description} (tweakable: ${(t.tweakable ?? []).join(", ")})`),
    ``,
    `Call: create_terrain(prompt="...", template="desert", template_overrides={"Seed": 42})`,
    ``,
    `## Advanced: Build a Custom Graph`
  ].join("\n");

  return {
    content: [{
      type: "text",
      text: [
        templateSection,
        ``,
        `No graph provided. Please build a graph JSON and call again with the "graph" parameter.`,
        ``,
        `The graph must have: { "nodes": [...], "edges": [...] }`,
        `Each node: { "id": "unique_id", "type": "NodeType", "params": { ... } }`,
        `Each edge: { "from": "node_id", "fromPort": "port", "to": "node_id", "toPort": "port" }`,
        ``,
        `Available nodes:`,
        ``,
        catalog,
        ``,
        `Prompt to fulfill: "${args.prompt}"`
      ].join("\n")
    }]
  };
};

registerTool(
  {
    name: "create_terrain",
    description:
      `Generate a Gaea terrain graph. Three modes:

1. **Template mode** (easiest): Pass template="desert"|"mountains"|"tropical"|"volcanic" with optional template_overrides. Best for simple requests.

2. **Graph mode** (advanced): Pass a full graph JSON with nodes and edges. Call list_node_types() first to see available nodes.

3. **Catalog mode** (discovery): Omit both template and graph to get the node catalog and template list.

Common patterns:
- Simple: Mountain → Erosion2 → Autolevel
- Blended: Two primitives → Combine → Erosion2 → Autolevel
- Detailed: Primitive → FractalTerraces → Erosion2 → Rugged → Autolevel

Always end with Autolevel to normalize height range.`,
    inputSchema: {
      type: "object",
      required: ["prompt"],
      properties: {
        prompt: { type: "string", description: "Natural language terrain description (for logging)" },
        template: {
          type: "string",
          description: "Use a predefined terrain template instead of building a graph from scratch. Options: desert, mountains, tropical, volcanic. Ideal for simpler models."
        },
        template_overrides: {
          type: "object",
          description: "Override specific parameters in the template (e.g. { \"Seed\": 42, \"Scale\": 2.0 })"
        },
        graph: {
          type: "object",
          description: "The Gaea node graph to build. Contains 'nodes' and 'edges' arrays. Omit to get the node catalog first.",
          properties: {
            nodes: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  id: { type: "string" },
                  type: { type: "string" },
                  params: { type: "object" }
                },
                required: ["id", "type"]
              }
            },
            edges: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  from: { type: "string" },
                  fromPort: { type: "string" },
                  to: { type: "string" },
                  toPort: { type: "string" }
                },
                required: ["from", "fromPort", "to", "toPort"]
              }
            }
          }
        },
        output_dir: { type: "string", description: "Directory to write output files (uses config default if omitted)" },
        resolution: {
          type: "number",
          enum: [1024, 2048, 4096],
          description: "Output heightmap resolution in pixels (default: 1024)"
        }
      }
    }
  },
  createTerrainHandler
);
