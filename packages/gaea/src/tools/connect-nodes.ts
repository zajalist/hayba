import { registerTool, type ToolHandler } from "./index.js";

export const connectNodesHandler: ToolHandler = async (args, session) => {
  if (!session.terrainPath) {
    return { content: [{ type: "text", text: "No session open. Call open_session() first." }], isError: true };
  }
  for (const field of ["from_id", "from_port", "to_id", "to_port"] as const) {
    if (typeof args[field] !== "string") {
      return { content: [{ type: "text", text: `Error: ${field} is required.` }], isError: true };
    }
  }

  try {
    await session.enqueue(() =>
      session.client.connectNodes(
        args.from_id as string, args.from_port as string,
        args.to_id as string, args.to_port as string
      )
    );
  } catch (e) {
    return { content: [{ type: "text", text: `Error: ${(e as Error).message}` }], isError: true };
  }

  return {
    content: [{ type: "text", text: `Connected ${args.from_id}:${args.from_port} → ${args.to_id}:${args.to_port}` }]
  };
};

registerTool(
  {
    name: "connect_nodes",
    description: "Connect two nodes in the current session. Gaea auto-reloads. Use get_graph_state() to see existing node ids.",
    inputSchema: {
      type: "object",
      required: ["from_id", "from_port", "to_id", "to_port"],
      properties: {
        from_id: { type: "string", description: "Source node id/name e.g. \"peaks\"" },
        from_port: { type: "string", description: "Source port e.g. \"Out\"" },
        to_id: { type: "string", description: "Target node id/name e.g. \"erode\"" },
        to_port: { type: "string", description: "Target port e.g. \"In\"" }
      }
    }
  },
  connectNodesHandler
);
