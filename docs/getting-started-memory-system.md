# Getting started — Memory system

Sibling of [`docs/getting-started.md`](getting-started.md). Covers the
SQLite-backed shared-memory layer referenced by `hayba.agents.json`'s
`shared_memory` field and by two of the shipped skills
(`hayba-refine-scene` reads "shared memory... by intent"; `hayba-new-scene`
says "Record every spatial decision to memory with a clear `intent`
string").

**Status up front:** the class and its schema exist, are implemented, and
have a unit test — but nothing in the current codebase instantiates or calls
this class outside its own test file. There is no MCP tool that writes to
or reads from it, and no retention policy or export/import support exists
at all. Treat this page as a description of the schema for someone who wants
to wire it up, not as a working feature.

## Where it lives

[`mcp-tools/hayba-mcp/src/gaea/memory/hayba-memory.ts`](../mcp-tools/hayba-mcp/src/gaea/memory/hayba-memory.ts),
class `HaybaMemory`, backed by `better-sqlite3`. It lives under `src/gaea/`
— the Gaea tool surface, which is currently parked (its tool-registration
block was deleted from `src/tools/index.ts`; see the comment block in
`mcp-tools/hayba-mcp/vitest.config.ts`). Its test,
`mcp-tools/hayba-mcp/tests/gaea/memory/hayba-memory.test.ts`, exists but is
excluded from the active suite by the same `vitest.config.ts` exclude entry
(`'**/tests/gaea/**'`), so it does not currently run as part of `npm test`.

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
  constructor(path: string)             // opens/creates a better-sqlite3 db at `path`
  write(b: MemoryBlock): string         // returns the row id (uuid if not supplied)
  query(opts: {
    scope?: 'private' | 'shared';
    agentRole?: string;
    limit?: number;                     // default 50
  }): MemoryBlock[]                     // ORDER BY timestamp DESC
  clear(agentRole?: string): void       // delete all rows, or all rows for one role
  close(): void
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

## Retention policy

**Not implemented.** There is no TTL, no row-count cap, no scheduled
pruning, and no code path that ever calls `clear()` automatically — `clear`
is available to a caller but nothing in this repo calls it. Rows accumulate
indefinitely for as long as something is calling `write()`.

## Export / import

**Not implemented.** `HaybaMemory` has no export or dump method and no
import/load method. There is no CLI script or MCP tool in this repo for
copying a memory database in or out. Because it's a plain SQLite file, the
generic route (`sqlite3 <path> .dump`, or copying the `.db` file while no
process holds it open) works at the filesystem level, but that is not
something the codebase provides or documents — it follows from "it's a
SQLite file," not from a shipped feature.

## Where the filename convention comes from

`hayba.agents.json`'s `shared_memory` field (default `"hayba-memory.db"`,
"relative to project root" per the doc comment on `AgentsManifest` in
`src/agents/types.ts`) is presumably meant to be the path passed to
`new HaybaMemory(path)`. No code in this repo reads that field or
constructs a `HaybaMemory` from it — see
[Getting started — Swarm agents](getting-started-swarm-agents.md) for the
matching gap on the archetype-loader side.

## A naming collision worth knowing about

`unreal/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private/HaybaMCPMemoryPanel.h`
/ `.cpp` defines `SHaybaMCPMemoryPanel` — despite the name, this is the
**PLUMB Semantic Library** panel, a tree view over profiled scene assets
(masks, constraints, locks). It has nothing to do with `HaybaMemory` or
agent memory. If you're looking for a UE-side view of agent memory blocks,
this isn't it, and no such panel currently exists.
