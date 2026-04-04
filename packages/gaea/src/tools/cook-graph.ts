import { registerTool, type ToolHandler } from "./index.js";

export const cookGraphHandler: ToolHandler = async (args, session) => {
  if (args.nodes !== undefined && !Array.isArray(args.nodes)) {
    return { content: [{ type: "text", text: "Error: nodes must be an array of node id strings" }], isError: true };
  }

  const nodeIds = Array.isArray(args.nodes)
    ? (args.nodes as unknown[]).filter((x): x is string => typeof x === "string")
    : undefined;

  const exported = await session.enqueue(async () => {
    await session.client.cook(nodeIds);
    return session.client.export(session.outputDir, "EXR");
  });

  const lines = [
    nodeIds
      ? `Re-cooked nodes: ${nodeIds.join(", ")}`
      : "Full graph cooked.",
    ``,
    `Updated output files:`,
    `  Heightmap: ${exported.heightmap}`,
    exported.normalmap ? `  Normal map: ${exported.normalmap}` : null,
    exported.splatmap ? `  Splatmap: ${exported.splatmap}` : null
  ].filter(Boolean).join("\n");

  return { content: [{ type: "text", text: lines }] };
};

registerTool(
  {
    name: "cook_graph",
    description:
      "Cook the Gaea graph and export updated heightmap files. Pass specific node ids for a partial re-cook (only dirty downstream nodes are processed). Omit nodes to cook the full graph.",
    inputSchema: {
      type: "object",
      properties: {
        nodes: {
          type: "array",
          items: { type: "string" },
          description: "Optional list of node ids to re-cook. Omit for full graph cook."
        }
      }
    }
  },
  cookGraphHandler
);
