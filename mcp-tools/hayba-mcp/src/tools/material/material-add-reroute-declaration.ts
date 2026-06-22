import { z } from 'zod';
import type { ToolHandler } from '../types.js';
import { executeCommand } from '../tool-executor.js';
import type { HaybaToolMeta } from '../hayba-tool-meta.js';

export const meta: HaybaToolMeta = {
  cost: 'low',
  effects: ['modifies_asset'],
  when: 'creating a named-reroute declaration (source anchor) so a value can be referenced by name instead of long wires; feed it via material_connect_nodes (to_node = this id)',
  not_when: 'consuming the value elsewhere (use material_add_reroute_usage)',
};

export const schema = z.object({
  material_path: z.string().optional().describe('Path to the material asset (either this or function_path required)'),
  function_path: z.string().optional().describe('Path to the material function asset (either this or material_path required)'),
  name: z.string().min(1).describe('The reroute name (what usages bind to)'),
  node_pos: z.tuple([z.number(), z.number()]).optional().describe('Graph position [x, y]'),
  color: z.array(z.number()).min(3).max(4).optional().describe('Node color [r, g, b] or [r, g, b, a] (0..1), shared by all linked usages'),
}).refine((d) => !!d.material_path || !!d.function_path, {
  message: 'one of material_path or function_path is required',
});

export const materialAddRerouteDeclarationHandler: ToolHandler = async (args) => {
  const parsed = schema.safeParse(args);
  if (!parsed.success) {
    return { content: [{ type: 'text', text: `Validation error: ${parsed.error.message}` }], isError: true };
  }
  const data = await executeCommand('material_add_reroute_declaration', parsed.data as Record<string, unknown>);
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
};
