// mcp-tools/hayba-mcp/src/dag/journal.ts
//
// Append-only JSONL journal of every mutation. One record per line.
// Durable: append() writes through to disk immediately. On construction
// the file is replayed to recover the last seq and the in-memory list;
// a corrupt or truncated line is skipped, not fatal.

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { redactSecrets, type SecretRedactionSummary } from '../security/secret-redaction.js';

export interface JournalInput {
  actor: string;
  reads: string[];
  writes: string[];
  paramsHash: string;
  ok: boolean;
  note?: string | null;
}

export interface JournalRecord extends Required<JournalInput> {
  ts: string;
  seq: number;
  securityRedaction?: SecretRedactionSummary;
}

export class OperationJournal {
  private readonly path: string;
  private records: JournalRecord[] = [];
  private lastSeq = 0;

  constructor(path: string) {
    this.path = path;
    this.replay();
  }

  append(input: JournalInput): JournalRecord {
    const raw: JournalRecord = {
      ts: new Date().toISOString(),
      seq: ++this.lastSeq,
      actor: input.actor,
      reads: input.reads,
      writes: input.writes,
      paramsHash: input.paramsHash,
      ok: input.ok,
      note: input.note ?? null,
    };
    const redacted = redactSecrets(raw);
    const rec: JournalRecord = redacted.summary.applied || redacted.summary.truncated
      ? { ...(redacted.value as JournalRecord), securityRedaction: redacted.summary }
      : redacted.value as JournalRecord;
    mkdirSync(dirname(this.path), { recursive: true });
    appendFileSync(this.path, JSON.stringify(rec) + '\n', 'utf8');
    this.records.push(rec);
    return rec;
  }

  all(): JournalRecord[] { return [...this.records]; }

  tail(limit: number): JournalRecord[] {
    return this.records.slice(Math.max(0, this.records.length - limit));
  }

  private replay(): void {
    if (!existsSync(this.path)) return;
    const lines = readFileSync(this.path, 'utf8').split('\n');
    let sanitizedLegacyRecord = false;
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed) as JournalRecord;
        if (typeof parsed.seq !== 'number') continue;
        const redacted = redactSecrets(parsed);
        const rec = redacted.summary.applied || redacted.summary.truncated
          ? { ...(redacted.value as JournalRecord), securityRedaction: redacted.summary }
          : redacted.value as JournalRecord;
        sanitizedLegacyRecord ||= rec !== parsed;
        this.records.push(rec);
        this.lastSeq = Math.max(this.lastSeq, rec.seq);
      } catch {
        // Corrupt / truncated line — skip, keep replaying.
      }
    }
    if (sanitizedLegacyRecord) {
      writeFileSync(this.path, this.records.map((record) => JSON.stringify(record)).join('\n') + '\n', 'utf8');
    }
  }
}
