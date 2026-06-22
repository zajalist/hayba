import { z } from 'zod';
import type { ToolResult, SessionManager } from '../types.js';
import { executeCommand } from '../tool-executor.js';
import type { HaybaToolMeta } from '../hayba-tool-meta.js';

export const meta: HaybaToolMeta = {
  cost: 'medium',
  effects: ['modifies_asset'],
  when: 'explicitly compiling a material after building/editing its graph, to apply staged settings and surface translator errors',
  not_when: 'mid-edit — graph edits (add_node/connect/set_node/...) already auto-save to disk and intentionally DEFER compilation; only compile once the graph is complete',
};

export const schema = z.object({
  material_path: z.string().min(1).describe('Path to the master material asset to compile'),
});

export async function materialCompileHandler(args: Record<string, unknown>, _session?: SessionManager): Promise<ToolResult> {
  const parsed = schema.safeParse(args);
  if (!parsed.success) {
    return { content: [{ type: 'text', text: `Validation error: ${parsed.error.message}` }], isError: true };
  }
  const data = await executeCommand('material_compile', parsed.data as Record<string, unknown>);
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}
