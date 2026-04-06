import type { ToolHandler } from './hayba-bake-terrain.js';

export const connectNodesHandler: ToolHandler = async (args, session) => {
  if (!session.terrainPath) {
    return { content: [{ type: 'text', text: 'No session open. Call hayba_open_session first.' }], isError: true };
  }
  for (const field of ['from_id', 'from_port', 'to_id', 'to_port'] as const) {
    if (typeof args[field] !== 'string') {
      return { content: [{ type: 'text', text: `Error: ${field} is required.` }], isError: true };
    }
  }

  try {
    await session.enqueue(() =>
      session.client.connectNodes(
        args.from_id as string, args.from_port as string,
        args.to_id as string, args.to_port as string
      )
    );
  } catch (e) {
    return { content: [{ type: 'text', text: `Error: ${(e as Error).message}` }], isError: true };
  }

  return { content: [{ type: 'text', text: `Connected ${args.from_id}:${args.from_port} → ${args.to_id}:${args.to_port}` }] };
};
