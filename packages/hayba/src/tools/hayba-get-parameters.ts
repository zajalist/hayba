import type { ToolHandler } from './hayba-bake-terrain.js';

export const getParametersHandler: ToolHandler = async (args, session) => {
  if (typeof args.node_id !== 'string' || !args.node_id.trim()) {
    return { content: [{ type: 'text', text: 'Error: node_id is required' }], isError: true };
  }

  const nodeId = args.node_id;
  const params = await session.enqueue(() => session.client.getParameters(nodeId));

  if (params.length === 0) {
    return { content: [{ type: 'text', text: `## Parameters for node \`${nodeId}\`\n\n  (no editable parameters)\n` }] };
  }

  const lines = params.map((p) => {
    const range = p.min !== undefined && p.max !== undefined ? ` [${p.min} - ${p.max}]` : '';
    return `  - **${p.name}** (${p.type})${range}, default: ${p.default}`;
  });

  const text = [
    `## Parameters for node \`${nodeId}\``,
    ``,
    ...lines,
    ``,
    `Call hayba_set_parameter then hayba_cook_graph to apply changes.`
  ].join('\n');

  return { content: [{ type: 'text', text }] };
};
