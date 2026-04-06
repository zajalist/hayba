import { registerTool, type ToolHandler } from "./index.js";

export const readTerrainVariablesTool: ToolHandler = async (args, session) => {
  const terrainPath = (args.path as string | undefined) ?? session.terrainPath;
  if (!terrainPath) {
    return {
      content: [{ type: "text", text: "Error: no terrain is currently loaded and no path was provided." }],
      isError: true,
    };
  }

  const variables = session.client.readTerrainVariables(terrainPath);
  const count = Object.keys(variables).length;

  return {
    content: [{
      type: "text",
      text: JSON.stringify({
        terrainPath,
        variableCount: count,
        variables,
        usage: count === 0
          ? "No variables declared. Set up variable bindings in the Gaea UI, or use a template that declares variable contracts."
          : "Pass these variable names in bake_terrain({ variables: { key: value } }) to override at bake time.",
      }, null, 2)
    }]
  };
};

registerTool(
  {
    name: "read_terrain_variables",
    description:
      `List all variables declared in a Gaea .terrain file. Variables are named parameters bound to node properties that can be overridden at bake time via CLI flags.

Use this before bake_terrain to discover what's parameterizable.
Returns variable names, types, current values, and min/max ranges.`,
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute path to the .terrain file (uses currently loaded terrain if omitted)" }
      }
    }
  },
  readTerrainVariablesTool
);
