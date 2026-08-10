import type { ToolHandler } from '../types.js';
import type { HaybaToolMeta } from '../hayba-tool-meta.js';
import { errorResult, okResult } from '../tool-result.js';
import { getMemoryStore } from './store.js';

export const meta: HaybaToolMeta = {
  cost: 'low',
  effects: [],
  when: 'browsing recent memory blocks for a role/scope, most-recent-first, with no keyword in mind.',
  not_when: 'you are looking for a specific block by keyword (use memory_recall) — that filters, this just paginates.',
};

export const memoryListHandler: ToolHandler = async (args) => {
  const scope = args.scope as 'private' | 'shared' | undefined;
  if (scope !== undefined && scope !== 'private' && scope !== 'shared') {
    return errorResult('scope must be "private" or "shared" when given');
  }
  const agentRole = args.agentRole !== undefined ? String(args.agentRole) : undefined;
  const limit = typeof args.limit === 'number' ? args.limit : 50;

  const store = getMemoryStore();
  const blocks = store.query({ scope, agentRole, limit });
  const total = store.count({ scope, agentRole });

  return okResult({ blocks, count: blocks.length, total_matching: total, truncated: total > blocks.length });
};
