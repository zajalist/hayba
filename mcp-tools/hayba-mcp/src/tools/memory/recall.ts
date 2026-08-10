import type { ToolHandler } from '../types.js';
import type { HaybaToolMeta } from '../hayba-tool-meta.js';
import { errorResult, okResult } from '../tool-result.js';
import { getMemoryStore } from './store.js';

export const meta: HaybaToolMeta = {
  cost: 'low',
  effects: [],
  when:
    'looking for a specific past memory block by keyword — "what did we decide about X", "find the handoff about Y". Searches intent and content text.',
  not_when:
    'you want everything a role has written with no keyword (use memory_list instead), or you are searching UE content/assets (use asset_search / docs_search).',
};

export const memoryRecallHandler: ToolHandler = async (args) => {
  const text = args.text !== undefined ? String(args.text) : undefined;
  if (!text) return errorResult('text is required — memory_recall searches for a keyword; use memory_list to browse without one');

  const scope = args.scope as 'private' | 'shared' | undefined;
  if (scope !== undefined && scope !== 'private' && scope !== 'shared') {
    return errorResult('scope must be "private" or "shared" when given');
  }
  const agentRole = args.agentRole !== undefined ? String(args.agentRole) : undefined;
  const limit = typeof args.limit === 'number' ? args.limit : 10;

  const store = getMemoryStore();
  const blocks = store.query({ text, scope, agentRole, limit });

  return okResult({ blocks, count: blocks.length, query: { text, scope, agentRole, limit } });
};
