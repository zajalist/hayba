import type { ToolHandler, ToolResult } from './hayba-bake-terrain.js';
import type { SwarmNodeType } from '../gaea/types.js';

let cache: SwarmNodeType[] | null = null;

export function clearCache(): void { cache = null; }

export const listNodeTypesHandler: ToolHandler = async (args, session) => {
  const category = typeof args.category === 'string' ? args.category : undefined;
  if (!category && cache) return formatResult(cache);
  const nodes = await session.enqueue(() => session.client.listNodeTypes(category));
  if (!category) cache = nodes;
  return formatResult(nodes);
};

function formatResult(nodes: SwarmNodeType[]): ToolResult {
  const lines = nodes.map((n) => {
    const params = n.parameters.map((p) => `    - ${p.name} (${p.type}, default: ${p.default})`).join('\n');
    return [
      `## ${n.type}`,
      `Category: ${n.category}`,
      `Inputs: ${n.inputs.length ? n.inputs.join(', ') : 'none'}`,
      `Outputs: ${n.outputs.join(', ')}`,
      params ? `Parameters:\n${params}` : 'Parameters: none'
    ].join('\n');
  });
  return { content: [{ type: 'text', text: lines.join('\n\n') }] };
}
