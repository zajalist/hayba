import { z } from 'zod';
import type { DagSystem } from '../../dag/index.js';
import type { JournalRecord } from '../../dag/journal.js';

export const journalTailSchema = {
  limit: z.number().int().positive().optional(),
};

export interface JournalTailCtx { dag: DagSystem; }

export interface JournalTailResult { entries: JournalRecord[]; }

export async function journalTailHandler(
  args: { limit?: number },
  ctx: JournalTailCtx,
): Promise<JournalTailResult> {
  return { entries: ctx.dag.journal.tail(args.limit ?? 50) };
}

export const meta = {
  cost: 'low' as const,
  effects: ['read'],
  when: 'You want a recent history of mutation operations for debugging or context.',
  not_when: 'You want the current dependency graph — use hayba_dag_status.',
  pack: 'core',
};
