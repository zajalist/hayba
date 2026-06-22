import { z } from 'zod';
import type { ToolHandler } from '../types.js';
import { executeCommand } from '../tool-executor.js';
import type { HaybaToolMeta } from '../hayba-tool-meta.js';

export const meta: HaybaToolMeta = {
  cost: 'low',
  effects: ['modifies_asset'],
  when: 'connecting two nodes in a material graph or connecting a node output to a material property',
  not_when: 'adding a new node (use material_add_node)',
};

export const schema = z.object({
  material_path: z.string().optional().describe('Path to the material asset (either this or function_path required)'),
  function_path: z.string().optional().describe('Path to the material function asset (either this or material_path required)'),
  from_node: z.string().min(1).describe('ID or name of the source node'),
  from_output: z.string().optional().describe('Output pin name on the source node'),
  to_node: z.string().optional().describe('ID or name of the target node'),
  to_input: z.string().optional().describe('Input pin name on the target node'),
  to_input_index: z.number().int().optional().describe('Target input pin by index (unnamed pins, e.g. Substrate slab inputs)'),
  from_output_index: z.number().int().optional().describe('Source output pin by index (default 0)'),
  to_property: z.string().optional().describe('Target material property, e.g. base_color or front_material (Substrate)'),
}).refine((d) => !!d.material_path || !!d.function_path, {
  message: 'one of material_path or function_path is required',
}).refine((d) => !!d.to_node || !!d.to_property, {
  message: 'one of to_node or to_property is required',
});

export const materialConnectNodesHandler: ToolHandler = async (args) => {
  const parsed = schema.safeParse(args);
  if (!parsed.success) {
    return { content: [{ type: 'text', text: `Validation error: ${parsed.error.message}` }], isError: true };
  }
  const data = await executeCommand('material_connect_nodes', parsed.data as Record<string, unknown>);
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
};
