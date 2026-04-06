import type { SessionManager } from '../gaea/session.js';
import type { ToolHandler } from './hayba-bake-terrain.js';

export const openSessionHandler: ToolHandler = async (args, session) => {
  if (typeof args.path !== 'string' || !args.path.trim()) {
    return { content: [{ type: 'text', text: 'Error: path is required and must be a non-empty string' }], isError: true };
  }

  const terrainPath = args.path.trim();
  await session.enqueue(() => session.client.loadGraph(terrainPath));
  session.setTerrainPath(terrainPath);

  return {
    content: [{
      type: 'text',
      text: [
        `Session opened successfully.`,
        `Terrain file: ${terrainPath}`,
        ``,
        `You can now call hayba_get_graph_state to inspect the graph, hayba_get_parameters to examine a node, or hayba_set_parameter to modify values.`
      ].join('\n')
    }]
  };
};
