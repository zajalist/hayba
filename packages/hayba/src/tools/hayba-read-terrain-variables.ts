import type { ToolHandler } from './hayba-bake-terrain.js';

export const readTerrainVariablesTool: ToolHandler = async (args, session) => {
  const terrainPath = (args.path as string | undefined) ?? session.terrainPath;
  if (!terrainPath) {
    return { content: [{ type: 'text', text: 'Error: no terrain is currently loaded and no path was provided.' }], isError: true };
  }

  const variables = session.client.readTerrainVariables(terrainPath);
  const count = Object.keys(variables).length;

  return {
    content: [{
      type: 'text',
      text: JSON.stringify({
        terrainPath,
        variableCount: count,
        variables,
        usage: count === 0
          ? 'No variables declared. Set up variable bindings in the Gaea UI, or use a template that declares variable contracts.'
          : 'Pass these variable names in hayba_bake_terrain({ variables: { key: value } }) to override at bake time.',
      }, null, 2)
    }]
  };
};
