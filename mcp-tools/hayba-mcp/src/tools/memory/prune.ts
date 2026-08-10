import type { ToolHandler } from '../types.js';
import type { HaybaToolMeta } from '../hayba-tool-meta.js';
import { errorResult, okResult } from '../tool-result.js';
import { getMemoryStore } from './store.js';
import { config } from '../../config.js';

export const meta: HaybaToolMeta = {
  cost: 'low',
  effects: ['modifies_memory_state'],
  when: 'forcing retention to run now (e.g. with a tighter one-off bound) instead of waiting for the next memory_write, which applies it automatically.',
  not_when: 'normal usage — memory_write already runs retention with the configured bounds after every insert, so this is rarely needed.',
};

export const memoryPruneHandler: ToolHandler = async (args) => {
  const maxCount = typeof args.max_count === 'number' ? args.max_count : config.memoryMaxCount;
  const maxAgeDays = typeof args.max_age_days === 'number' ? args.max_age_days : undefined;
  const maxAgeMs = maxAgeDays !== undefined ? maxAgeDays * 24 * 60 * 60 * 1000 : config.memoryMaxAgeMs;

  if (maxCount !== undefined && maxCount <= 0) return errorResult('max_count must be positive when given');
  if (maxAgeMs !== undefined && maxAgeMs <= 0) return errorResult('max_age_days must be positive when given');

  const store = getMemoryStore();
  const result = store.applyRetention({ maxCount, maxAgeMs });

  return okResult({
    ok: true,
    pruned_by_age: result.prunedByAge,
    pruned_by_count: result.prunedByCount,
    pruned_total: result.prunedTotal,
    remaining: result.remaining,
  });
};
