import type { ToolHandler } from '../types.js';
import type { HaybaToolMeta } from '../hayba-tool-meta.js';
import { errorResult, okResult } from '../tool-result.js';
import { getMemoryStore } from './store.js';

export const meta: HaybaToolMeta = {
  cost: 'low',
  effects: ['modifies_memory_state'],
  when: 'removing a specific memory block by id, every block written by one agentRole, or (with explicit confirm_all) the entire store.',
  not_when: 'you just want old entries to age out automatically — that is retention, applied on every memory_write.',
};

export const memoryDeleteHandler: ToolHandler = async (args) => {
  const id = args.id !== undefined ? String(args.id) : undefined;
  const agentRole = args.agentRole !== undefined ? String(args.agentRole) : undefined;
  const confirmAll = args.confirm_all === true;

  const provided = [id, agentRole, confirmAll ? 'confirm_all' : undefined].filter(Boolean).length;
  if (provided === 0) {
    return errorResult('one of id, agentRole, or confirm_all=true is required — memory_delete refuses to guess scope');
  }
  if (provided > 1) {
    return errorResult('pass exactly one of id, agentRole, or confirm_all=true, not several at once');
  }

  const store = getMemoryStore();

  if (id) {
    const deleted = store.deleteById(id);
    return okResult({ ok: deleted, id, deleted_count: deleted ? 1 : 0 });
  }

  if (agentRole) {
    const before = store.count({ agentRole });
    store.clear(agentRole);
    return okResult({ ok: true, agentRole, deleted_count: before });
  }

  // confirm_all
  const before = store.count();
  store.clear();
  return okResult({ ok: true, deleted_count: before, remaining: store.count() });
};
