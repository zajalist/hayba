import { z } from 'zod';
import type { ToolHandler } from '../types.js';
import { executeCommand } from '../tool-executor.js';
import type { HaybaToolMeta } from '../hayba-tool-meta.js';

export const meta: HaybaToolMeta = {
  cost: 'low',
  effects: ['modifies_asset'],
  when: 'consuming a named-reroute declaration by name (replaces a long wire); wire its output to targets with material_connect_nodes (from_node = this id)',
  not_when: 'creating the source anchor (use material_add_reroute_declaration)',
};

export const schema = z.object({
  material_path: z.string().optional().describe('Path to the material asset (either this or function_path required)'),
  function_path: z.string().optional().describe('Path to the material function asset (either this or material_path required)'),
  declaration_id: z.string().min(1).describe('node_id of the reroute declaration to bind to'),
  node_pos: z.tuple([z.number(), z.number()]).optional().describe('Graph position [x, y]'),
}).refine((d) => !!d.material_path || !!d.function_path, {
  message: 'one of material_path or function_path is required',
});

export const materialAddRerouteUsageHandler: ToolHandler = async (args) => {
  const parsed = schema.safeParse(args);
  if (!parsed.success) {
    return { content: [{ type: 'text', text: `Validation error: ${parsed.error.message}` }], isError: true };
  }
  const data = await executeCommand('material_add_reroute_usage', parsed.data as Record<string, unknown>);
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
};
