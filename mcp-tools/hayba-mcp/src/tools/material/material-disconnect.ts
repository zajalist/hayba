import { z } from 'zod';
import type { ToolResult, SessionManager } from '../types.js';
import { executeCommand } from '../tool-executor.js';
import type { HaybaToolMeta } from '../hayba-tool-meta.js';

export const meta: HaybaToolMeta = {
  cost: 'low',
  effects: ['modifies_asset'],
  when: 'breaking/removing a connection in a material graph (node input or material-output property)',
  not_when: 'creating connections (use material_connect_nodes) or deleting nodes (use material_delete_node)',
};

export const schema = z.object({
  material_path: z.string().min(1).describe('Path to the material asset'),
  to_node: z.string().optional().describe('ID or name of the target node whose input should be disconnected'),
  to_input: z.string().optional().describe('Input pin name on the target node (defaults to first input)'),
  to_input_index: z.number().int().nonnegative().optional().describe('Zero-based input pin index (alternative to to_input)'),
  to_property: z.string().optional().describe('Material output property name to disconnect (e.g. base_color, normal)'),
}).refine((d) => !!d.to_node || !!d.to_property, {
  message: 'one of to_node or to_property is required',
});

export async function materialDisconnectHandler(args: Record<string, unknown>, _session?: SessionManager): Promise<ToolResult> {
  const parsed = schema.safeParse(args);
  if (!parsed.success) {
    return { content: [{ type: 'text', text: `Validation error: ${parsed.error.message}` }], isError: true };
  }
  const data = await executeCommand('material_disconnect', parsed.data as Record<string, unknown>);
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}
