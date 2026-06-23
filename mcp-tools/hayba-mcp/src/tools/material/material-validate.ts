import { z } from 'zod';
import type { ToolResult, SessionManager } from '../types.js';
import { executeCommand } from '../tool-executor.js';
import type { HaybaToolMeta } from '../hayba-tool-meta.js';

export const meta: HaybaToolMeta = {
  cost: 'low',
  effects: [],
  when: 'before material_compile, to check a material OR material FUNCTION graph for translator-crash-prone wiring (reroutes/named-reroutes that resolve to no input, out-of-range output connections) WITHOUT triggering a compile',
  not_when: 'finalizing a graph — material_compile runs the same checks and refuses to compile if any fail',
};

export const schema = z.object({
  material_path: z.string().optional().describe('Path to the master material to validate (either this or function_path)'),
  function_path: z.string().optional().describe('Path to a material FUNCTION to validate (either this or material_path)'),
}).refine((d) => !!d.material_path || !!d.function_path, {
  message: 'one of material_path or function_path is required',
});

export async function materialValidateHandler(args: Record<string, unknown>, _session?: SessionManager): Promise<ToolResult> {
  const parsed = schema.safeParse(args);
  if (!parsed.success) {
    return { content: [{ type: 'text', text: `Validation error: ${parsed.error.message}` }], isError: true };
  }
  const data = await executeCommand('material_validate', parsed.data as Record<string, unknown>);
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}
