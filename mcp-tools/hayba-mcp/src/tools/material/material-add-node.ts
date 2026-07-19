import { z } from 'zod';
import type { ToolHandler } from '../types.js';
import { executeCommand } from '../tool-executor.js';
import type { HaybaToolMeta } from '../hayba-tool-meta.js';

export const meta: HaybaToolMeta = {
  cost: 'low',
  effects: ['modifies_asset'],
  when: 'adding a new expression node to a material graph',
  not_when: 'connecting existing nodes (use material_connect_nodes)',
};

export const schema = z.object({
  material_path: z.string().optional().describe('Path to the material asset (either this or function_path required)'),
  function_path: z.string().optional().describe('Path to the material function asset (either this or material_path required)'),
  expression_class: z.string().min(1).describe('UE expression class name, e.g. "MaterialExpressionVectorParameter"'),
  node_pos: z.tuple([z.number(), z.number()]).optional().describe('Graph position [x, y] for the new node'),
  properties: z
    .record(z.string(), z.unknown())
    .optional()
    .describe(
      'Initial properties for the node. Friendly aliases (parameter_name/default_value/texture/const/function/coordinate_index/u_tiling/v_tiling); any other key is set as a real UPROPERTY by name. Keys that match no property are returned in unknown_props[] with data.ok=false (mistyped keys are reported, not silently ignored); applied keys are listed in applied_props[]. Unconnected scalar inputs fall back to the node’s default constant, which is fine for hardwired constants.',
    ),
}).refine((d) => !!d.material_path || !!d.function_path, {
  message: 'one of material_path or function_path is required',
});

export const materialAddNodeHandler: ToolHandler = async (args) => {
  const parsed = schema.safeParse(args);
  if (!parsed.success) {
    return { content: [{ type: 'text', text: `Validation error: ${parsed.error.message}` }], isError: true };
  }
  const data = await executeCommand('material_add_node', parsed.data as Record<string, unknown>);
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
};
