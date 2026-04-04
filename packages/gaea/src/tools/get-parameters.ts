import { registerTool, type ToolHandler } from "./index.js";

export const getParametersHandler: ToolHandler = async (args, session) => {
  if (typeof args.node_id !== "string" || !args.node_id.trim()) {
    return { content: [{ type: "text", text: "Error: node_id is required" }], isError: true };
  }

  const nodeId = args.node_id;
  const params = await session.enqueue(() => session.client.getParameters(nodeId));

  if (params.length === 0) {
    return {
      content: [{ type: "text", text: `## Parameters for node \`${nodeId}\`\n\n  (no editable parameters)\n` }]
    };
  }

  const lines = params.map((p) => {
    const range = p.min !== undefined && p.max !== undefined ? ` [${p.min} - ${p.max}]` : "";
    return `  - **${p.name}** (${p.type})${range}, default: ${p.default}`;
  });

  const text = [
    `## Parameters for node \`${nodeId}\``,
    ``,
    ...lines,
    ``,
    `Call set_parameter(node_id, parameter, value) to change a value, then cook_graph() to re-render.`
  ].join("\n");

  return { content: [{ type: "text", text }] };
};

registerTool(
  {
    name: "get_parameters",
    description:
      "Get all editable parameters for a specific node, including current values and valid ranges. Call this before set_parameter to know what values are acceptable.",
    inputSchema: {
      type: "object",
      required: ["node_id"],
      properties: {
        node_id: { type: "string", description: "The node id as shown in get_graph_state" }
      }
    }
  },
  getParametersHandler
);
