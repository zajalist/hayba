// mcp-tools/hayba-mcp/src/tools/sliver/run.ts
import { z } from 'zod';
import type { SliverRuntime } from '../../slivers/runtime.js';
import type { SliverRunResult } from '../../slivers/types.js';

export const sliverRunSchema = {
  id: z.string().min(1),
  params: z.record(z.string(), z.unknown()).default({}),
};

export interface SliverRunCtx { runtime: SliverRuntime; }

export async function sliverRunHandler(
  args: { id: string; params: Record<string, unknown> },
  ctx: SliverRunCtx,
): Promise<SliverRunResult> {
  return ctx.runtime.runSliver(args.id, args.params ?? {});
}

export const meta = {
  cost: 'medium' as const,
  effects: ['varies-by-sliver'],
  when: 'You want to execute a sliver with concrete parameter values. Returns outputs + declared side_effects.',
  not_when: 'You only need to read the spec — use hayba_sliver_get.',
  pack: 'core',
};
