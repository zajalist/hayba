import { z } from 'zod';
import type { SliverLoader } from '../../slivers/loader.js';
import type { SliverSpec } from '../../slivers/types.js';

export const sliverGetSchema = { id: z.string().min(1) };

export interface SliverGetCtx { loader: SliverLoader; }
export type SliverGetResult =
  | { found: true; spec: SliverSpec }
  | { found: false; id: string };

export async function sliverGetHandler(
  args: { id: string },
  ctx: SliverGetCtx,
): Promise<SliverGetResult> {
  const spec = ctx.loader.get(args.id);
  if (!spec) return { found: false, id: args.id };
  return { found: true, spec };
}

export const meta = {
  cost: 'low' as const,
  effects: ['read'],
  when: 'You have a sliver id and need its full spec — param schema, determinism block, executor kind.',
  not_when: 'You want to enumerate slivers — use hayba_sliver_list.',
  pack: 'core',
};
