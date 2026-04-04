import { registerTool, type ToolHandler } from "./index.js";

export const setParameterHandler: ToolHandler = async (args, session) => {
  if (typeof args.node_id !== "string" || !args.node_id.trim()) {
    return { content: [{ type: "text", text: "Error: node_id is required" }], isError: true };
  }
  if (typeof args.parameter !== "string" || !args.parameter.trim()) {
    return { content: [{ type: "text", text: "Error: parameter is required" }], isError: true };
  }
  if (
    typeof args.value !== "string" &&
    typeof args.value !== "number" &&
    typeof args.value !== "boolean"
  ) {
    return { content: [{ type: "text", text: "Error: value must be a string, number, or boolean" }], isError: true };
  }

  const nodeId = args.node_id;
  const parameter = args.parameter;
  const value = args.value;

  await session.enqueue(() => session.client.setParameter(nodeId, parameter, value));

  return {
    content: [
      {
        type: "text",
        text: `Set \`${nodeId}.${parameter}\` = ${JSON.stringify(value)}.\nDownstream nodes are now dirty. Call cook_graph() to re-render.`
      }
    ]
  };
};

registerTool(
  {
    name: "set_parameter",
    description:
      "Set a parameter value on a node. Marks downstream nodes as dirty but does NOT cook — batch multiple set_parameter calls before calling cook_graph() for efficiency.",
    inputSchema: {
      type: "object",
      required: ["node_id", "parameter", "value"],
      properties: {
        node_id: { type: "string" },
        parameter: { type: "string", description: "Parameter name as returned by get_parameters" },
        value: { description: "New value — must be within the valid range for this parameter" }
      }
    }
  },
  setParameterHandler
);
