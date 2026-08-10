import { readFileSync } from 'node:fs';
import type { ToolHandler } from '../types.js';
import type { HaybaToolMeta } from '../hayba-tool-meta.js';
import { errorResult, okResult } from '../tool-result.js';
import { getMemoryStore } from './store.js';
import type { MemoryBlock, MemoryExport } from '../../gaea/memory/hayba-memory.js';

export const meta: HaybaToolMeta = {
  cost: 'low',
  effects: ['modifies_memory_state'],
  when: 'loading a memory_export JSON file back into the store — restoring a backup or merging another agent\'s export.',
  not_when: 'writing a single new memory block (use memory_write) — this is for the portable export/import file format specifically.',
};

function isExportEnvelope(v: unknown): v is MemoryExport {
  return (
    !!v &&
    typeof v === 'object' &&
    Array.isArray((v as MemoryExport).blocks) &&
    (v as MemoryExport).version === 1
  );
}

export const memoryImportHandler: ToolHandler = async (args) => {
  const path = args.path !== undefined ? String(args.path) : undefined;
  if (!path) return errorResult('path is required — file previously written by memory_export');

  const onConflict = args.on_conflict === 'replace' ? 'replace' : 'skip';

  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch (e) {
    return errorResult(`failed to read import file: ${(e as Error).message}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return errorResult(`import file is not valid JSON: ${(e as Error).message}`);
  }

  let blocks: MemoryBlock[];
  if (isExportEnvelope(parsed)) {
    blocks = parsed.blocks;
  } else if (Array.isArray(parsed)) {
    // Tolerate a bare array of blocks too, not just the {version, blocks} envelope.
    blocks = parsed as MemoryBlock[];
  } else {
    return errorResult('import file must be a memory_export envelope ({version:1, blocks:[...]}) or a bare array of blocks');
  }

  const store = getMemoryStore();
  const result = store.importBlocks(blocks, { onConflict });

  return okResult({
    ok: true,
    path,
    on_conflict: onConflict,
    total_read: blocks.length,
    inserted: result.inserted,
    skipped: result.skipped,
    conflicted: result.conflicted,
    errors: result.errors,
  });
};
