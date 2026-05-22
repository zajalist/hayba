// mcp-tools/hayba-mcp/src/dag/journal.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OperationJournal, type JournalInput } from './journal.js';

const sample: JournalInput = {
  actor: 'sliver:com.test.demo',
  reads: ['ue://Game/A'],
  writes: ['sliver://run/x'],
  paramsHash: 'sha256:abc',
  ok: true,
};

describe('OperationJournal', () => {
  let dir: string;
  let path: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'hayba-jrnl-')); path = join(dir, 'journal.jsonl'); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('append assigns gap-free monotonic seq starting at 1', () => {
    const j = new OperationJournal(path);
    expect(j.append(sample).seq).toBe(1);
    expect(j.append(sample).seq).toBe(2);
    expect(j.append(sample).seq).toBe(3);
  });

  it('append stamps an ISO timestamp and persists to disk', () => {
    const j = new OperationJournal(path);
    const r = j.append(sample);
    expect(r.ts).toMatch(/^\d{4}-\d\d-\d\dT/);
    expect(readFileSync(path, 'utf8').trim().split('\n')).toHaveLength(1);
  });

  it('a fresh journal over an existing file continues the seq', () => {
    new OperationJournal(path).append(sample);
    const j2 = new OperationJournal(path);
    expect(j2.append(sample).seq).toBe(2);
  });

  it('tail returns the last N records, newest last', () => {
    const j = new OperationJournal(path);
    for (let i = 0; i < 5; i++) j.append({ ...sample, actor: `a${i}` });
    expect(j.tail(2).map(r => r.actor)).toEqual(['a3', 'a4']);
  });

  it('all() returns every record in seq order', () => {
    const j = new OperationJournal(path);
    j.append(sample); j.append(sample);
    expect(j.all().map(r => r.seq)).toEqual([1, 2]);
  });

  it('tolerates a corrupt / truncated trailing line on re-open', () => {
    const j = new OperationJournal(path);
    j.append(sample);
    writeFileSync(path, readFileSync(path, 'utf8') + '{ truncated', 'utf8');
    const j2 = new OperationJournal(path);
    expect(j2.all()).toHaveLength(1);
    expect(j2.append(sample).seq).toBe(2);
  });

  it('note defaults to null when omitted', () => {
    const j = new OperationJournal(path);
    expect(j.append(sample).note).toBeNull();
  });
});
