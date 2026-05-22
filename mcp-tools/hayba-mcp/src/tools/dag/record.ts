import { z } from 'zod';
import type { DagSystem } from '../../dag/index.js';
import { isUri } from '../../dag/uri.js';

export const dagRecordSchema = {
  reads: z.array(z.string()).optional(),
  writes: z.array(z.string()).min(1),
  actor: z.string().optional(),
  note: z.string().optional(),
};

export interface DagRecordCtx { dag: DagSystem; }

export type DagRecordResult =
  | { ok: true; seq: number }
  | { ok: false; error: string };

export async function dagRecordHandler(
  args: { reads?: string[]; writes: string[]; actor?: string; note?: string },
  ctx: DagRecordCtx,
): Promise<DagRecordResult> {
  const reads = args.reads ?? [];
  const bad = [...reads, ...args.writes].find(u => !isUri(u));
  if (bad) return { ok: false, error: `not a valid artifact URI: "${bad}"` };

  const before = ctx.dag.journal.all().length;
  ctx.dag.recordMutation({
    actor: args.actor ?? 'manual',
    reads,
    writes: args.writes,
    paramsHash: '',
    ok: true,
    note: args.note ?? null,
  });
  const after = ctx.dag.journal.all();
  if (after.length === before) return { ok: false, error: 'journal append failed' };
  return { ok: true, seq: after[after.length - 1].seq };
}

export const meta = {
  cost: 'low' as const,
  effects: ['write'],
  when: 'You performed a mutation Hayba did not instrument (editor-side actor edits, manual file writes) and want the DAG to know.',
  not_when: 'The mutation was a sliver run or an asset tool — those record themselves.',
  pack: 'core',
};
