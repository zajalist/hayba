import type { ToolHandler } from './hayba-bake-terrain.js';

export const setParameterHandler: ToolHandler = async (args, session) => {
  if (typeof args.node_id !== 'string' || !args.node_id.trim()) {
    return { content: [{ type: 'text', text: 'Error: node_id is required' }], isError: true };
  }
  if (typeof args.parameter !== 'string' || !args.parameter.trim()) {
    return { content: [{ type: 'text', text: 'Error: parameter is required' }], isError: true };
  }
  if (typeof args.value !== 'string' && typeof args.value !== 'number' && typeof args.value !== 'boolean') {
    return { content: [{ type: 'text', text: 'Error: value must be a string, number, or boolean' }], isError: true };
  }

  await session.enqueue(() => session.client.setParameter(args.node_id as string, args.parameter as string, args.value as string | number | boolean));

  return {
    content: [{
      type: 'text',
      text: `Set \`${args.node_id}.${args.parameter}\` = ${JSON.stringify(args.value)}.\nDownstream nodes are now dirty. Call hayba_cook_graph to re-render.`
    }]
  };
};
