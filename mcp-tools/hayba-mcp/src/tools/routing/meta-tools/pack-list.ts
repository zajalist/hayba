import type { PackRegistry, PackListEntry } from '../pack-registry.js';

export const packListSchema = {};
export interface PackListCtx { registry: PackRegistry; }
export interface PackListResult { packs: PackListEntry[]; }

export async function packListHandler(_args: Record<string, never>, ctx: PackListCtx): Promise<PackListResult> {
  return { packs: ctx.registry.listPacks() };
}

export const meta = {
  cost: 'low' as const,
  effects: ['read'],
  when: 'You want to discover what tool packs exist before loading one.',
  not_when: 'You already know the pack name — call hayba_pack_load directly.',
  pack: 'core',
};
