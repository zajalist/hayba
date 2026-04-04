import { registerTool, type ToolHandler } from "./index.js";

export const addNodeHandler: ToolHandler = async (args, session) => {
  if (!session.terrainPath) {
    return { content: [{ type: "text", text: "No session open. Call open_session() first." }], isError: true };
  }
  if (typeof args.type !== "string" || !args.type.trim()) {
    return { content: [{ type: "text", text: "Error: type is required (e.g. \"Mountain\"). Call list_node_types() to see options." }], isError: true };
  }
  if (typeof args.id !== "string" || !args.id.trim()) {
    return { content: [{ type: "text", text: "Error: id is required — a unique name for this node (e.g. \"peaks\")." }], isError: true };
  }

  const params = (args.params as Record<string, unknown>) ?? {};
  const pos = args.position as { X: number; Y: number } | undefined;

  await session.enqueue(() => session.client.addNode(args.type as string, args.id as string, params, pos));

  return {
    content: [{ type: "text", text: `Added ${args.type} node "${args.id}". Call connect_nodes() to wire it, or cook_graph() to build.` }]
  };
};

registerTool(
  {
    name: "add_node",
    description: "Add a new node to the current live session terrain. Gaea auto-reloads the graph. Call open_session() first.",
    inputSchema: {
      type: "object",
      required: ["type", "id"],
      properties: {
        type: { type: "string", description: "Node type from list_node_types() e.g. \"Mountain\", \"Erosion2\", \"Autolevel\"" },
        id: { type: "string", description: "Unique name for this node in the graph e.g. \"peaks\", \"erode\"" },
        params: { type: "object", description: "Optional parameter overrides e.g. { \"Seed\": 42, \"Scale\": 1.5 }" },
        position: { type: "object", description: "Optional { X, Y } canvas position. Auto-placed if omitted." }
      }
    }
  },
  addNodeHandler
);
