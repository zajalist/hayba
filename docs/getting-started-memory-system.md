# Getting started — Memory system

Sibling of [`docs/getting-started.md`](getting-started.md). Covers the
SQLite-backed shared-memory layer referenced by `hayba.agents.json`'s
`shared_memory` field and by two of the shipped skills
(`hayba-refine-scene` reads "shared memory... by intent"; `hayba-new-scene`
says "Record every spatial decision to memory with a clear `intent`
string").

**Status up front:** this is a working MCP feature. Eight `memory_*` tools
share a lazy process-wide SQLite store, enforce retention after writes, and
support portable JSON export/import.

## Where it lives

[`mcp-tools/hayba-mcp/src/gaea/memory/hayba-memory.ts`](../mcp-tools/hayba-mcp/src/gaea/memory/hayba-memory.ts),
class `HaybaMemory`, backed by Node's built-in `node:sqlite` API. The wiring
lives in
[`src/tools/memory/store.ts`](../mcp-tools/hayba-mcp/src/tools/memory/store.ts),
which lazily opens one shared connection. The active memory-tool suite is in
`src/tools/memory/memory-tools.test.ts`.

## Schema

One table, created with `CREATE TABLE IF NOT EXISTS` on construction:

```sql
CREATE TABLE IF NOT EXISTS memory_blocks (
  id                 TEXT PRIMARY KEY,
  agent_role         TEXT NOT NULL,
  scope              TEXT NOT NULL,
  intent             TEXT NOT NULL,
  content            TEXT NOT NULL,
  accessed_resources TEXT,           -- JSON-encoded string[]
  timestamp          INTEGER NOT NULL,
  provenance         TEXT,           -- JSON-encoded object
  token_cost         INTEGER
);
CREATE INDEX IF NOT EXISTS idx_scope_role ON memory_blocks(scope, agent_role);
CREATE INDEX IF NOT EXISTS idx_timestamp  ON memory_blocks(timestamp);
```

`scope` is a free-text column but the TypeScript-side type only ever writes
`'private' | 'shared'`. `accessed_resources` and `provenance` are stored as
JSON strings, not native SQLite JSON — they round-trip through
`JSON.stringify`/`JSON.parse` in the TS layer.

## API

```ts
class HaybaMemory {
  constructor(path: string); // opens/creates a better-sqlite3 db at `path`
  write(b: MemoryBlock): string; // returns the row id (uuid if not supplied)
  query(opts: {
    scope?: 'private' | 'shared';
    agentRole?: string;
    limit?: number; // default 50
  }): MemoryBlock[]; // ORDER BY timestamp DESC
  clear(agentRole?: string): void; // delete all rows, or all rows for one role
  close(): void;
}
```

`MemoryBlock`:

```ts
interface MemoryBlock {
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
```

## MCP tools

- `memory_write` stores one block and then applies retention.
- `memory_recall` searches by keyword; `memory_list` paginates without search.
- `memory_delete` deletes by id or role and requires `confirm_all=true` to clear all.
- `memory_prune` applies explicit age/count bounds on demand.
- `memory_export` writes a portable versioned JSON envelope.
- `memory_import` restores or merges an export with explicit conflict policy.

## Retention policy

Every `memory_write` prunes to the configured limits. Defaults are 2,000 rows
and 90 days. Override them with `HAYBA_MEMORY_MAX_COUNT` and
`HAYBA_MEMORY_MAX_AGE_DAYS`; use `memory_prune` for a tighter one-off cleanup.

## Export / import

Use `memory_export` and `memory_import`; both report row-level outcomes rather
than treating a partial operation as success. Export writes JSON rather than a
live SQLite-file copy, so it is safe to use while the process owns the database.

## Where the filename convention comes from

`hayba.agents.json`'s `shared_memory` field (default `"hayba-memory.db"`,
"relative to project root" per the doc comment on `AgentsManifest` in
`src/agents/types.ts`) is presumably meant to be the path passed to
`new HaybaMemory(path)`. The runtime store currently uses `HAYBA_MEMORY_DB`
instead; otherwise it defaults to `data/hayba-memory.db` beside the built MCP
server. The manifest field is validated metadata and does not redirect the
store.

## A naming collision worth knowing about

`unreal/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/HaybaMCPMemoryPanel.h`
/ `.cpp` defines `SHaybaMCPMemoryPanel` — despite the name, this is the
**PLUMB Semantic Library** panel, a tree view over profiled scene assets
(masks, constraints, locks). It has nothing to do with `HaybaMemory` or
agent memory. If you're looking for a UE-side view of agent memory blocks,
this isn't it, and no such panel currently exists.
