import { z } from 'zod';
import type { DagSystem } from '../../dag/index.js';
import { rebuildDirty, type RunNodeResult } from '../../dag/rebuild.js';

export const dagRebuildSchema = {
  target: z.string().optional(),
};

export interface DagRebuildCtx {
  dag: DagSystem;
  runRecipeNode: (uri: string) => Promise<RunNodeResult>;
}

export interface DagRebuildResult {
  rebuilt: string[];
  skipped: Array<{ uri: string; reason: string }>;
  stillDirty: string[];
}

export async function dagRebuildHandler(
  args: { target?: string },
  ctx: DagRebuildCtx,
): Promise<DagRebuildResult> {
  return rebuildDirty(ctx.dag.dag, { runNode: ctx.runRecipeNode }, args.target);
}

export const meta = {
  cost: 'high' as const,
  effects: ['write'],
  when: 'Stale (dirty) artifacts need re-running after an upstream change.',
  not_when: 'You only want to inspect what is dirty — use hayba_dag_status.',
  pack: 'core',
};
