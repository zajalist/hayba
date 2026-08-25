// mcp-tools/hayba-mcp/src/tools/dag/dag-tools.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setupDagSystem } from '../../dag/index.js';
import { dagStatusHandler } from './status.js';
import { dagRecordHandler } from './record.js';
import { dagRebuildHandler } from './rebuild.js';
import { journalTailHandler } from './journal-tail.js';

describe('dag tools', () => {
  let dir: string;
  let sys: ReturnType<typeof setupDagSystem>;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'hayba-dagtool-')); sys = setupDagSystem({ projectDir: dir }); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('dag_record appends a mutation and dag_status reflects it', async () => {
    const rec = await dagRecordHandler({ reads: ['ue://A'], writes: ['sliver://B'] }, { dag: sys });
    expect(rec.ok).toBe(true);
    const status = await dagStatusHandler({}, { dag: sys });
    expect(status.nodeCount).toBe(2);
    expect(status.edges).toHaveLength(1);
  });

  it('dag_record rejects malformed uris', async () => {
    const rec = await dagRecordHandler({ writes: ['not a uri'] }, { dag: sys });
    expect(rec.ok).toBe(false);
  });

  it('dag_status dirtyOnly returns only dirty nodes', async () => {
    await dagRecordHandler({ reads: ['ue://A'], writes: ['sliver://B'] }, { dag: sys });
    await dagRecordHandler({ writes: ['ue://A'] }, { dag: sys });
    const status = await dagStatusHandler({ dirtyOnly: true }, { dag: sys });
    expect(status.nodes.map(n => n.uri)).toEqual(['sliver://B']);
  });

  it('dag_rebuild reports skipped nodes with no executor', async () => {
    await dagRecordHandler({ reads: ['ue://A'], writes: ['ue://B'] }, { dag: sys });
    await dagRecordHandler({ writes: ['ue://A'] }, { dag: sys });
    const r = await dagRebuildHandler({}, { dag: sys, runRecipeNode: async () => ({ ok: false, reason: 'not a recipe node' }) });
    expect(r.skipped).toEqual([{ uri: 'ue://B', reason: 'not a recipe node' }]);
  });

  it('journal_tail returns recent records newest last', async () => {
    await dagRecordHandler({ writes: ['ue://A'], note: 'first' }, { dag: sys });
    await dagRecordHandler({ writes: ['ue://B'], note: 'second' }, { dag: sys });
    const t = await journalTailHandler({ limit: 1 }, { dag: sys });
    expect(t.entries).toHaveLength(1);
    expect(t.entries[0].note).toBe('second');
  });
});
