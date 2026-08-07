import { z } from 'zod';
import type { ToolHandler } from '../types.js';
import { ueTool } from '../ue-tool.js';
import type { HaybaToolMeta } from '../hayba-tool-meta.js';

export const meta: HaybaToolMeta = {
  cost: 'low',
  effects: ['modifies_asset'],
  when: 'moving or re-propertying an existing node in a material graph',
  not_when: 'adding a new node (use material_add_node) or deleting one (use material_delete_node)',
};

export const schema = z.object({
  material_path: z.string().optional().describe('Path to the material asset (either this or function_path required)'),
  function_path: z.string().optional().describe('Path to the material function asset (either this or material_path required)'),
  node_id: z.string().min(1).describe('ID/name of the existing node to update'),
  node_pos: z.tuple([z.number(), z.number()]).optional().describe('New graph position [x, y]'),
  properties: z
    .record(z.string(), z.unknown())
    .optional()
    .describe(
      'Properties to set on the node. Friendly aliases (parameter_name/default_value/texture/const/function/coordinate_index/u_tiling/v_tiling); any other key is set as a real UPROPERTY by name. Keys that match no property are returned in unknown_props[] with data.ok=false (mistyped keys are reported, not silently ignored); applied keys are listed in applied_props[].',
    ),
}).refine((d) => !!d.material_path || !!d.function_path, {
  message: 'one of material_path or function_path is required',
});

export const materialSetNodeHandler: ToolHandler = ueTool('material_set_node', schema);
