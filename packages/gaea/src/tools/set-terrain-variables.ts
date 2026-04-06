import { registerTool, type ToolHandler } from "./index.js";
import type { TemplateVariableContract } from "../types.js";

export const setTerrainVariablesTool: ToolHandler = async (args, session) => {
  const terrainPath = (args.path as string | undefined) ?? session.terrainPath;
  if (!terrainPath) {
    return { content: [{ type: "text", text: "Error: no terrain path provided." }], isError: true };
  }
  if (!args.contract || typeof args.contract !== "object") {
    return { content: [{ type: "text", text: "Error: contract is required — provide a variable contract object." }], isError: true };
  }

  const contract = args.contract as TemplateVariableContract;
  const values = (args.values as Record<string, unknown>) ?? {};

  try {
    session.client.setTerrainVariables(contract, values, terrainPath);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
  }

  const updated = session.client.readTerrainVariables(terrainPath);
  return {
    content: [{
      type: "text",
      text: JSON.stringify({ terrainPath, variablesWritten: Object.keys(contract).length, variables: updated }, null, 2)
    }]
  };
};

registerTool(
  {
    name: "set_terrain_variables",
    description:
      `Write variable declarations and values into a Gaea .terrain file's Automation.Variables section.
This persists variables to the file (unlike bake_terrain which passes them as transient CLI flags).

Use this when you want variables to be visible in Gaea's UI after opening the file,
or to pre-populate a template with specific values before sharing.

contract: variable specs (name, type, default, min, max, description)
values: actual values to write (falls back to contract defaults if omitted)`,
    inputSchema: {
      type: "object",
      required: ["contract"],
      properties: {
        path: { type: "string", description: "Absolute path to the .terrain file (uses current terrain if omitted)" },
        contract: {
          type: "object",
          description: "Variable contract: keys are variable names, values define type/default/min/max/description"
        },
        values: {
          type: "object",
          description: "Values to write for each variable. Missing keys use contract defaults."
        }
      }
    }
  },
  setTerrainVariablesTool
);
