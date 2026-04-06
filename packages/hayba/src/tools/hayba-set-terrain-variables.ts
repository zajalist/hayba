import type { ToolHandler } from './hayba-bake-terrain.js';
import type { TemplateVariableContract } from '../gaea/types.js';

export const setTerrainVariablesTool: ToolHandler = async (args, session) => {
  const terrainPath = (args.path as string | undefined) ?? session.terrainPath;
  if (!terrainPath) {
    return { content: [{ type: 'text', text: 'Error: no terrain path provided.' }], isError: true };
  }
  if (!args.contract || typeof args.contract !== 'object') {
    return { content: [{ type: 'text', text: 'Error: contract is required — provide a variable contract object.' }], isError: true };
  }

  const contract = args.contract as TemplateVariableContract;
  const values = (args.values as Record<string, unknown>) ?? {};

  try {
    session.client.setTerrainVariables(contract, values, terrainPath);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true };
  }

  const updated = session.client.readTerrainVariables(terrainPath);
  return {
    content: [{
      type: 'text',
      text: JSON.stringify({ terrainPath, variablesWritten: Object.keys(contract).length, variables: updated }, null, 2)
    }]
  };
};
