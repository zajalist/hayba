import { registerTool, type ToolHandler } from "./index.js";

export const openSessionHandler: ToolHandler = async (args, session) => {
  if (typeof args.path !== "string" || !args.path.trim()) {
    return { content: [{ type: "text", text: "Error: path is required and must be a non-empty string" }], isError: true };
  }

  const terrainPath = args.path.trim();

  await session.enqueue(() => session.client.loadGraph(terrainPath));
  session.setTerrainPath(terrainPath);

  return {
    content: [{
      type: "text",
      text: [
        `Session opened successfully.`,
        `Terrain file: ${terrainPath}`,
        ``,
        `You can now call get_graph_state() to inspect the graph, get_parameters(node_id) to examine a node, or set_parameter() to modify values.`
      ].join("\n")
    }]
  };
};

registerTool(
  {
    name: "open_session",
    description: "Open an existing Gaea .terrain file and load it into the current session. Use this to work with a previously created terrain file.",
    inputSchema: {
      type: "object",
      required: ["path"],
      properties: {
        path: {
          type: "string",
          description: "Absolute path to the .terrain file to open"
        }
      }
    }
  },
  openSessionHandler
);
