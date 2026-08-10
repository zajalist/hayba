import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { __resetMemoryStoreForTests } from './store.js';
import { memoryWriteHandler } from './write.js';
import { memoryRecallHandler } from './recall.js';
import { memoryListHandler } from './list.js';
import { memoryDeleteHandler } from './delete.js';
import { memoryExportHandler } from './export-blocks.js';
import { memoryImportHandler } from './import-blocks.js';
import { memoryPruneHandler } from './prune.js';

// Every memory_* tool goes through getMemoryStore(), which reads
// config.memoryDbPath (HAYBA_MEMORY_DB) lazily. Point it at a fresh in-memory
// DB per test so tests can't see each other's writes, and force the singleton
// to reopen even though the literal path string (':memory:') repeats.
let tmpDir: string;

beforeEach(() => {
  process.env.HAYBA_MEMORY_DB = ':memory:';
  process.env.HAYBA_MEMORY_MAX_COUNT = '2000';
  process.env.HAYBA_MEMORY_MAX_AGE_DAYS = '90';
  __resetMemoryStoreForTests();
  tmpDir = mkdtempSync(join(tmpdir(), 'hayba-memory-test-'));
});

afterEach(() => {
  __resetMemoryStoreForTests();
  delete process.env.HAYBA_MEMORY_DB;
  delete process.env.HAYBA_MEMORY_MAX_COUNT;
  delete process.env.HAYBA_MEMORY_MAX_AGE_DAYS;
  rmSync(tmpDir, { recursive: true, force: true });
});

function parse(result: { content: Array<{ type: 'text'; text: string }> }): any {
  return JSON.parse(result.content[0].text);
}

describe('memory_write', () => {
  it('writes a block and returns its id plus an explicit (zero) retention report', async () => {
    const r = await memoryWriteHandler(
      { agentRole: 'director', scope: 'shared', intent: 'plan', content: 'forest -> river', tokenCost: 5 },
      {},
    );
    const body = parse(r);
    expect(body.ok).toBe(true);
    expect(typeof body.id).toBe('string');
    expect(body.retention).toEqual({ pruned_by_age: 0, pruned_by_count: 0, pruned_total: 0, remaining: 1 });
  });

  it('rejects a missing required field', async () => {
    const r = await memoryWriteHandler({ agentRole: 'director', scope: 'shared', content: 'x' }, {});
    expect(r.isError).toBe(true);
    expect(parse(r).error).toMatch(/intent/);
  });

  it('rejects an invalid scope', async () => {
    const r = await memoryWriteHandler({ agentRole: 'd', scope: 'public', intent: 'i', content: 'c' }, {});
    expect(r.isError).toBe(true);
  });
});

describe('memory_recall', () => {
  it('finds a block by keyword in intent/content and misses on an unrelated keyword', async () => {
    await memoryWriteHandler({ agentRole: 'd', scope: 'shared', intent: 'establish biome plan', content: 'forest -> river -> ruins' }, {});
    await memoryWriteHandler({ agentRole: 'd', scope: 'shared', intent: 'unrelated', content: 'nothing to do with rivers' }, {});

    const hit = parse(await memoryRecallHandler({ text: 'river' }, {}));
    expect(hit.count).toBe(2);

    const miss = parse(await memoryRecallHandler({ text: 'volcano' }, {}));
    expect(miss.count).toBe(0);
  });

  it('requires text', async () => {
    const r = await memoryRecallHandler({}, {});
    expect(r.isError).toBe(true);
  });
});

describe('memory_list', () => {
  it('lists most-recent-first without a keyword filter', async () => {
    // Both timestamps are recent (well inside the 90-day retention window) —
    // only their relative order matters here, not how old they are.
    await memoryWriteHandler({ agentRole: 'd', scope: 'shared', intent: 'old', content: 'c', timestamp: Date.now() - 1000 } as any, {});
    await memoryWriteHandler({ agentRole: 'd', scope: 'shared', intent: 'new', content: 'c' }, {});
    const body = parse(await memoryListHandler({}, {}));
    expect(body.count).toBe(2);
    expect(body.blocks[0].intent).toBe('new');
  });

  it('filters by agentRole', async () => {
    await memoryWriteHandler({ agentRole: 'a', scope: 'shared', intent: 'x', content: 'c' }, {});
    await memoryWriteHandler({ agentRole: 'b', scope: 'shared', intent: 'y', content: 'c' }, {});
    const body = parse(await memoryListHandler({ agentRole: 'a' }, {}));
    expect(body.count).toBe(1);
    expect(body.blocks[0].agentRole).toBe('a');
  });
});

describe('memory_delete', () => {
  it('deletes a single block by id', async () => {
    const w = parse(await memoryWriteHandler({ agentRole: 'd', scope: 'shared', intent: 'x', content: 'c' }, {}));
    const del = parse(await memoryDeleteHandler({ id: w.id }, {}));
    expect(del.ok).toBe(true);
    expect(del.deleted_count).toBe(1);
    expect(parse(await memoryListHandler({}, {})).count).toBe(0);
  });

  it('reports ok:false and deleted_count:0 for an id that does not exist', async () => {
    const del = parse(await memoryDeleteHandler({ id: 'nonexistent' }, {}));
    expect(del.ok).toBe(false);
    expect(del.deleted_count).toBe(0);
  });

  it('deletes every block for one agentRole and leaves others', async () => {
    await memoryWriteHandler({ agentRole: 'a', scope: 'shared', intent: 'x', content: 'c' }, {});
    await memoryWriteHandler({ agentRole: 'b', scope: 'shared', intent: 'y', content: 'c' }, {});
    const del = parse(await memoryDeleteHandler({ agentRole: 'a' }, {}));
    expect(del.deleted_count).toBe(1);
    const remaining = parse(await memoryListHandler({}, {}));
    expect(remaining.count).toBe(1);
    expect(remaining.blocks[0].agentRole).toBe('b');
  });

  it('refuses to guess: no id/agentRole/confirm_all is an error', async () => {
    const r = await memoryDeleteHandler({}, {});
    expect(r.isError).toBe(true);
  });

  it('confirm_all wipes the whole store', async () => {
    await memoryWriteHandler({ agentRole: 'a', scope: 'shared', intent: 'x', content: 'c' }, {});
    await memoryWriteHandler({ agentRole: 'b', scope: 'shared', intent: 'y', content: 'c' }, {});
    const del = parse(await memoryDeleteHandler({ confirm_all: true }, {}));
    expect(del.deleted_count).toBe(2);
    expect(del.remaining).toBe(0);
  });
});

describe('retention actually bounds the store', () => {
  it('memory_write prunes down to max_count after exceeding it', async () => {
    process.env.HAYBA_MEMORY_MAX_COUNT = '3';
    let last: any;
    for (let i = 0; i < 5; i++) {
      last = parse(await memoryWriteHandler({ agentRole: 'd', scope: 'shared', intent: `i${i}`, content: 'c' }, {}));
    }
    // 5 writes against a bound of 3: the last write's own retention report
    // must show pruning happened, and the store must actually be at the bound.
    expect(last.retention.remaining).toBe(3);
    expect(parse(await memoryListHandler({ limit: 100 }, {})).count).toBe(3);
  });

  it('memory_prune enforces max_age_days and reports the exact count removed', async () => {
    // Two blocks: one 200 days old, one fresh. Write with a huge age bound so
    // memory_write's own automatic retention doesn't pre-empt the ancient one —
    // this test is isolating memory_prune's explicit bound, not the write path.
    process.env.HAYBA_MEMORY_MAX_AGE_DAYS = '99999';
    const twoHundredDaysAgo = Date.now() - 200 * 24 * 60 * 60 * 1000;
    await memoryWriteHandler({ agentRole: 'd', scope: 'shared', intent: 'ancient', content: 'c', timestamp: twoHundredDaysAgo } as any, {});
    await memoryWriteHandler({ agentRole: 'd', scope: 'shared', intent: 'fresh', content: 'c' }, {});

    const pruned = parse(await memoryPruneHandler({ max_age_days: 90 }, {}));
    expect(pruned.pruned_by_age).toBe(1);
    expect(pruned.remaining).toBe(1);
    const left = parse(await memoryListHandler({}, {}));
    expect(left.blocks[0].intent).toBe('fresh');
  });
});

describe('export -> import round trip', () => {
  it('round-trips blocks through a file and reports inserted/skipped/conflicted', async () => {
    await memoryWriteHandler({ agentRole: 'd', scope: 'shared', intent: 'a', content: 'c1' }, {});
    await memoryWriteHandler({ agentRole: 'd', scope: 'shared', intent: 'b', content: 'c2' }, {});
    const path = join(tmpDir, 'export.json');

    const exp = parse(await memoryExportHandler({ path }, {}));
    expect(exp.ok).toBe(true);
    expect(exp.count).toBe(2);

    // Wipe the store, then import back from the file.
    await memoryDeleteHandler({ confirm_all: true }, {});
    expect(parse(await memoryListHandler({}, {})).count).toBe(0);

    const imp = parse(await memoryImportHandler({ path }, {}));
    expect(imp.ok).toBe(true);
    expect(imp.total_read).toBe(2);
    expect(imp.inserted).toBe(2);
    expect(imp.skipped).toBe(0);
    expect(imp.conflicted).toBe(0);

    const after = parse(await memoryListHandler({ limit: 100 }, {}));
    expect(after.count).toBe(2);
    expect(after.blocks.map((b: any) => b.intent).sort()).toEqual(['a', 'b']);
  });

  it('re-importing the same file reports every row as conflicted and skipped (not duplicated)', async () => {
    await memoryWriteHandler({ agentRole: 'd', scope: 'shared', intent: 'a', content: 'c1' }, {});
    const path = join(tmpDir, 'export.json');
    await memoryExportHandler({ path }, {});

    const imp = parse(await memoryImportHandler({ path }, {}));
    expect(imp.inserted).toBe(0);
    expect(imp.conflicted).toBe(1);
    expect(parse(await memoryListHandler({}, {})).count).toBe(1);
  });

  it('on_conflict=replace overwrites the existing row instead of skipping it', async () => {
    const w = parse(await memoryWriteHandler({ agentRole: 'd', scope: 'shared', intent: 'original', content: 'c1' }, {}));
    const path = join(tmpDir, 'export.json');
    await memoryExportHandler({ path }, {});

    // Mutate the live block, then import the (stale) export with replace.
    await memoryDeleteHandler({ id: w.id }, {});
    await memoryWriteHandler({ agentRole: 'd', scope: 'shared', intent: 'changed', content: 'c2', id: w.id } as any, {});

    const imp = parse(await memoryImportHandler({ path, on_conflict: 'replace' }, {}));
    expect(imp.conflicted).toBe(1);
    expect(imp.inserted).toBe(0);

    const after = parse(await memoryListHandler({}, {}));
    expect(after.blocks[0].intent).toBe('original');
  });
});
