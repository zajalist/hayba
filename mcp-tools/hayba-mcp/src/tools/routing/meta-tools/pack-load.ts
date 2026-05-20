import { z } from 'zod';
import type { PackRegistry, LoadResult } from '../pack-registry.js';

export const packLoadSchema = { name: z.string().min(1) };
export interface PackLoadCtx { registry: PackRegistry; }

export async function packLoadHandler(args: { name: string }, ctx: PackLoadCtx): Promise<LoadResult> {
  return ctx.registry.loadPack(args.name);
}

export const meta = {
  cost: 'low' as const,
  effects: ['mutate_tool_list'],
  when: 'You searched and the matching tool lives in a pack that is not loaded.',
  not_when: 'A single one-off call — use hayba_invoke instead to avoid pack thrash.',
  pack: 'core',
};
