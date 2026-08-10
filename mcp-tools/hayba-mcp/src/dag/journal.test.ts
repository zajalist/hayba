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

  it('redacts secrets before disk, memory, tail, and replay while preserving useful notes', () => {
    const j = new OperationJournal(path);
    const input: JournalInput = {
      ...sample,
      actor: 'https://example.test/op?token=SENTINEL_QUERY',
      reads: ['Bearer SENTINEL_READ_123456'],
      note: 'Authorization: Bearer SENTINEL_NOTE_123456; recovery: rotate and retry',
    };
    const record = j.append(input);
    const disk = readFileSync(path, 'utf8');
    expect(JSON.stringify(record)).not.toContain('SENTINEL');
    expect(disk).not.toContain('SENTINEL');
    expect(record.note).toContain('recovery: rotate and retry');
    expect(record.securityRedaction).toMatchObject({ applied: true });
    expect(JSON.stringify(j.tail(1))).not.toContain('SENTINEL');
    expect(JSON.stringify(new OperationJournal(path).all())).not.toContain('SENTINEL');
    expect(input.note).toContain('SENTINEL_NOTE');
  });

  it('sanitizes a legacy on-disk journal before exposing or retaining it', () => {
    const legacy = {
      ...sample,
      note: 'apiKey=SENTINEL_LEGACY',
      ts: new Date(0).toISOString(),
      seq: 1,
    };
    writeFileSync(path, `${JSON.stringify(legacy)}\n`, 'utf8');
    const journal = new OperationJournal(path);
    expect(JSON.stringify(journal.all())).not.toContain('SENTINEL_LEGACY');
    expect(readFileSync(path, 'utf8')).not.toContain('SENTINEL_LEGACY');
  });
});
