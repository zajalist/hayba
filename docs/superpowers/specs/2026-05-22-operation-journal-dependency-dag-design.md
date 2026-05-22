# Operation Journal + Dependency DAG

**Date:** 2026-05-22
**Status:** Approved (brainstorm)
**Touches:** `mcp-tools/hayba-mcp`
**Roadmap:** Priority 2 of the Gemini determinism roadmap (`.scratch/determinism-handoff.md`), and post-mortem issue #12 (operation journal) — folded into one spec because both record the same "what got mutated" data.

## Problem

Hayba has no record of what generative operations touched what. Consequences:

1. **No "modify don't regenerate."** Changing one input (e.g. `volcanism`) cannot re-run only the affected downstream work — there is no dependency graph to walk.
2. **No cross-session dirty tracking.** Quit after a change and the next session has no idea anything is stale.
3. **No trace corpus.** The Layer 3b LoRA regressor (Priority 6) and context compaction (Priority 5) both need a log of successful generation operations; nothing produces one.

## Goal

Ship two coupled pieces in the MCP server:

- An **operation journal** — an append-only, per-project log of every mutation, durable across restarts.
- A **dependency DAG** — an in-memory graph projected from the journal, exposing what depends on what and what is currently dirty, plus an explicit rebuild path.

One persisted source of truth (the journal); the DAG is a derived view.

## Locked decisions (from brainstorm)

| # | Decision | Choice |
|---|---|---|
| 1 | DAG nodes | Persistent project artifacts (assets, snapshots, sliver outputs) |
| 2 | Node identity | URI scheme with namespaces |
| 3 | Registration scope | Slivers + asset-source tools auto-register + a `hayba_dag_record` fence tool |
| 4 | Persistence | DAG is an in-memory projection of a persisted journal |
| 5 | Edge discovery | Param-URI inference (floor) + declared reads/fence (augment), provenance-tagged |
| 6 | Dirty model | Mark-only + an explicit `hayba_dag_rebuild` tool |

## Architecture

```
 mutation (sliver run / asset tool / hayba_dag_record)
        │  append
        ▼
 ┌──────────────────┐   replay on startup   ┌────────────────────┐
 │ Operation journal │ ────────────────────▶ │  Dependency DAG     │
 │ journal.jsonl     │                       │  (in-memory)        │
 │ (per project)     │ ◀──────────────────── │  nodes + edges +    │
 └──────────────────┘   append on mutation   │  dirty set          │
        │                                    └────────────────────┘
        │ tail                                        │ query / rebuild
        ▼                                              ▼
  hayba_journal_tail                    hayba_dag_status / hayba_dag_rebuild
```

Both live in the MCP server (Node/TS), constructed alongside `SliverSystem`.

### Node identity (URI scheme)

Every artifact is one URI. Namespaces in v1:

| Namespace | Example | Meaning |
|---|---|---|
| `ue://` | `ue://Game/Cameras/CamA` | A UE asset / actor path |
| `planet://` | `planet://snapshot/seed_4242` | A planet-sim snapshot |
| `file://` | `file:///C:/tmp/heightmap.png` | An on-disk file |
| `sliver://` | `sliver://run/<runId>` | One sliver run's output bundle |

A URI not yet seen is created lazily as a **phantom node** (so a declared read of a not-yet-produced artifact still records an edge).

### Operation journal

Append-only JSONL at `~/.hayba/<project>/journal.jsonl`. `<project>` is a slug derived from the working directory. One line per mutation:

```json
{
  "ts": "2026-05-22T14:03:12.441Z",
  "seq": 128,
  "actor": "sliver:com.hayba.composition.frame_target",
  "reads":  ["ue://Game/Maps/Demo.StaticMeshActor_0"],
  "writes": ["sliver://run/abc123"],
  "paramsHash": "sha256:9f86d0…",
  "ok": true,
  "note": null
}
```

- `seq` is a monotonic integer, assigned by the journal, gap-free per project.
- `paramsHash` is a stable SHA-256 of the canonicalised params object — lets a future content-hash invalidation (v2) tell "ran again with the same inputs" from "genuinely changed".
- The journal never rewrites or truncates in v1. A `seq`-keyed log is enough; compaction is v2.

### Dependency DAG

Rebuilt at startup by replaying the journal in `seq` order. Pure in-memory; never serialised.

- **Node**: `{ uri, namespace, dirty: boolean, lastWriteSeq: number | null }`
- **Edge**: `{ from: readUri, to: writeUri, provenance: 'inferred' | 'declared', viaSeq: number }`
- Replay: for each record, ensure all `reads`/`writes` nodes exist, add `read → write` edges, set each write node's `lastWriteSeq`, then run dirty propagation (below).

## Registration (decision D)

Three producers append to the journal:

1. **Sliver runs** — the `SliverRuntime`, on every `runSliver`, appends one record. `writes` = the run's aggregated `side_effects[]`; `reads` = the new spec `reads[]` plus param-inferred URIs (below). Always recorded, ok or fail.
2. **Asset-source tools** — the existing verified-side-effect contract (`src/tools/asset-sources/shared.ts`) gains a post-verify hook that appends a record with the verified write target.
3. **`hayba_dag_record`** — the fence tool. The LLM calls it to declare a mutation Hayba did not instrument (editor-side actor edits, manual file writes).

A journal-append failure is logged to stderr and **never blocks the mutation** — the journal is observability, not a gate.

## Edge discovery (decision C)

Two sources, both feed the same edge set:

- **Inferred** — when a record is appended, every param value (for sliver runs) that is a string matching a known node URI, or matching the URI grammar, is added to `reads` with `provenance: 'inferred'` if not already declared.
- **Declared** — sliver spec `reads[]` and `hayba_dag_record` `reads[]` are `provenance: 'declared'`.

Provenance is kept so `hayba_dag_status` can surface slivers whose declared reads are a strict subset of their inferred reads (a hint the author under-declared, or the inference over-reached).

### Sliver spec change

`determinism` gains an optional `reads[]` of URI-pattern strings:

```json
"determinism": {
  "pure": true,
  "declared_outputs": ["camera_transform"],
  "side_effects": [],
  "reads": ["ue://*"],
  "seed_param": null
}
```

`reads[]` defaults to `[]`. The Zod schema (`spec-schema.ts`) and the C++ mirror (`HaybaSliverTypes`) both add the field; absence is valid (older specs keep working).

## Dirty model (decision C)

- When a record writes node X, **every node reachable from X by following edges in the write direction** is marked `dirty`. X itself is *not* dirty (it was just produced); its dependents are.
- Dirty is a pure marking. Nothing recomputes.
- `hayba_dag_rebuild` is the only thing that clears dirty: it re-runs the executor behind each dirty node, oldest-first in topological order, and clears the flag on success.
- **Cycle guard**: edges are inserted only if they do not create a cycle; a rejected edge is reported in `hayba_dag_status.warnings`. Dirty propagation is over a DAG, so it terminates.

## MCP tools

Four new tools, registered always-on (same as the four sliver tools — added to `ALWAYS_ON_META`).

### `hayba_dag_status`

Input: `{ namespace?: string, dirtyOnly?: boolean }`
Output:

```json
{
  "nodeCount": 42,
  "dirtyCount": 3,
  "nodes": [{ "uri": "...", "namespace": "ue", "dirty": true, "lastWriteSeq": 128 }],
  "edges": [{ "from": "...", "to": "...", "provenance": "inferred", "viaSeq": 128 }],
  "warnings": ["edge ue://A → ue://B rejected: would create a cycle"]
}
```

### `hayba_dag_record`

Input: `{ reads?: string[], writes: string[], actor?: string, note?: string }`
Appends one journal record (`actor` defaults to `"manual"`), updates the DAG. Output: `{ ok, seq }`.

### `hayba_dag_rebuild`

Input: `{ target?: string }` — a node URI; omitted = the whole dirty set.
Re-runs the dirty subgraph rooted at (and including everything downstream of) `target`, topologically ordered. v1 only re-runs `sliver://` nodes (it has the `SliverRuntime`); a dirty node with no known executor is **skipped and reported**, not failed.
Output: `{ ok, rebuilt: string[], skipped: [{ uri, reason }], stillDirty: string[] }`.

### `hayba_journal_tail`

Input: `{ limit?: number }` (default 50)
Output: `{ entries: JournalRecord[] }` — the last N records, newest last. Read-only window for debugging and for the future LoRA trace corpus.

## File structure

```
mcp-tools/hayba-mcp/src/
├── dag/
│   ├── journal.ts            # append-only JSONL journal: append, tail, replay
│   ├── journal.test.ts
│   ├── dag.ts                # in-memory graph: nodes, edges, dirty propagation, topo order
│   ├── dag.test.ts
│   ├── uri.ts                # URI parse/validate/namespace; phantom-node helpers
│   ├── uri.test.ts
│   ├── edge-inference.ts     # param-value → inferred-read extraction
│   ├── edge-inference.test.ts
│   ├── rebuild.ts            # hayba_dag_rebuild driver (topo walk + SliverRuntime calls)
│   ├── rebuild.test.ts
│   ├── index.ts              # setupDagSystem facade: journal + dag wired, replay on init
│   └── index.test.ts
├── tools/dag/
│   ├── status.ts             # hayba_dag_status
│   ├── record.ts             # hayba_dag_record
│   ├── rebuild.ts            # hayba_dag_rebuild
│   └── journal-tail.ts       # hayba_journal_tail
├── slivers/
│   ├── spec-schema.ts        # MODIFIED: determinism.reads[] (optional)
│   ├── types.ts              # MODIFIED: SliverDeterminism.reads
│   └── runtime.ts            # MODIFIED: append a journal record per runSliver
├── tools/asset-sources/
│   └── shared.ts             # MODIFIED: post-verify hook → journal append
└── tools/routing/
    └── register.ts           # MODIFIED: 4 dag tools into ALWAYS_ON_META + routing
```

`setupDagSystem` mirrors `setupSliverSystem` — constructed once, handed the same project dir, replay-on-init. The routing handle carries both `slivers` and `dag`.

## Error handling

- **Journal append fails** (disk full, permissions) → log to stderr, mutation proceeds. Never a gate.
- **Journal line corrupt on replay** → skip that line, record a warning, continue replay. A truncated last line (crash mid-append) is tolerated.
- **`hayba_dag_rebuild` hits a node with no known executor** → skip, add to `skipped[]` with a reason; the rest of the rebuild continues.
- **Edge would create a cycle** → edge rejected, surfaced in `warnings`.
- **Read of an unknown URI** → lazy phantom node created; no error.
- **`hayba_dag_record` with malformed URIs** → `{ ok: false, error }`, nothing appended.

## Testing

- `journal.test.ts` — append assigns gap-free `seq`; tail returns newest-last; replay reconstructs in order; corrupt/truncated line tolerated.
- `uri.test.ts` — namespace parsing, validation, rejection of malformed URIs.
- `dag.test.ts` — node/edge insert; dirty propagation marks the whole downstream set and nothing upstream; cycle rejection; topo order.
- `edge-inference.test.ts` — param URIs become inferred reads; non-URI params ignored; declared reads not double-counted.
- `rebuild.test.ts` — dirty subgraph re-runs topologically; unknown-executor node skipped not failed; `stillDirty` reports leftovers.
- `index.test.ts` — `setupDagSystem` replays an existing journal into a correct DAG.
- HTTP/MCP tool tests — each of the 4 tools over its handler, mirroring the sliver tool tests.

## Scope cuts (v1 → v2)

| Item | v1 | v2 |
|---|---|---|
| DAG visualization | `hayba_dag_status` JSON only | UE panel / cogmap-style graph view |
| `hayba_dag_rebuild` targets | `sliver://` nodes only | arbitrary tool-produced nodes |
| Invalidation precision | dirty = any write downstream | content-hash aware ("same inputs → not dirty") |
| Journal size | unbounded append | compaction / rotation |
| Cross-project | one journal per project | — |
| Edge inference | exact URI string match | fuzzy / partial-path resolution |

## Non-goals

- Not a build system — no scheduling, no parallel rebuild, no caching of intermediate results beyond the dirty flag.
- Not a UE-side feature — the DAG lives in the MCP server; UE only ever calls the tools.
- Does not change how slivers execute — only adds a journal-append per run and one optional spec field.
- Does not gate mutations — a tool is never blocked because the journal or DAG rejected something.
