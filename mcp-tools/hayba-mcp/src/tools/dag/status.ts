import { z } from 'zod';
import type { DagSystem } from '../../dag/index.js';

export const dagStatusSchema = {
  namespace: z.string().optional(),
  dirtyOnly: z.boolean().optional(),
};

export interface DagCtx { dag: DagSystem; }

export interface DagStatusResult {
  nodeCount: number;
  dirtyCount: number;
  nodes: Array<{ uri: string; namespace: string; dirty: boolean; lastWriteSeq: number | null }>;
  edges: Array<{ from: string; to: string; provenance: string; viaSeq: number }>;
  warnings: string[];
}

export async function dagStatusHandler(
  args: { namespace?: string; dirtyOnly?: boolean },
  ctx: DagCtx,
): Promise<DagStatusResult> {
  const all = ctx.dag.dag.nodes();
  const nodes = all
    .filter(n => !args.namespace || n.namespace === args.namespace)
    .filter(n => !args.dirtyOnly || n.dirty);
  return {
    nodeCount: all.length,
    dirtyCount: all.filter(n => n.dirty).length,
    nodes,
    edges: ctx.dag.dag.edges(),
    warnings: ctx.dag.dag.warnings(),
  };
}

export const meta = {
  cost: 'low' as const,
  effects: ['read'],
  when: 'You want to see the dependency graph of generated artifacts and which are stale (dirty).',
  not_when: 'You want to re-run stale work — use hayba_dag_rebuild.',
  pack: 'core',
};
