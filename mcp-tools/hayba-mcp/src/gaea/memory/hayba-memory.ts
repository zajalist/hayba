import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';

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

export class HaybaMemory {
  private db: Database.Database;

  constructor(path: string) {
    this.db = new Database(path);
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

  query(opts: {
    scope?: 'private' | 'shared';
    agentRole?: string;
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
    const sql = `SELECT * FROM memory_blocks ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
                 ORDER BY timestamp DESC LIMIT ?`;
    args.push(opts.limit ?? 50);
    const rows = this.db.prepare(sql).all(...args) as Array<Record<string, unknown>>;
    return rows.map(r => ({
      id: r.id as string,
      agentRole: r.agent_role as string,
      scope: r.scope as 'private' | 'shared',
      intent: r.intent as string,
      content: r.content as string,
      accessedResources: JSON.parse((r.accessed_resources as string) ?? '[]'),
      timestamp: r.timestamp as number,
      provenance: JSON.parse((r.provenance as string) ?? '{}'),
      tokenCost: r.token_cost as number,
    }));
  }

  clear(agentRole?: string): void {
    if (agentRole) {
      this.db.prepare('DELETE FROM memory_blocks WHERE agent_role = ?').run(agentRole);
    } else {
      this.db.prepare('DELETE FROM memory_blocks').run();
    }
  }

  close(): void {
    this.db.close();
  }
}
