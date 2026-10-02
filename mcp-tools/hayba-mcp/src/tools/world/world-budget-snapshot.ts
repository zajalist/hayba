import { z } from 'zod';
import type { ToolHandler } from '../types.js';
import { ueTool } from '../ue-tool.js';
import type { HaybaToolMeta } from '../hayba-tool-meta.js';

export const meta: HaybaToolMeta = {
  cost: 'low',
  effects: [],
  when: 'measuring loaded actors, folder-path aggregates across loaded roots, classes, and ISM/HISM instances before planning a scene',
  not_when: 'estimating runtime memory, streaming, GPU, NPC, or texel-density budgets; capture those separately',
};

export const schema = z.object({
  folder: z.string().max(1024).optional().describe('Folder path aggregate across all loaded Outliner roots. Includes descendants; cannot target one root. Omit for all loaded actors.'),
  max_loaded_actors: z.number().int().min(0).max(100_000_000).optional()
    .describe('Optional user structural target in loaded actor count; this is not a performance budget.'),
  max_loaded_ism_instances: z.number().int().min(0).max(100_000_000).optional()
    .describe('Optional user structural target in loaded ISM/HISM instance count; this is not a draw-call or memory budget.'),
});

export const worldBudgetSnapshotHandler: ToolHandler = ueTool('world_budget_snapshot', schema);
