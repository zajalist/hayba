import { z } from 'zod';
import type { ToolResult, SessionManager } from '../types.js';
import { executeCommand } from '../tool-executor.js';
import type { HaybaToolMeta } from '../hayba-tool-meta.js';
import { formatOptimizationFeedback, type MaterialStats } from './material-stats.js';

export const meta: HaybaToolMeta = {
  cost: 'medium',
  effects: ['modifies_asset'],
  when: 'explicitly compiling a material after building/editing its graph, to apply staged settings, surface translator errors, and read back shader optimization stats (instruction counts, texture samples)',
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

  const content: ToolResult['content'] = [
    { type: 'text', text: JSON.stringify(data, null, 2) },
  ];

  // Surface optimization feedback (instruction counts, texture samples, etc.)
  // right after compile so the AI can react to shader cost. The `stats` block
  // is produced by the UE-side material_compile handler from the recompiled
  // FMaterialResource shader map; older plugin builds omit it (feedback skipped).
  const stats = (data as { stats?: MaterialStats } | null | undefined)?.stats;
  const feedback = formatOptimizationFeedback(stats);
  if (feedback) content.push({ type: 'text', text: feedback });

  return { content };
}
