// Agent memory store: small SQLite-backed blocks an agent writes and later
// recalls (established biome plans, cross-agent handoffs, etc.).
//
// Uses node's built-in `node:sqlite` (DatabaseSync) rather than the
// `better-sqlite3` native module this file used to depend on. Three other
// tools in this package (match-pin-names.ts, query-pcgex-docs.ts,
// scrape-node-registry.ts) already made that move — `node:sqlite` ships with
// the runtime, so there is no native-binary build step to fail in a
// CI-less/offline environment, at the cost of the "experimental" warning
// Node prints on first use. See src/types/node-sqlite.d.ts for why the
// typings are resolved defensively.
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');

export interface MemoryBlock {
  id?: string;
  agentRole: string;
  scope: 'private' | 'shared';
  intent: string;
  content: string;
  accessedResources: string[];
  tokenCost: number;
  provenance?: Record<string, unknown>;
  timestamp?: number;
}

/** Bounded retention policy. Both bounds are optional; an unset bound is not enforced. */
export interface RetentionPolicy {
  /** Delete blocks older than this many milliseconds. */
  maxAgeMs?: number;
  /** After age-pruning, if more than this many blocks remain, delete the oldest excess. */
  maxCount?: number;
}

export interface RetentionResult {
  prunedByAge: number;
  prunedByCount: number;
  prunedTotal: number;
  remaining: number;
}

export interface ImportOptions {
  /** 'skip' (default) leaves an existing id untouched; 'replace' overwrites it. */
  onConflict?: 'skip' | 'replace';
}

export interface ImportResult {
  inserted: number;
  skipped: number;
  conflicted: number;
  errors: string[];
}

/** Portable export/import envelope. */
export interface MemoryExport {
  version: 1;
  exportedAt: number;
  blocks: MemoryBlock[];
}

export class HaybaMemory {
  private db: InstanceType<typeof DatabaseSync>;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memory_blocks (
        id TEXT PRIMARY KEY,
        agent_role TEXT NOT NULL,
        scope TEXT NOT NULL,
        intent TEXT NOT NULL,
        content TEXT NOT NULL,
        accessed_resources TEXT,
        timestamp INTEGER NOT NULL,
        provenance TEXT,
        token_cost INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_scope_role ON memory_blocks(scope, agent_role);
      CREATE INDEX IF NOT EXISTS idx_timestamp ON memory_blocks(timestamp);
    `);
  }

  write(b: MemoryBlock): string {
    const id = b.id ?? randomUUID();
    this.db
      .prepare(
        `INSERT INTO memory_blocks
          (id, agent_role, scope, intent, content, accessed_resources, timestamp, provenance, token_cost)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        b.agentRole,
        b.scope,
        b.intent,
        b.content,
        JSON.stringify(b.accessedResources),
        b.timestamp ?? Date.now(),
        JSON.stringify(b.provenance ?? {}),
        b.tokenCost,
      );
    return id;
  }

  /**
   * Query blocks, most recent first. `text` (when given) filters to blocks
   * whose intent or content contains it (case-sensitive SQL LIKE substring
   * match) — this is the "search" half of recall; omit it for a plain list.
   */
  query(opts: {
    scope?: 'private' | 'shared';
    agentRole?: string;
    text?: string;
    limit?: number;
  }): MemoryBlock[] {
    const where: string[] = [];
    const args: unknown[] = [];
    if (opts.scope) {
      where.push('scope = ?');
      args.push(opts.scope);
    }
    if (opts.agentRole) {
      where.push('agent_role = ?');
      args.push(opts.agentRole);
    }
    if (opts.text) {
      where.push('(intent LIKE ? OR content LIKE ?)');
      const needle = `%${opts.text}%`;
      args.push(needle, needle);
    }
    const sql = `SELECT * FROM memory_blocks ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
                 ORDER BY timestamp DESC LIMIT ?`;
    args.push(opts.limit ?? 50);
    const rows = this.db.prepare(sql).all(...(args as [])) as Array<Record<string, unknown>>;
    return rows.map(rowToBlock);
  }

  /** Total block count, optionally filtered the same way `query` is. */
  count(opts: { scope?: 'private' | 'shared'; agentRole?: string } = {}): number {
    const where: string[] = [];
    const args: unknown[] = [];
    if (opts.scope) {
      where.push('scope = ?');
      args.push(opts.scope);
    }
    if (opts.agentRole) {
      where.push('agent_role = ?');
      args.push(opts.agentRole);
    }
    const sql = `SELECT COUNT(*) AS n FROM memory_blocks ${where.length ? 'WHERE ' + where.join(' AND ') : ''}`;
    const row = this.db.prepare(sql).get(...(args as [])) as { n: number };
    return row.n;
  }

  /** Delete a single block by id. Returns whether a row was actually removed. */
  deleteById(id: string): boolean {
    const r = this.db.prepare('DELETE FROM memory_blocks WHERE id = ?').run(id);
    return r.changes > 0;
  }

  clear(agentRole?: string): void {
    if (agentRole) {
      this.db.prepare('DELETE FROM memory_blocks WHERE agent_role = ?').run(agentRole);
    } else {
      this.db.prepare('DELETE FROM memory_blocks').run();
    }
  }

  /**
   * Enforce a bounded retention policy. Age-pruning runs first, then
   * count-pruning (oldest-first) against whatever remains, so both bounds
   * compose rather than fight. Always returns counts, including zero — the
   * caller is expected to report this, not swallow it, so retention is never
   * a silent side effect.
   */
  applyRetention(policy: RetentionPolicy): RetentionResult {
    let prunedByAge = 0;
    if (policy.maxAgeMs !== undefined) {
      const cutoff = Date.now() - policy.maxAgeMs;
      const r = this.db.prepare('DELETE FROM memory_blocks WHERE timestamp < ?').run(cutoff);
      prunedByAge = Number(r.changes);
    }

    let prunedByCount = 0;
    if (policy.maxCount !== undefined) {
      const total = this.count();
      const excess = total - policy.maxCount;
      if (excess > 0) {
        // Delete the oldest `excess` rows.
        const r = this.db
          .prepare(
            `DELETE FROM memory_blocks WHERE id IN (
               SELECT id FROM memory_blocks ORDER BY timestamp ASC LIMIT ?
             )`,
          )
          .run(excess);
        prunedByCount = Number(r.changes);
      }
    }

    return {
      prunedByAge,
      prunedByCount,
      prunedTotal: prunedByAge + prunedByCount,
      remaining: this.count(),
    };
  }

  /** All blocks matching the filter, unbounded (no LIMIT) — used for export. */
  exportBlocks(opts: { scope?: 'private' | 'shared'; agentRole?: string } = {}): MemoryBlock[] {
    const where: string[] = [];
    const args: unknown[] = [];
    if (opts.scope) {
      where.push('scope = ?');
      args.push(opts.scope);
    }
    if (opts.agentRole) {
      where.push('agent_role = ?');
      args.push(opts.agentRole);
    }
    const sql = `SELECT * FROM memory_blocks ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY timestamp ASC`;
    const rows = this.db.prepare(sql).all(...(args as [])) as Array<Record<string, unknown>>;
    return rows.map(rowToBlock);
  }

  /**
   * Insert a batch of previously-exported blocks. Reports what actually
   * happened rather than a bare "ok": how many were newly inserted, how many
   * were malformed and skipped, and how many collided with an existing id
   * (left alone under 'skip', overwritten under 'replace').
   */
  importBlocks(blocks: MemoryBlock[], opts: ImportOptions = {}): ImportResult {
    const onConflict = opts.onConflict ?? 'skip';
    const result: ImportResult = { inserted: 0, skipped: 0, conflicted: 0, errors: [] };

    for (const [i, b] of blocks.entries()) {
      if (!b || typeof b !== 'object' || !b.agentRole || !b.scope || !b.intent || b.content === undefined) {
        result.skipped++;
        result.errors.push(`block[${i}]: missing required field(s) (agentRole/scope/intent/content)`);
        continue;
      }
      const id = b.id ?? randomUUID();
      const existing = this.db.prepare('SELECT 1 FROM memory_blocks WHERE id = ?').get(id);
      if (existing) {
        result.conflicted++;
        if (onConflict === 'skip') continue;
        // 'replace': fall through and overwrite below.
      }
      this.db
        .prepare(
          `INSERT INTO memory_blocks
            (id, agent_role, scope, intent, content, accessed_resources, timestamp, provenance, token_cost)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             agent_role=excluded.agent_role, scope=excluded.scope, intent=excluded.intent,
             content=excluded.content, accessed_resources=excluded.accessed_resources,
             timestamp=excluded.timestamp, provenance=excluded.provenance, token_cost=excluded.token_cost`,
        )
        .run(
          id,
          b.agentRole,
          b.scope,
          b.intent,
          b.content,
          JSON.stringify(b.accessedResources ?? []),
          b.timestamp ?? Date.now(),
          JSON.stringify(b.provenance ?? {}),
          b.tokenCost ?? 0,
        );
      if (!existing) result.inserted++;
    }

    return result;
  }

  close(): void {
    this.db.close();
  }
}

function rowToBlock(r: Record<string, unknown>): MemoryBlock {
  return {
    id: r.id as string,
    agentRole: r.agent_role as string,
    scope: r.scope as 'private' | 'shared',
    intent: r.intent as string,
    content: r.content as string,
    accessedResources: JSON.parse((r.accessed_resources as string) ?? '[]'),
    timestamp: r.timestamp as number,
    provenance: JSON.parse((r.provenance as string) ?? '{}'),
    tokenCost: r.token_cost as number,
  };
}
