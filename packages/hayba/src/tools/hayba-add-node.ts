import type { ToolHandler } from './hayba-bake-terrain.js';

export const addNodeHandler: ToolHandler = async (args, session) => {
  if (!session.terrainPath) {
    return { content: [{ type: 'text', text: 'No session open. Call hayba_open_session first.' }], isError: true };
  }
  if (typeof args.type !== 'string' || !args.type.trim()) {
    return { content: [{ type: 'text', text: 'Error: type is required. Call hayba_list_node_types to see options.' }], isError: true };
  }
  if (typeof args.id !== 'string' || !args.id.trim()) {
    return { content: [{ type: 'text', text: 'Error: id is required — a unique name for this node.' }], isError: true };
  }

  const params = (args.params as Record<string, unknown>) ?? {};
  const pos = args.position as { X: number; Y: number } | undefined;
  await session.enqueue(() => session.client.addNode(args.type as string, args.id as string, params, pos));

  return {
    content: [{ type: 'text', text: `Added ${args.type} node "${args.id}". Call hayba_connect_nodes to wire it, or hayba_cook_graph to build.` }]
  };
};
