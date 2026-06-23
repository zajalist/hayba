import { z } from 'zod';
import type { ToolResult, SessionManager } from '../types.js';
import { executeCommand } from '../tool-executor.js';
import type { HaybaToolMeta } from '../hayba-tool-meta.js';
import { formatOptimizationFeedback, type MaterialStats } from './material-stats.js';

export const meta: HaybaToolMeta = {
  cost: 'medium',
  effects: ['modifies_asset'],
  when: 'finalizing a material OR material FUNCTION after building/editing its graph — applies staged settings, writes the asset to disk, surfaces translator errors + shader optimization stats (materials only)',
  not_when: 'mid-edit — graph edits intentionally DEFER the disk write; only call this once the graph is complete (required for functions too: their edits no longer auto-save, so call material_compile with function_path to persist)',
};

export const schema = z.object({
  material_path: z.string().optional().describe('Path to the master material asset to compile (either this or function_path)'),
  function_path: z.string().optional().describe('Path to a material FUNCTION to finalize + save (either this or material_path)'),
}).refine((d) => !!d.material_path || !!d.function_path, {
  message: 'one of material_path or function_path is required',
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
