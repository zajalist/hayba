// Lazy singleton wiring for the agent memory store (issue #355).
//
// HaybaMemory (src/gaea/memory/hayba-memory.ts) is a plain class with no
// opinion on where its DB file lives or when it's opened — this module is
// the one place that decides both, so every memory_* tool shares one
// connection instead of racing to open the file.
import { mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { HaybaMemory } from '../../gaea/memory/hayba-memory.js';
import { config } from '../../config.js';

let instance: HaybaMemory | null = null;
let instancePath: string | null = null;

/**
 * Return the process-wide HaybaMemory instance, opening it on first call.
 * Re-opens if `config.memoryDbPath` changes between calls (tests set
 * HAYBA_MEMORY_DB per-case) so nothing stays pinned to a stale path.
 */
export function getMemoryStore(): HaybaMemory {
  const path = config.memoryDbPath;
  if (instance && instancePath === path) return instance;
  if (instance) instance.close();

  if (path !== ':memory:') {
    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }
  instance = new HaybaMemory(path);
  instancePath = path;
  return instance;
}

/** Test-only: force the next getMemoryStore() call to open a fresh instance. */
export function __resetMemoryStoreForTests(): void {
  if (instance) instance.close();
  instance = null;
  instancePath = null;
}
