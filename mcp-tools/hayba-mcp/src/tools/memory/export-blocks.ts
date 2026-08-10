import { writeFileSync } from 'node:fs';
import type { ToolHandler } from '../types.js';
import type { HaybaToolMeta } from '../hayba-tool-meta.js';
import { errorResult, okResult } from '../tool-result.js';
import { getMemoryStore } from './store.js';
import type { MemoryExport } from '../../gaea/memory/hayba-memory.js';

export const meta: HaybaToolMeta = {
  cost: 'low',
  effects: ['filesystem_write'],
  when: 'backing up the memory store, or moving blocks to another machine/DB before memory_import there.',
  not_when: 'you just want to read the blocks (use memory_list / memory_recall) — this writes a portable JSON file, it does not return the blocks inline.',
};

export const memoryExportHandler: ToolHandler = async (args) => {
  const path = args.path !== undefined ? String(args.path) : undefined;
  if (!path) return errorResult('path is required — file to write the export to');

  const scope = args.scope as 'private' | 'shared' | undefined;
  if (scope !== undefined && scope !== 'private' && scope !== 'shared') {
    return errorResult('scope must be "private" or "shared" when given');
  }
  const agentRole = args.agentRole !== undefined ? String(args.agentRole) : undefined;

  const store = getMemoryStore();
  const blocks = store.exportBlocks({ scope, agentRole });
  const payload: MemoryExport = { version: 1, exportedAt: Date.now(), blocks };

  try {
    writeFileSync(path, JSON.stringify(payload, null, 2), 'utf-8');
  } catch (e) {
    return errorResult(`failed to write export file: ${(e as Error).message}`);
  }

  return okResult({ ok: true, path, count: blocks.length });
};
