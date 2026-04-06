import type { ToolHandler } from './hayba-bake-terrain.js';

export const getGraphStateHandler: ToolHandler = async (_args, session) => {
  const state = await session.enqueue(() => session.client.getGraphState());

  const nodeLines = state.nodes.map(
    (n) =>
      `  [${n.cookStatus}] ${n.id} (${n.type})` +
      (Object.keys(n.params).length ? `\n    params: ${JSON.stringify(n.params)}` : '')
  );
  const edgeLines = state.edges.map(
    (e) => `  ${e.from}:${e.fromPort} → ${e.to}:${e.toPort}`
  );

  const text = [
    `## Current Graph State`,
    ``,
    `### Nodes (${state.nodes.length})`,
    ...nodeLines,
    ``,
    `### Connections (${state.edges.length})`,
    ...(edgeLines.length ? edgeLines : ['  (no connections)']),
    ``,
    `Call hayba_get_parameters to inspect a specific node's parameters.`
  ].join('\n');

  return { content: [{ type: 'text', text }] };
};
