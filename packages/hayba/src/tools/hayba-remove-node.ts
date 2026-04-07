import type { ToolHandler } from './hayba-bake-terrain.js';

export const removeNodeHandler: ToolHandler = async (args, session) => {
  if (!session.terrainPath) {
    return { content: [{ type: 'text', text: 'No session open. Call hayba_open_session first.' }], isError: true };
  }
  if (typeof args.id !== 'string' || !args.id.trim()) {
    return { content: [{ type: 'text', text: 'Error: id is required.' }], isError: true };
  }

  try {
    await session.enqueue(() => session.client.removeNode(args.id as string));
  } catch (e) {
    return { content: [{ type: 'text', text: `Error: ${(e as Error).message}` }], isError: true };
  }

  return { content: [{ type: 'text', text: `Removed node "${args.id}" and its connections.` }] };
};
