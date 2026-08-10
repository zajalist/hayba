import type { ToolHandler } from '../types.js';
import type { HaybaToolMeta } from '../hayba-tool-meta.js';
import { errorResult, okResult } from '../tool-result.js';
import { getMemoryStore } from './store.js';
import { config } from '../../config.js';

export const meta: HaybaToolMeta = {
  cost: 'low',
  effects: ['modifies_memory_state'],
  when:
    'you have something worth handing to a future turn or another agent — an established plan, a decision and why it was made, a handoff — and want it retrievable later by role/scope/text.',
  not_when:
    'the information belongs in the conversation only, or you want durable cross-session notes about the USER\'S preferences/workflow (that is Claude\'s own memory file, not this store). Not a substitute for a written plan doc.',
};

export const memoryWriteHandler: ToolHandler = async (args) => {
  const agentRole = String(args.agentRole ?? '').trim();
  const scope = args.scope as 'private' | 'shared';
  const intent = String(args.intent ?? '').trim();
  const content = args.content as string;

  if (!agentRole) return errorResult('agentRole is required');
  if (scope !== 'private' && scope !== 'shared') return errorResult('scope must be "private" or "shared"');
  if (!intent) return errorResult('intent is required');
  if (typeof content !== 'string' || content.length === 0) return errorResult('content is required');

  const accessedResources = Array.isArray(args.accessedResources)
    ? (args.accessedResources as unknown[]).map(String)
    : [];
  const tokenCost = typeof args.tokenCost === 'number' ? args.tokenCost : 0;
  const provenance =
    args.provenance && typeof args.provenance === 'object' ? (args.provenance as Record<string, unknown>) : undefined;

  const explicitId = args.id !== undefined ? String(args.id) : undefined;
  const timestamp = typeof args.timestamp === 'number' ? args.timestamp : undefined;

  const store = getMemoryStore();
  const id = store.write({ id: explicitId, agentRole, scope, intent, content, accessedResources, tokenCost, provenance, timestamp });

  // Retention is applied on every write, never silently: the response always
  // names what (if anything) was pruned, using the bounds from config
  // (HAYBA_MEMORY_MAX_COUNT / HAYBA_MEMORY_MAX_AGE_DAYS).
  const retention = store.applyRetention({
    maxCount: config.memoryMaxCount,
    maxAgeMs: config.memoryMaxAgeMs,
  });

  return okResult({
    ok: true,
    id,
    retention: {
      pruned_by_age: retention.prunedByAge,
      pruned_by_count: retention.prunedByCount,
      pruned_total: retention.prunedTotal,
      remaining: retention.remaining,
    },
  });
};
