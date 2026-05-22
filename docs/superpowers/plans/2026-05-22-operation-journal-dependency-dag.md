# Operation Journal + Dependency DAG Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship an append-only operation journal and an in-memory dependency DAG in the MCP server, exposed via four always-on MCP tools, so Hayba can track what mutated what and re-run only dirty work.

**Architecture:** A per-project JSONL journal is the durable record of every mutation. The DAG is an in-memory graph rebuilt by replaying the journal at startup. Sliver runs and asset-source tools auto-append; a `hayba_dag_record` fence tool covers un-instrumented mutations. Dirty state is mark-only; `hayba_dag_rebuild` re-runs the dirty subgraph on demand.

**Tech Stack:** TypeScript, vitest, Node `crypto` + `fs`. Mirrors the existing `src/slivers/` module + `src/tools/sliver/` tool pattern.

**Spec:** `docs/superpowers/specs/2026-05-22-operation-journal-dependency-dag-design.md`

---

### Task 1: `dag/uri.ts` — URI parsing & validation (TDD)

**Files:**
- Create: `mcp-tools/hayba-mcp/src/dag/uri.ts`
- Create: `mcp-tools/hayba-mcp/src/dag/uri.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// mcp-tools/hayba-mcp/src/dag/uri.test.ts
import { describe, it, expect } from 'vitest';
import { parseUri, isUri, DAG_NAMESPACES } from './uri.js';

describe('uri', () => {
  it('parses each known namespace', () => {
    expect(parseUri('ue://Game/Cameras/CamA')).toEqual({ ok: true, namespace: 'ue', rest: 'Game/Cameras/CamA' });
    expect(parseUri('planet://snapshot/seed_4242')).toEqual({ ok: true, namespace: 'planet', rest: 'snapshot/seed_4242' });
    expect(parseUri('file:///C:/tmp/h.png')).toEqual({ ok: true, namespace: 'file', rest: '/C:/tmp/h.png' });
    expect(parseUri('sliver://run/abc123')).toEqual({ ok: true, namespace: 'sliver', rest: 'run/abc123' });
  });

  it('rejects unknown namespaces and malformed strings', () => {
    expect(parseUri('http://example.com').ok).toBe(false);
    expect(parseUri('not-a-uri').ok).toBe(false);
    expect(parseUri('ue://').ok).toBe(false);          // empty rest
    expect(parseUri('').ok).toBe(false);
  });

  it('isUri is a boolean shortcut for parseUri().ok', () => {
    expect(isUri('ue://Game/X')).toBe(true);
    expect(isUri('plain string')).toBe(false);
  });

  it('exposes the known namespace list', () => {
    expect([...DAG_NAMESPACES].sort()).toEqual(['file', 'planet', 'sliver', 'ue']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd D:/Hackathons/hayba/mcp-tools/hayba-mcp && npx vitest run src/dag/uri.test.ts`
Expected: FAIL (`Cannot find module './uri.js'`).

- [ ] **Step 3: Implement `uri.ts`**

```ts
// mcp-tools/hayba-mcp/src/dag/uri.ts
//
// Artifact URIs identify every node in the dependency DAG. Format is
// "<namespace>://<rest>" with a fixed namespace set. The `rest` must be
// non-empty.

export const DAG_NAMESPACES = new Set(['ue', 'planet', 'file', 'sliver'] as const);

export type ParseUriResult =
  | { ok: true; namespace: string; rest: string }
  | { ok: false };

export function parseUri(s: string): ParseUriResult {
  const idx = s.indexOf('://');
  if (idx <= 0) return { ok: false };
  const namespace = s.slice(0, idx);
  const rest = s.slice(idx + 3);
  if (!DAG_NAMESPACES.has(namespace as never)) return { ok: false };
  if (rest.length === 0) return { ok: false };
  return { ok: true, namespace, rest };
}

export function isUri(s: string): boolean {
  return parseUri(s).ok;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd D:/Hackathons/hayba/mcp-tools/hayba-mcp && npx vitest run src/dag/uri.test.ts`
Expected: 4 passing.

- [ ] **Step 5: Commit**

```bash
git -C D:/Hackathons/hayba add mcp-tools/hayba-mcp/src/dag/uri.ts mcp-tools/hayba-mcp/src/dag/uri.test.ts
git -C D:/Hackathons/hayba commit -m "feat(dag): artifact URI parsing + namespace validation"
```

---

### Task 2: `dag/journal.ts` — append-only JSONL journal (TDD)

**Files:**
- Create: `mcp-tools/hayba-mcp/src/dag/journal.ts`
- Create: `mcp-tools/hayba-mcp/src/dag/journal.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
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
    new OperationJournal(path).append(sample);          // seq 1
    const j2 = new OperationJournal(path);              // re-open
    expect(j2.append(sample).seq).toBe(2);
  });

  it('tail returns the last N records, newest last', () => {
    const j = new OperationJournal(path);
    for (let i = 0; i < 5; i++) j.append({ ...sample, actor: `a${i}` });
    const t = j.tail(2);
    expect(t.map(r => r.actor)).toEqual(['a3', 'a4']);
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
    expect(j2.all()).toHaveLength(1);              // bad line skipped
    expect(j2.append(sample).seq).toBe(2);
  });

  it('note defaults to null when omitted', () => {
    const j = new OperationJournal(path);
    expect(j.append(sample).note).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd D:/Hackathons/hayba/mcp-tools/hayba-mcp && npx vitest run src/dag/journal.test.ts`
Expected: FAIL (`Cannot find module './journal.js'`).

- [ ] **Step 3: Implement `journal.ts`**

```ts
// mcp-tools/hayba-mcp/src/dag/journal.ts
//
// Append-only JSONL journal of every mutation. One record per line.
// Durable: append() writes through to disk immediately. On construction
// the file is replayed to recover the last seq and the in-memory list;
// a corrupt or truncated line is skipped, not fatal.

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

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
    const rec: JournalRecord = {
      ts: new Date().toISOString(),
      seq: ++this.lastSeq,
      actor: input.actor,
      reads: input.reads,
      writes: input.writes,
      paramsHash: input.paramsHash,
      ok: input.ok,
      note: input.note ?? null,
    };
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
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const rec = JSON.parse(trimmed) as JournalRecord;
        if (typeof rec.seq !== 'number') continue;
        this.records.push(rec);
        this.lastSeq = Math.max(this.lastSeq, rec.seq);
      } catch {
        // Corrupt / truncated line — skip, keep replaying.
      }
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd D:/Hackathons/hayba/mcp-tools/hayba-mcp && npx vitest run src/dag/journal.test.ts`
Expected: 7 passing.

- [ ] **Step 5: Commit**

```bash
git -C D:/Hackathons/hayba add mcp-tools/hayba-mcp/src/dag/journal.ts mcp-tools/hayba-mcp/src/dag/journal.test.ts
git -C D:/Hackathons/hayba commit -m "feat(dag): append-only JSONL operation journal"
```

---

### Task 3: `dag/dag.ts` — in-memory graph + dirty propagation (TDD)

**Files:**
- Create: `mcp-tools/hayba-mcp/src/dag/dag.ts`
- Create: `mcp-tools/hayba-mcp/src/dag/dag.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// mcp-tools/hayba-mcp/src/dag/dag.test.ts
import { describe, it, expect } from 'vitest';
import { DependencyDag } from './dag.js';
import type { JournalRecord } from './journal.js';

function rec(seq: number, reads: string[], writes: string[]): JournalRecord {
  return { ts: '', seq, actor: 'test', reads, writes, paramsHash: '', ok: true, note: null };
}

describe('DependencyDag', () => {
  it('creates nodes for every read and write uri', () => {
    const d = new DependencyDag();
    d.applyRecord(rec(1, ['ue://A'], ['sliver://B']));
    expect(d.nodes().map(n => n.uri).sort()).toEqual(['sliver://B', 'ue://A']);
  });

  it('adds a read→write edge with declared provenance by default', () => {
    const d = new DependencyDag();
    d.applyRecord(rec(1, ['ue://A'], ['sliver://B']));
    const e = d.edges();
    expect(e).toHaveLength(1);
    expect(e[0]).toMatchObject({ from: 'ue://A', to: 'sliver://B', provenance: 'declared', viaSeq: 1 });
  });

  it('marks everything downstream of a written node dirty, but not the node itself', () => {
    const d = new DependencyDag();
    d.applyRecord(rec(1, ['ue://A'], ['sliver://B']));   // A → B
    d.applyRecord(rec(2, ['sliver://B'], ['sliver://C'])); // B → C
    d.applyRecord(rec(3, [], ['ue://A']));                // write A again
    const dirty = d.dirtySet().sort();
    expect(dirty).toEqual(['sliver://B', 'sliver://C']);  // downstream of A
    expect(d.dirtySet()).not.toContain('ue://A');
  });

  it('rejects an edge that would create a cycle and records a warning', () => {
    const d = new DependencyDag();
    d.applyRecord(rec(1, ['ue://A'], ['ue://B']));   // A → B
    d.applyRecord(rec(2, ['ue://B'], ['ue://A']));   // B → A would cycle
    expect(d.edges()).toHaveLength(1);
    expect(d.warnings().some(w => /cycle/i.test(w))).toBe(true);
  });

  it('topoOrder returns nodes with dependencies before dependents', () => {
    const d = new DependencyDag();
    d.applyRecord(rec(1, ['ue://A'], ['sliver://B']));
    d.applyRecord(rec(2, ['sliver://B'], ['sliver://C']));
    const order = d.topoOrder();
    expect(order.indexOf('ue://A')).toBeLessThan(order.indexOf('sliver://B'));
    expect(order.indexOf('sliver://B')).toBeLessThan(order.indexOf('sliver://C'));
  });

  it('clearDirty unsets the flag on one node', () => {
    const d = new DependencyDag();
    d.applyRecord(rec(1, ['ue://A'], ['sliver://B']));
    d.applyRecord(rec(2, [], ['ue://A']));
    expect(d.dirtySet()).toContain('sliver://B');
    d.clearDirty('sliver://B');
    expect(d.dirtySet()).not.toContain('sliver://B');
  });

  it('addInferredEdge tags provenance as inferred', () => {
    const d = new DependencyDag();
    d.applyRecord(rec(1, [], ['sliver://B']));
    d.addInferredEdge('ue://A', 'sliver://B', 1);
    expect(d.edges().find(e => e.from === 'ue://A')?.provenance).toBe('inferred');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd D:/Hackathons/hayba/mcp-tools/hayba-mcp && npx vitest run src/dag/dag.test.ts`
Expected: FAIL (`Cannot find module './dag.js'`).

- [ ] **Step 3: Implement `dag.ts`**

```ts
// mcp-tools/hayba-mcp/src/dag/dag.ts
//
// In-memory dependency graph. Nodes are artifact URIs; edges are
// read→write dependencies. Built by replaying journal records via
// applyRecord(). A write marks every downstream node dirty. Edges that
// would create a cycle are rejected (recorded in warnings()).

import { parseUri } from './uri.js';
import type { JournalRecord } from './journal.js';

export interface DagNode {
  uri: string;
  namespace: string;
  dirty: boolean;
  lastWriteSeq: number | null;
}

export interface DagEdge {
  from: string;
  to: string;
  provenance: 'inferred' | 'declared';
  viaSeq: number;
}

export class DependencyDag {
  private nodeMap = new Map<string, DagNode>();
  private edgeList: DagEdge[] = [];
  private warningList: string[] = [];

  applyRecord(rec: JournalRecord): void {
    for (const uri of [...rec.reads, ...rec.writes]) this.ensureNode(uri);
    for (const w of rec.writes) {
      for (const r of rec.reads) this.addEdge(r, w, 'declared', rec.seq);
    }
    for (const w of rec.writes) {
      const node = this.nodeMap.get(w);
      if (node) node.lastWriteSeq = rec.seq;
      this.propagateDirty(w);
    }
  }

  /** Add an edge whose provenance is inference (param-URI match). */
  addInferredEdge(from: string, to: string, viaSeq: number): void {
    this.ensureNode(from);
    this.ensureNode(to);
    this.addEdge(from, to, 'inferred', viaSeq);
    this.propagateDirty(to);
  }

  nodes(): DagNode[] { return [...this.nodeMap.values()]; }
  edges(): DagEdge[] { return [...this.edgeList]; }
  warnings(): string[] { return [...this.warningList]; }
  dirtySet(): string[] { return this.nodes().filter(n => n.dirty).map(n => n.uri); }

  clearDirty(uri: string): void {
    const n = this.nodeMap.get(uri);
    if (n) n.dirty = false;
  }

  /** Dependencies before dependents (Kahn's algorithm). */
  topoOrder(): string[] {
    const indeg = new Map<string, number>();
    for (const n of this.nodeMap.keys()) indeg.set(n, 0);
    for (const e of this.edgeList) indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1);
    const queue = [...indeg.entries()].filter(([, d]) => d === 0).map(([u]) => u);
    const out: string[] = [];
    while (queue.length) {
      const u = queue.shift()!;
      out.push(u);
      for (const e of this.edgeList) {
        if (e.from !== u) continue;
        const d = (indeg.get(e.to) ?? 0) - 1;
        indeg.set(e.to, d);
        if (d === 0) queue.push(e.to);
      }
    }
    return out;
  }

  private ensureNode(uri: string): void {
    if (this.nodeMap.has(uri)) return;
    const parsed = parseUri(uri);
    this.nodeMap.set(uri, {
      uri,
      namespace: parsed.ok ? parsed.namespace : 'unknown',
      dirty: false,
      lastWriteSeq: null,
    });
  }

  private addEdge(from: string, to: string, provenance: 'inferred' | 'declared', viaSeq: number): void {
    if (from === to) return;
    if (this.edgeList.some(e => e.from === from && e.to === to)) return;  // dedup
    if (this.wouldCycle(from, to)) {
      this.warningList.push(`edge ${from} → ${to} rejected: would create a cycle`);
      return;
    }
    this.edgeList.push({ from, to, provenance, viaSeq });
  }

  /** True if adding from→to makes `from` reachable from `to`. */
  private wouldCycle(from: string, to: string): boolean {
    const seen = new Set<string>();
    const stack = [to];
    while (stack.length) {
      const u = stack.pop()!;
      if (u === from) return true;
      if (seen.has(u)) continue;
      seen.add(u);
      for (const e of this.edgeList) if (e.from === u) stack.push(e.to);
    }
    return false;
  }

  private propagateDirty(rootWrite: string): void {
    // Everything reachable downstream of rootWrite becomes dirty.
    const seen = new Set<string>();
    const stack: string[] = [];
    for (const e of this.edgeList) if (e.from === rootWrite) stack.push(e.to);
    while (stack.length) {
      const u = stack.pop()!;
      if (seen.has(u)) continue;
      seen.add(u);
      const n = this.nodeMap.get(u);
      if (n) n.dirty = true;
      for (const e of this.edgeList) if (e.from === u) stack.push(e.to);
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd D:/Hackathons/hayba/mcp-tools/hayba-mcp && npx vitest run src/dag/dag.test.ts`
Expected: 7 passing.

- [ ] **Step 5: Commit**

```bash
git -C D:/Hackathons/hayba add mcp-tools/hayba-mcp/src/dag/dag.ts mcp-tools/hayba-mcp/src/dag/dag.test.ts
git -C D:/Hackathons/hayba commit -m "feat(dag): in-memory dependency graph with dirty propagation"
```

---

### Task 4: `dag/edge-inference.ts` — param → inferred reads (TDD)

**Files:**
- Create: `mcp-tools/hayba-mcp/src/dag/edge-inference.ts`
- Create: `mcp-tools/hayba-mcp/src/dag/edge-inference.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// mcp-tools/hayba-mcp/src/dag/edge-inference.test.ts
import { describe, it, expect } from 'vitest';
import { inferReadsFromParams } from './edge-inference.js';

describe('inferReadsFromParams', () => {
  it('returns param values that are valid uris', () => {
    const reads = inferReadsFromParams({
      target: 'ue://Game/Maps/Demo.Actor_0',
      distance: 12,
      label: 'just a string',
    });
    expect(reads).toEqual(['ue://Game/Maps/Demo.Actor_0']);
  });

  it('ignores non-string and non-uri values', () => {
    expect(inferReadsFromParams({ a: 42, b: true, c: 'plain', d: null })).toEqual([]);
  });

  it('de-duplicates repeated uris and excludes already-declared reads', () => {
    const reads = inferReadsFromParams(
      { a: 'ue://X', b: 'ue://X', c: 'planet://snapshot/s' },
      ['planet://snapshot/s'],   // already declared
    );
    expect(reads).toEqual(['ue://X']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd D:/Hackathons/hayba/mcp-tools/hayba-mcp && npx vitest run src/dag/edge-inference.test.ts`
Expected: FAIL (`Cannot find module './edge-inference.js'`).

- [ ] **Step 3: Implement `edge-inference.ts`**

```ts
// mcp-tools/hayba-mcp/src/dag/edge-inference.ts
//
// Param-URI inference: any param value that is a valid artifact URI is
// treated as a read dependency. This draws DAG edges "for free" without
// the sliver author declaring every input. Already-declared reads are
// excluded so the caller can tag the remainder as `inferred`.

import { isUri } from './uri.js';

export function inferReadsFromParams(
  params: Record<string, unknown>,
  declared: string[] = [],
): string[] {
  const declaredSet = new Set(declared);
  const found = new Set<string>();
  for (const value of Object.values(params)) {
    if (typeof value === 'string' && isUri(value) && !declaredSet.has(value)) {
      found.add(value);
    }
  }
  return [...found];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd D:/Hackathons/hayba/mcp-tools/hayba-mcp && npx vitest run src/dag/edge-inference.test.ts`
Expected: 3 passing.

- [ ] **Step 5: Commit**

```bash
git -C D:/Hackathons/hayba add mcp-tools/hayba-mcp/src/dag/edge-inference.ts mcp-tools/hayba-mcp/src/dag/edge-inference.test.ts
git -C D:/Hackathons/hayba commit -m "feat(dag): infer read edges from param URI values"
```

---

### Task 5: Sliver spec — add `determinism.reads[]` (TDD)

**Files:**
- Modify: `mcp-tools/hayba-mcp/src/slivers/types.ts`
- Modify: `mcp-tools/hayba-mcp/src/slivers/spec-schema.ts`
- Modify: `mcp-tools/hayba-mcp/src/slivers/spec-schema.test.ts`

- [ ] **Step 1: Add the failing test**

In `mcp-tools/hayba-mcp/src/slivers/spec-schema.test.ts`, add this test inside the existing top-level `describe(...)` block:

```ts
  it('accepts an optional determinism.reads[] and defaults it to []', () => {
    const base = {
      id: 'com.test.reads', version: '1.0.0', category: 'test', title: 'R',
      description: '', author: 't', params: [], executor: { kind: 'test.r' },
    };
    const withReads = parseSliverSpec({
      ...base,
      determinism: { pure: true, declared_outputs: [], side_effects: [], reads: ['ue://*'], seed_param: null },
    });
    expect(withReads.ok).toBe(true);
    if (withReads.ok) expect(withReads.spec.determinism.reads).toEqual(['ue://*']);

    const withoutReads = parseSliverSpec({
      ...base,
      determinism: { pure: true, declared_outputs: [], side_effects: [], seed_param: null },
    });
    expect(withoutReads.ok).toBe(true);
    if (withoutReads.ok) expect(withoutReads.spec.determinism.reads).toEqual([]);
  });
```

If `parseSliverSpec` is not already imported at the top of the test file, add it: `import { parseSliverSpec } from './spec-schema.js';` (check the existing imports first — it is likely already there).

- [ ] **Step 2: Run test to verify it fails**

Run: `cd D:/Hackathons/hayba/mcp-tools/hayba-mcp && npx vitest run src/slivers/spec-schema.test.ts`
Expected: FAIL — `reads` is `undefined`, not `[]`.

- [ ] **Step 3: Update the determinism type**

In `mcp-tools/hayba-mcp/src/slivers/types.ts`, change the `SliverDeterminism` interface:

```ts
export interface SliverDeterminism {
  pure: boolean;
  declared_outputs: string[];
  side_effects: string[];
  reads: string[];
  seed_param: string | null;
}
```

- [ ] **Step 4: Update the Zod schema**

In `mcp-tools/hayba-mcp/src/slivers/spec-schema.ts`, change the `determinism` object:

```ts
const determinism = z.object({
  pure: z.boolean(),
  declared_outputs: z.array(z.string()),
  side_effects: z.array(z.string()),
  reads: z.array(z.string()).default([]),
  seed_param: z.string().nullable(),
});
```

The `.default([])` makes `reads` optional in the input JSON while always present on the parsed result.

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd D:/Hackathons/hayba/mcp-tools/hayba-mcp && npx vitest run src/slivers/`
Expected: all sliver tests pass (the new one plus all pre-existing).

- [ ] **Step 6: Commit**

```bash
git -C D:/Hackathons/hayba add mcp-tools/hayba-mcp/src/slivers/types.ts mcp-tools/hayba-mcp/src/slivers/spec-schema.ts mcp-tools/hayba-mcp/src/slivers/spec-schema.test.ts
git -C D:/Hackathons/hayba commit -m "feat(slivers): optional determinism.reads[] for DAG edge declarations"
```

---

### Task 6: `dag/index.ts` — `setupDagSystem` facade (TDD)

**Files:**
- Create: `mcp-tools/hayba-mcp/src/dag/index.ts`
- Create: `mcp-tools/hayba-mcp/src/dag/index.test.ts`

This task wires journal + dag together and exposes the two recording entry points. `recordMutation` is the generic path (used by the fence tool and asset hook); `paramsHashOf` is a shared helper.

- [ ] **Step 1: Write the failing test**

```ts
// mcp-tools/hayba-mcp/src/dag/index.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setupDagSystem, paramsHashOf } from './index.js';

describe('setupDagSystem', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'hayba-dagsys-')); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('recordMutation appends to the journal and updates the dag', () => {
    const sys = setupDagSystem({ projectDir: dir });
    sys.recordMutation({ actor: 'manual', reads: ['ue://A'], writes: ['sliver://B'], paramsHash: 'h', ok: true });
    expect(sys.journal.all()).toHaveLength(1);
    expect(sys.dag.nodes().map(n => n.uri).sort()).toEqual(['sliver://B', 'ue://A']);
    expect(sys.dag.edges()).toHaveLength(1);
  });

  it('rebuilds the dag by replaying the journal on a fresh setup', () => {
    const a = setupDagSystem({ projectDir: dir });
    a.recordMutation({ actor: 'manual', reads: ['ue://A'], writes: ['sliver://B'], paramsHash: 'h', ok: true });
    a.recordMutation({ actor: 'manual', reads: ['sliver://B'], writes: ['sliver://C'], paramsHash: 'h', ok: true });

    const b = setupDagSystem({ projectDir: dir });   // re-open
    expect(b.dag.nodes()).toHaveLength(3);
    expect(b.dag.edges()).toHaveLength(2);
  });

  it('recordSliverRun infers param-URI reads on top of declared reads', () => {
    const sys = setupDagSystem({ projectDir: dir });
    sys.recordSliverRun({
      sliverId: 'com.hayba.composition.frame_target',
      params: { target: 'ue://Game/Maps/Demo.Actor_0', distance: 12 },
      declaredReads: [],
      writes: ['sliver://run/abc'],
      ok: true,
    });
    const edges = sys.dag.edges();
    expect(edges.some(e => e.from === 'ue://Game/Maps/Demo.Actor_0' && e.provenance === 'inferred')).toBe(true);
  });

  it('paramsHashOf is stable regardless of key order', () => {
    expect(paramsHashOf({ a: 1, b: 2 })).toBe(paramsHashOf({ b: 2, a: 1 }));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd D:/Hackathons/hayba/mcp-tools/hayba-mcp && npx vitest run src/dag/index.test.ts`
Expected: FAIL (`Cannot find module './index.js'`).

- [ ] **Step 3: Implement `index.ts`**

```ts
// mcp-tools/hayba-mcp/src/dag/index.ts
//
// setupDagSystem — one-shot wiring of the operation journal + the
// in-memory dependency DAG. The DAG is rebuilt by replaying the journal
// at construction. recordMutation() is the generic append path;
// recordSliverRun() additionally infers read edges from param URIs.

import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { OperationJournal, type JournalInput } from './journal.js';
import { DependencyDag } from './dag.js';
import { inferReadsFromParams } from './edge-inference.js';

export interface DagSystem {
  journal: OperationJournal;
  dag: DependencyDag;
  recordMutation: (input: JournalInput) => void;
  recordSliverRun: (run: SliverRunRecord) => void;
}

export interface SliverRunRecord {
  sliverId: string;
  params: Record<string, unknown>;
  declaredReads: string[];
  writes: string[];
  ok: boolean;
}

export interface DagSetupOpts {
  /** Project directory; the journal lives under <projectDir>/journal.jsonl. */
  projectDir?: string;
}

/** Stable SHA-256 of an object with keys sorted, so re-running with the
 *  same inputs hashes identically regardless of key order. */
export function paramsHashOf(obj: Record<string, unknown>): string {
  const sorted = Object.keys(obj).sort().reduce<Record<string, unknown>>((acc, k) => {
    acc[k] = obj[k];
    return acc;
  }, {});
  return 'sha256:' + createHash('sha256').update(JSON.stringify(sorted)).digest('hex');
}

function defaultProjectDir(): string {
  return join(homedir(), '.hayba', 'default');
}

export function setupDagSystem(opts: DagSetupOpts = {}): DagSystem {
  const dir = opts.projectDir ?? defaultProjectDir();
  const journal = new OperationJournal(join(dir, 'journal.jsonl'));
  const dag = new DependencyDag();
  for (const rec of journal.all()) dag.applyRecord(rec);

  const recordMutation = (input: JournalInput): void => {
    try {
      const rec = journal.append(input);
      dag.applyRecord(rec);
    } catch (err) {
      // The journal is observability, never a gate — log and move on.
      console.error('[dag] recordMutation failed:', err);
    }
  };

  const recordSliverRun = (run: SliverRunRecord): void => {
    const inferred = inferReadsFromParams(run.params, run.declaredReads);
    const rec = (() => {
      try {
        return journal.append({
          actor: `sliver:${run.sliverId}`,
          reads: [...run.declaredReads, ...inferred],
          writes: run.writes,
          paramsHash: paramsHashOf(run.params),
          ok: run.ok,
        });
      } catch (err) {
        console.error('[dag] recordSliverRun failed:', err);
        return null;
      }
    })();
    if (!rec) return;
    // Declared reads via applyRecord; inferred reads tagged separately.
    dag.applyRecord({ ...rec, reads: run.declaredReads });
    for (const r of inferred) {
      for (const w of run.writes) dag.addInferredEdge(r, w, rec.seq);
    }
  };

  return { journal, dag, recordMutation, recordSliverRun };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd D:/Hackathons/hayba/mcp-tools/hayba-mcp && npx vitest run src/dag/index.test.ts`
Expected: 4 passing.

- [ ] **Step 5: Commit**

```bash
git -C D:/Hackathons/hayba add mcp-tools/hayba-mcp/src/dag/index.ts mcp-tools/hayba-mcp/src/dag/index.test.ts
git -C D:/Hackathons/hayba commit -m "feat(dag): setupDagSystem facade — journal + dag wiring + replay"
```

---

### Task 7: `dag/rebuild.ts` — dirty-subgraph rebuild driver (TDD)

**Files:**
- Create: `mcp-tools/hayba-mcp/src/dag/rebuild.ts`
- Create: `mcp-tools/hayba-mcp/src/dag/rebuild.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// mcp-tools/hayba-mcp/src/dag/rebuild.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setupDagSystem } from './index.js';
import { rebuildDirty } from './rebuild.js';

describe('rebuildDirty', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'hayba-rebuild-')); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('re-runs sliver nodes in topological order and clears their dirty flag', async () => {
    const sys = setupDagSystem({ projectDir: dir });
    sys.recordMutation({ actor: 'manual', reads: ['ue://A'], writes: ['sliver://B'], paramsHash: 'h', ok: true });
    sys.recordMutation({ actor: 'manual', reads: ['sliver://B'], writes: ['sliver://C'], paramsHash: 'h', ok: true });
    sys.recordMutation({ actor: 'manual', reads: [], writes: ['ue://A'], paramsHash: 'h', ok: true }); // dirties B, C

    const ran: string[] = [];
    const result = await rebuildDirty(sys.dag, {
      runNode: async (uri) => { ran.push(uri); return { ok: true }; },
    });
    expect(ran).toEqual(['sliver://B', 'sliver://C']);   // topo order
    expect(result.rebuilt).toEqual(['sliver://B', 'sliver://C']);
    expect(sys.dag.dirtySet()).toEqual([]);
  });

  it('skips a node the runner cannot rebuild and reports it', async () => {
    const sys = setupDagSystem({ projectDir: dir });
    sys.recordMutation({ actor: 'manual', reads: ['ue://A'], writes: ['ue://B'], paramsHash: 'h', ok: true });
    sys.recordMutation({ actor: 'manual', reads: [], writes: ['ue://A'], paramsHash: 'h', ok: true }); // dirties ue://B

    const result = await rebuildDirty(sys.dag, {
      runNode: async () => ({ ok: false, reason: 'no executor for ue:// node' }),
    });
    expect(result.rebuilt).toEqual([]);
    expect(result.skipped).toEqual([{ uri: 'ue://B', reason: 'no executor for ue:// node' }]);
    expect(result.stillDirty).toEqual(['ue://B']);
  });

  it('restricts the rebuild to the subtree under target when given', async () => {
    const sys = setupDagSystem({ projectDir: dir });
    sys.recordMutation({ actor: 'manual', reads: ['ue://A'], writes: ['sliver://B'], paramsHash: 'h', ok: true });
    sys.recordMutation({ actor: 'manual', reads: ['ue://X'], writes: ['sliver://Y'], paramsHash: 'h', ok: true });
    sys.recordMutation({ actor: 'manual', reads: [], writes: ['ue://A'], paramsHash: 'h', ok: true }); // dirties B
    sys.recordMutation({ actor: 'manual', reads: [], writes: ['ue://X'], paramsHash: 'h', ok: true }); // dirties Y

    const ran: string[] = [];
    await rebuildDirty(sys.dag, { runNode: async (u) => { ran.push(u); return { ok: true }; } }, 'ue://A');
    expect(ran).toEqual(['sliver://B']);   // only A's subtree
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd D:/Hackathons/hayba/mcp-tools/hayba-mcp && npx vitest run src/dag/rebuild.test.ts`
Expected: FAIL (`Cannot find module './rebuild.js'`).

- [ ] **Step 3: Implement `rebuild.ts`**

```ts
// mcp-tools/hayba-mcp/src/dag/rebuild.ts
//
// Drives hayba_dag_rebuild: walks the dirty set in topological order and
// asks the caller-supplied runner to re-run each node. A node the runner
// declines (no known executor) is skipped + reported, not failed.

import type { DependencyDag } from './dag.js';

export interface RunNodeResult {
  ok: boolean;
  reason?: string;
}

export interface RebuildDeps {
  /** Re-run the artifact behind `uri`. Resolve ok:false to skip it. */
  runNode: (uri: string) => Promise<RunNodeResult>;
}

export interface RebuildResult {
  rebuilt: string[];
  skipped: Array<{ uri: string; reason: string }>;
  stillDirty: string[];
}

/** Set of nodes reachable downstream of `root` (inclusive). */
function subtree(dag: DependencyDag, root: string): Set<string> {
  const seen = new Set<string>([root]);
  const stack = [root];
  const edges = dag.edges();
  while (stack.length) {
    const u = stack.pop()!;
    for (const e of edges) {
      if (e.from === u && !seen.has(e.to)) { seen.add(e.to); stack.push(e.to); }
    }
  }
  return seen;
}

export async function rebuildDirty(
  dag: DependencyDag,
  deps: RebuildDeps,
  target?: string,
): Promise<RebuildResult> {
  const dirty = new Set(dag.dirtySet());
  const scope = target ? subtree(dag, target) : null;

  const ordered = dag.topoOrder().filter(
    uri => dirty.has(uri) && (!scope || scope.has(uri)),
  );

  const rebuilt: string[] = [];
  const skipped: Array<{ uri: string; reason: string }> = [];
  for (const uri of ordered) {
    const r = await deps.runNode(uri);
    if (r.ok) {
      dag.clearDirty(uri);
      rebuilt.push(uri);
    } else {
      skipped.push({ uri, reason: r.reason ?? 'runner declined' });
    }
  }
  return { rebuilt, skipped, stillDirty: dag.dirtySet() };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd D:/Hackathons/hayba/mcp-tools/hayba-mcp && npx vitest run src/dag/rebuild.test.ts`
Expected: 3 passing.

- [ ] **Step 5: Commit**

```bash
git -C D:/Hackathons/hayba add mcp-tools/hayba-mcp/src/dag/rebuild.ts mcp-tools/hayba-mcp/src/dag/rebuild.test.ts
git -C D:/Hackathons/hayba commit -m "feat(dag): dirty-subgraph rebuild driver"
```

---

### Task 8: Sliver runtime — journal hook on every run (TDD)

**Files:**
- Modify: `mcp-tools/hayba-mcp/src/slivers/runtime.ts`
- Modify: `mcp-tools/hayba-mcp/src/slivers/index.ts`
- Modify: `mcp-tools/hayba-mcp/src/slivers/runtime.test.ts`

The runtime gains an optional `onRun` callback fired once per root `runSliver`, carrying enough for the DAG to record the run. `setupSliverSystem` passes it through.

- [ ] **Step 1: Read the current runtime**

```bash
sed -n '19,80p' D:/Hackathons/hayba/mcp-tools/hayba-mcp/src/slivers/runtime.ts
```

Confirm `SliverRuntimeOpts` (around line 19) and the `runRoot` method (around line 54) — `runRoot` is where one root run completes with its `outputs` and `side_effects`.

- [ ] **Step 2: Add the failing test**

In `mcp-tools/hayba-mcp/src/slivers/runtime.test.ts`, add this test inside the existing top-level `describe(...)`:

```ts
  it('fires onRun once per root run with id, params, writes, and ok', async () => {
    const calls: Array<{ id: string; ok: boolean; writes: string[] }> = [];
    const rt = new SliverRuntime({
      registry,
      getSpec,
      maxDepth: 8,
      onRun: (info) => calls.push({ id: info.sliverId, ok: info.ok, writes: info.writes }),
    });
    await rt.runSliver('com.test.pure', {});
    expect(calls).toHaveLength(1);
    expect(calls[0].id).toBe('com.test.pure');
    expect(calls[0].ok).toBe(true);
  });
```

This test reuses whatever `registry` / `getSpec` helpers the existing `runtime.test.ts` already sets up for a `com.test.pure` spec. Read the top of that file first; if the existing spec id differs, use that id and adjust the assertion. If there is no trivially-pure fixture, register one in the test's setup the same way the other tests in the file do.

- [ ] **Step 3: Run test to verify it fails**

Run: `cd D:/Hackathons/hayba/mcp-tools/hayba-mcp && npx vitest run src/slivers/runtime.test.ts`
Expected: FAIL — `onRun` is not a known option / not called.

- [ ] **Step 4: Add `onRun` to the runtime**

In `runtime.ts`, add the callback type and option. Near the top with the other interfaces:

```ts
export interface SliverRunInfo {
  sliverId: string;
  params: SliverParamValues;
  declaredReads: string[];
  writes: string[];
  ok: boolean;
}

export type SliverOnRun = (info: SliverRunInfo) => void;
```

Add `onRun` to `SliverRuntimeOpts`:

```ts
export interface SliverRuntimeOpts {
  registry: ExecutorRegistry;
  getSpec: (id: string) => SliverSpec | undefined;
  maxDepth: number;
  onRun?: SliverOnRun;
}
```

Store it in the constructor (alongside the existing assignments):

```ts
  private readonly onRun?: SliverOnRun;
  constructor(opts: SliverRuntimeOpts) {
    // ... existing assignments ...
    this.onRun = opts.onRun;
  }
```

In `runRoot`, after the result is determined (both the success and the catch path), fire the callback before returning. The simplest place: wrap the existing return value. Locate the success `return { ok: true, outputs, side_effects: dedup(effects), durationMs };` and the catch `return { ok: false, ... }`. Refactor `runRoot` so both paths assign a `result` variable, then before returning:

```ts
    const spec = this.getSpec(id);
    if (this.onRun) {
      this.onRun({
        sliverId: id,
        params,
        declaredReads: spec ? spec.determinism.reads : [],
        writes: result.side_effects,
        ok: result.ok,
      });
    }
    return result;
```

Place this so it runs for both the success and the error result. `result.side_effects` is the deduped side-effect list (already computed for the success path; `[]` on the error path — that matches the existing error return).

- [ ] **Step 5: Pass `onRun` through `setupSliverSystem`**

In `slivers/index.ts`, add `onRun` to `SetupOpts`:

```ts
export interface SetupOpts {
  userDir?: string;
  bundledDir?: string;
  maxDepth?: number;
  onRun?: import('./runtime.js').SliverOnRun;
}
```

And pass it into the `SliverRuntime` constructor:

```ts
  const runtime = new SliverRuntime({
    registry,
    getSpec: (id) => loader.get(id),
    maxDepth: opts.maxDepth ?? 8,
    onRun: opts.onRun,
  });
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd D:/Hackathons/hayba/mcp-tools/hayba-mcp && npx vitest run src/slivers/`
Expected: all sliver tests pass, including the new `onRun` test.

- [ ] **Step 7: Commit**

```bash
git -C D:/Hackathons/hayba add mcp-tools/hayba-mcp/src/slivers/runtime.ts mcp-tools/hayba-mcp/src/slivers/index.ts mcp-tools/hayba-mcp/src/slivers/runtime.test.ts
git -C D:/Hackathons/hayba commit -m "feat(slivers): onRun hook so sliver runs feed the operation journal"
```

---

### Task 9: The four DAG MCP tool handlers (TDD)

**Files:**
- Create: `mcp-tools/hayba-mcp/src/tools/dag/status.ts`
- Create: `mcp-tools/hayba-mcp/src/tools/dag/record.ts`
- Create: `mcp-tools/hayba-mcp/src/tools/dag/rebuild.ts`
- Create: `mcp-tools/hayba-mcp/src/tools/dag/journal-tail.ts`
- Create: `mcp-tools/hayba-mcp/src/tools/dag/dag-tools.test.ts`

Each handler mirrors the sliver tool shape: an exported Zod `*Schema`, a `*Handler(args, ctx)` function, and a `meta` block.

- [ ] **Step 1: Write the failing test**

```ts
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
    await dagRecordHandler({ writes: ['ue://A'] }, { dag: sys });  // dirties sliver://B
    const status = await dagStatusHandler({ dirtyOnly: true }, { dag: sys });
    expect(status.nodes.map(n => n.uri)).toEqual(['sliver://B']);
  });

  it('dag_rebuild reports skipped nodes with no executor', async () => {
    await dagRecordHandler({ reads: ['ue://A'], writes: ['ue://B'] }, { dag: sys });
    await dagRecordHandler({ writes: ['ue://A'] }, { dag: sys });   // dirties ue://B
    const r = await dagRebuildHandler({}, { dag: sys, runSliverNode: async () => ({ ok: false, reason: 'not a sliver node' }) });
    expect(r.skipped).toEqual([{ uri: 'ue://B', reason: 'not a sliver node' }]);
  });

  it('journal_tail returns recent records newest last', async () => {
    await dagRecordHandler({ writes: ['ue://A'], note: 'first' }, { dag: sys });
    await dagRecordHandler({ writes: ['ue://B'], note: 'second' }, { dag: sys });
    const t = await journalTailHandler({ limit: 1 }, { dag: sys });
    expect(t.entries).toHaveLength(1);
    expect(t.entries[0].note).toBe('second');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd D:/Hackathons/hayba/mcp-tools/hayba-mcp && npx vitest run src/tools/dag/dag-tools.test.ts`
Expected: FAIL (`Cannot find module './status.js'`).

- [ ] **Step 3: Implement `status.ts`**

```ts
// mcp-tools/hayba-mcp/src/tools/dag/status.ts
import { z } from 'zod';
import type { DagSystem } from '../../dag/index.js';

export const dagStatusSchema = {
  namespace: z.string().optional(),
  dirtyOnly: z.boolean().optional(),
};

export interface DagCtx { dag: DagSystem; }

export interface DagStatusResult {
  nodeCount: number;
  dirtyCount: number;
  nodes: Array<{ uri: string; namespace: string; dirty: boolean; lastWriteSeq: number | null }>;
  edges: Array<{ from: string; to: string; provenance: string; viaSeq: number }>;
  warnings: string[];
}

export async function dagStatusHandler(
  args: { namespace?: string; dirtyOnly?: boolean },
  ctx: DagCtx,
): Promise<DagStatusResult> {
  const all = ctx.dag.dag.nodes();
  const nodes = all
    .filter(n => !args.namespace || n.namespace === args.namespace)
    .filter(n => !args.dirtyOnly || n.dirty);
  return {
    nodeCount: all.length,
    dirtyCount: all.filter(n => n.dirty).length,
    nodes,
    edges: ctx.dag.dag.edges(),
    warnings: ctx.dag.dag.warnings(),
  };
}

export const meta = {
  cost: 'low' as const,
  effects: ['read'],
  when: 'You want to see the dependency graph of generated artifacts and which are stale (dirty).',
  not_when: 'You want to re-run stale work — use hayba_dag_rebuild.',
  pack: 'core',
};
```

- [ ] **Step 4: Implement `record.ts`**

```ts
// mcp-tools/hayba-mcp/src/tools/dag/record.ts
import { z } from 'zod';
import type { DagSystem } from '../../dag/index.js';
import { isUri } from '../../dag/uri.js';

export const dagRecordSchema = {
  reads: z.array(z.string()).optional(),
  writes: z.array(z.string()).min(1),
  actor: z.string().optional(),
  note: z.string().optional(),
};

export interface DagRecordCtx { dag: DagSystem; }

export type DagRecordResult =
  | { ok: true; seq: number }
  | { ok: false; error: string };

export async function dagRecordHandler(
  args: { reads?: string[]; writes: string[]; actor?: string; note?: string },
  ctx: DagRecordCtx,
): Promise<DagRecordResult> {
  const reads = args.reads ?? [];
  const bad = [...reads, ...args.writes].find(u => !isUri(u));
  if (bad) return { ok: false, error: `not a valid artifact URI: "${bad}"` };

  const before = ctx.dag.journal.all().length;
  ctx.dag.recordMutation({
    actor: args.actor ?? 'manual',
    reads,
    writes: args.writes,
    paramsHash: '',
    ok: true,
    note: args.note ?? null,
  });
  const after = ctx.dag.journal.all();
  if (after.length === before) return { ok: false, error: 'journal append failed' };
  return { ok: true, seq: after[after.length - 1].seq };
}

export const meta = {
  cost: 'low' as const,
  effects: ['write'],
  when: 'You performed a mutation Hayba did not instrument (editor-side actor edits, manual file writes) and want the DAG to know.',
  not_when: 'The mutation was a sliver run or an asset tool — those record themselves.',
  pack: 'core',
};
```

- [ ] **Step 5: Implement `rebuild.ts`**

```ts
// mcp-tools/hayba-mcp/src/tools/dag/rebuild.ts
import { z } from 'zod';
import type { DagSystem } from '../../dag/index.js';
import { rebuildDirty, type RunNodeResult } from '../../dag/rebuild.js';

export const dagRebuildSchema = {
  target: z.string().optional(),
};

export interface DagRebuildCtx {
  dag: DagSystem;
  /** Re-run the sliver behind a sliver:// node. ok:false → skip. */
  runSliverNode: (uri: string) => Promise<RunNodeResult>;
}

export interface DagRebuildResult {
  rebuilt: string[];
  skipped: Array<{ uri: string; reason: string }>;
  stillDirty: string[];
}

export async function dagRebuildHandler(
  args: { target?: string },
  ctx: DagRebuildCtx,
): Promise<DagRebuildResult> {
  return rebuildDirty(ctx.dag.dag, { runNode: ctx.runSliverNode }, args.target);
}

export const meta = {
  cost: 'high' as const,
  effects: ['write'],
  when: 'Stale (dirty) artifacts need re-running after an upstream change.',
  not_when: 'You only want to inspect what is dirty — use hayba_dag_status.',
  pack: 'core',
};
```

- [ ] **Step 6: Implement `journal-tail.ts`**

```ts
// mcp-tools/hayba-mcp/src/tools/dag/journal-tail.ts
import { z } from 'zod';
import type { DagSystem } from '../../dag/index.js';
import type { JournalRecord } from '../../dag/journal.js';

export const journalTailSchema = {
  limit: z.number().int().positive().optional(),
};

export interface JournalTailCtx { dag: DagSystem; }

export interface JournalTailResult { entries: JournalRecord[]; }

export async function journalTailHandler(
  args: { limit?: number },
  ctx: JournalTailCtx,
): Promise<JournalTailResult> {
  return { entries: ctx.dag.journal.tail(args.limit ?? 50) };
}

export const meta = {
  cost: 'low' as const,
  effects: ['read'],
  when: 'You want a recent history of mutation operations for debugging or context.',
  not_when: 'You want the current dependency graph — use hayba_dag_status.',
  pack: 'core',
};
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `cd D:/Hackathons/hayba/mcp-tools/hayba-mcp && npx vitest run src/tools/dag/dag-tools.test.ts`
Expected: 5 passing.

- [ ] **Step 8: Commit**

```bash
git -C D:/Hackathons/hayba add mcp-tools/hayba-mcp/src/tools/dag/
git -C D:/Hackathons/hayba commit -m "feat(dag): hayba_dag_status / record / rebuild / journal_tail tool handlers"
```

---

### Task 10: Asset-source tools — journal hook on verified writes (TDD)

**Files:**
- Modify: `mcp-tools/hayba-mcp/src/tools/asset-sources/shared.ts`
- Create: `mcp-tools/hayba-mcp/src/tools/asset-sources/dag-hook.test.ts`

- [ ] **Step 1: Read `shared.ts`**

```bash
sed -n '1,60p' D:/Hackathons/hayba/mcp-tools/hayba-mcp/src/tools/asset-sources/shared.ts
grep -n "verif\|export function\|export interface\|side.effect\|VerifyResult" D:/Hackathons/hayba/mcp-tools/hayba-mcp/src/tools/asset-sources/shared.ts
```

Identify the function that runs the verified-side-effect check after an asset op (it produces a verified output path/asset). The hook must fire only on a *successful* verification.

- [ ] **Step 2: Write the failing test**

```ts
// mcp-tools/hayba-mcp/src/tools/asset-sources/dag-hook.test.ts
import { describe, it, expect } from 'vitest';
import { setAssetDagSink, emitAssetWrite } from './shared.js';

describe('asset-source DAG hook', () => {
  it('emitAssetWrite forwards a verified write to the registered sink', () => {
    const seen: Array<{ uri: string }> = [];
    setAssetDagSink((uri) => seen.push({ uri }));
    emitAssetWrite('/Game/Imported/SM_Rock');
    expect(seen).toEqual([{ uri: 'ue://Game/Imported/SM_Rock' }]);
  });

  it('emitAssetWrite is a no-op when no sink is registered', () => {
    setAssetDagSink(null);
    expect(() => emitAssetWrite('/Game/X')).not.toThrow();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd D:/Hackathons/hayba/mcp-tools/hayba-mcp && npx vitest run src/tools/asset-sources/dag-hook.test.ts`
Expected: FAIL (`setAssetDagSink` / `emitAssetWrite` not exported).

- [ ] **Step 4: Add the sink to `shared.ts`**

Append to `mcp-tools/hayba-mcp/src/tools/asset-sources/shared.ts`:

```ts
// ── DAG hook ────────────────────────────────────────────────────────────────
// The DAG system registers a sink here; every verified asset write is
// forwarded as a "ue://" node so imports/generations land in the journal.
// Decoupled by a module-level sink so asset-sources keeps no DAG import.

export type AssetDagSink = (writeUri: string) => void;

let assetDagSink: AssetDagSink | null = null;

export function setAssetDagSink(sink: AssetDagSink | null): void {
  assetDagSink = sink;
}

/** Forward a verified asset write (a UE content path) to the DAG sink. */
export function emitAssetWrite(assetPath: string): void {
  if (!assetDagSink) return;
  const clean = assetPath.startsWith('/') ? assetPath.slice(1) : assetPath;
  assetDagSink(`ue://${clean}`);
}
```

Then, in the function identified in Step 1, after a *successful* verification, call `emitAssetWrite(<verified asset path>)`. Add exactly one call at the success branch — do not change the verification logic itself.

- [ ] **Step 5: Run test to verify it passes**

Run: `cd D:/Hackathons/hayba/mcp-tools/hayba-mcp && npx vitest run src/tools/asset-sources/dag-hook.test.ts`
Expected: 2 passing.

- [ ] **Step 6: Commit**

```bash
git -C D:/Hackathons/hayba add mcp-tools/hayba-mcp/src/tools/asset-sources/shared.ts mcp-tools/hayba-mcp/src/tools/asset-sources/dag-hook.test.ts
git -C D:/Hackathons/hayba commit -m "feat(dag): asset-source verified writes feed the operation journal"
```

---

### Task 11: Wire the DAG system into deferred routing

**Files:**
- Modify: `mcp-tools/hayba-mcp/src/tools/routing/register.ts`

- [ ] **Step 1: Add imports**

At the top of `register.ts`, alongside the sliver imports (around line 28-32), add:

```ts
import { setupDagSystem, type DagSystem } from '../../dag/index.js';
import { dagStatusHandler, dagStatusSchema } from '../dag/status.js';
import { dagRecordHandler, dagRecordSchema } from '../dag/record.js';
import { dagRebuildHandler, dagRebuildSchema } from '../dag/rebuild.js';
import { journalTailHandler, journalTailSchema } from '../dag/journal-tail.js';
import { setAssetDagSink } from '../asset-sources/shared.js';
```

- [ ] **Step 2: Add the four tool names to `ALWAYS_ON_META`**

In the `ALWAYS_ON_META` set (around line 35-46), add four entries:

```ts
  'hayba_dag_status',
  'hayba_dag_record',
  'hayba_dag_rebuild',
  'hayba_journal_tail',
```

- [ ] **Step 3: Add `dag` to `RoutingHandle`**

In the `RoutingHandle` interface (around line 63-68), add a field:

```ts
  dag: DagSystem;
```

- [ ] **Step 4: Construct the DAG system before the slivers and wire the hooks**

Find the slivers block (around line 293-295: `const slivers = await setupSliverSystem();`). Replace those lines with:

```ts
  // ── DAG + journal (Layer 2 — operation tracking) ───────────────────────────
  const dag = setupDagSystem();

  // Asset-source verified writes feed the journal.
  setAssetDagSink((writeUri) => {
    dag.recordMutation({ actor: 'asset', reads: [], writes: [writeUri], paramsHash: '', ok: true });
  });

  // ── Slivers (Layer 2 — deterministic abstractions) ─────────────────────────
  const slivers = await setupSliverSystem({
    onRun: (info) => {
      dag.recordSliverRun({
        sliverId: info.sliverId,
        params: info.params,
        declaredReads: info.declaredReads,
        writes: info.writes,
        ok: info.ok,
      });
    },
  });
```

- [ ] **Step 5: Register the four DAG tools**

After the four `server.tool('hayba_sliver_*', ...)` registrations (around line 336, before the "Always-load packs" comment), add:

```ts
  server.tool(
    'hayba_dag_status',
    'Show the dependency graph of generated artifacts and which are stale (dirty).',
    dagStatusSchema,
    async (args: { namespace?: string; dirtyOnly?: boolean }) => {
      const r = await dagStatusHandler(args, { dag });
      return { content: [{ type: 'text' as const, text: JSON.stringify(r, null, 2) }] };
    },
  );

  server.tool(
    'hayba_dag_record',
    'Record a mutation Hayba did not instrument (editor-side edits, manual writes) so the DAG stays accurate.',
    dagRecordSchema,
    async (args: { reads?: string[]; writes: string[]; actor?: string; note?: string }) => {
      const r = await dagRecordHandler(args, { dag });
      return { content: [{ type: 'text' as const, text: JSON.stringify(r, null, 2) }] };
    },
  );

  server.tool(
    'hayba_dag_rebuild',
    'Re-run stale (dirty) artifacts. Optionally restrict to the subtree under a target URI.',
    dagRebuildSchema,
    async (args: { target?: string }) => {
      const r = await dagRebuildHandler(args, {
        dag,
        runSliverNode: async (uri: string) => {
          // v1: only sliver:// nodes are rebuildable. Re-running a sliver
          // run from its node id is out of v1 scope, so report it as skipped
          // here — the executor-resolution path lands in v2.
          return { ok: false, reason: uri.startsWith('sliver://')
            ? 'sliver re-run from node id is v2'
            : 'no executor for this node type' };
        },
      });
      return { content: [{ type: 'text' as const, text: JSON.stringify(r, null, 2) }] };
    },
  );

  server.tool(
    'hayba_journal_tail',
    'Return the most recent mutation operations from the journal.',
    journalTailSchema,
    async (args: { limit?: number }) => {
      const r = await journalTailHandler(args, { dag });
      return { content: [{ type: 'text' as const, text: JSON.stringify(r, null, 2) }] };
    },
  );
```

- [ ] **Step 6: Add `dag` to the returned handle**

In the `return { ... }` at the end of `registerDeferredRouting` (around line 348-354), add `dag,` next to `slivers,`.

- [ ] **Step 7: Verify build + typecheck**

```bash
cd D:/Hackathons/hayba/mcp-tools/hayba-mcp
npx tsc --noEmit -p .
npm run build:server
```

Expected: clean — no type errors.

- [ ] **Step 8: Commit**

```bash
git -C D:/Hackathons/hayba add mcp-tools/hayba-mcp/src/tools/routing/register.ts
git -C D:/Hackathons/hayba commit -m "feat(dag): wire DAG system + 4 tools into deferred routing"
```

---

### Task 12: End-to-end smoke verification

**Files:**
- Create: `mcp-tools/hayba-mcp/.scratch/verify-dag.mjs` (not committed — `.scratch/` is gitignored)

- [ ] **Step 1: Write the smoke driver**

```js
// mcp-tools/hayba-mcp/.scratch/verify-dag.mjs
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setupDagSystem } from '../dist/dag/index.js';

const dir = mkdtempSync(join(tmpdir(), 'hayba-dag-smoke-'));
try {
  const a = setupDagSystem({ projectDir: dir });
  a.recordSliverRun({
    sliverId: 'com.hayba.composition.frame_target',
    params: { target: 'ue://Game/Maps/Demo.Actor_0', distance: 12 },
    declaredReads: [],
    writes: ['sliver://run/cam1'],
    ok: true,
  });
  a.recordMutation({ actor: 'manual', reads: [], writes: ['ue://Game/Maps/Demo.Actor_0'], paramsHash: '', ok: true });

  console.log('nodes :', a.dag.nodes().map(n => n.uri));
  console.log('edges :', a.dag.edges().map(e => `${e.from}->${e.to}(${e.provenance})`));
  console.log('dirty :', a.dag.dirtySet());

  const b = setupDagSystem({ projectDir: dir });   // replay
  if (b.dag.nodes().length !== a.dag.nodes().length) { console.error('FAIL: replay mismatch'); process.exit(1); }
  if (!a.dag.dirtySet().includes('sliver://run/cam1')) { console.error('FAIL: cam not dirtied'); process.exit(1); }
  console.log('replay OK — ALL GOOD');
} finally {
  rmSync(dir, { recursive: true, force: true });
}
```

- [ ] **Step 2: Build and run**

```bash
cd D:/Hackathons/hayba/mcp-tools/hayba-mcp
npm run build:server
node .scratch/verify-dag.mjs
```

Expected output: nodes/edges/dirty printed; `sliver://run/cam1` appears in `dirty` (the inferred edge `ue://Game/Maps/Demo.Actor_0 → sliver://run/cam1` propagated the dirty mark when the actor was re-written); `replay OK — ALL GOOD`.

- [ ] **Step 3: Run the full DAG + sliver test suites**

```bash
cd D:/Hackathons/hayba/mcp-tools/hayba-mcp
npx vitest run src/dag src/slivers src/tools/dag
```

Expected: all green.

- [ ] **Step 4: Commit nothing** (verification only — `.scratch/` is gitignored).

---

### Task 13: Push branch + open PR

- [ ] **Step 1: Push**

```bash
git -C D:/Hackathons/hayba push -u origin feat/dependency-dag
```

(Create the branch before Task 1: `git -C D:/Hackathons/hayba checkout -b feat/dependency-dag` from `main`.)

- [ ] **Step 2: Open the PR**

```bash
gh pr create --base main --head feat/dependency-dag \
  --title "Operation journal + dependency DAG" \
  --body "$(cat <<'EOF'
## Summary
- Append-only per-project operation journal (`~/.hayba/<project>/journal.jsonl`).
- In-memory dependency DAG rebuilt by replaying the journal; mark-only dirty propagation.
- Sliver runs + asset-source verified writes auto-record; `hayba_dag_record` fences un-instrumented mutations.
- Four always-on MCP tools: `hayba_dag_status`, `hayba_dag_record`, `hayba_dag_rebuild`, `hayba_journal_tail`.
- Sliver spec gains optional `determinism.reads[]`.

Implements `docs/superpowers/specs/2026-05-22-operation-journal-dependency-dag-design.md`
(Priority 2 of the determinism roadmap + post-mortem #12).

## Test plan
- [x] vitest src/dag — uri, journal, dag, edge-inference, index, rebuild
- [x] vitest src/tools/dag — 4 tool handlers
- [x] vitest src/slivers — determinism.reads[] + runtime onRun hook
- [x] tsc --noEmit clean
- [x] .scratch/verify-dag.mjs — end-to-end record + replay + dirty propagation

## Scope cuts (v2)
- `hayba_dag_rebuild` reports `sliver://` nodes as skipped (executor-resolution from a node id is v2).
- No DAG visualization UI.
- Dirty = any downstream write; content-hash-aware invalidation is v2.
EOF
)"
```

Expected: PR URL printed.

---

## Self-Review Notes

**Spec coverage:**

| Spec section | Task |
|---|---|
| URI scheme + phantom nodes | Task 1 (parse) + Task 3 (`ensureNode` lazy create) |
| Operation journal (JSONL, seq, replay, corrupt-line tolerance) | Task 2 |
| Dependency DAG (nodes, edges, dirty propagation, cycle reject, topo) | Task 3 |
| Edge inference from param URIs | Task 4 |
| Sliver `determinism.reads[]` | Task 5 |
| `setupDagSystem` facade + replay | Task 6 |
| `hayba_dag_rebuild` driver (topo, skip unknown executor, subtree) | Task 7 + Task 9 |
| Sliver-run auto-registration | Task 8 (runtime hook) + Task 11 (wiring) |
| 4 MCP tools | Task 9 (handlers) + Task 11 (registration + ALWAYS_ON_META) |
| Asset-source auto-registration | Task 10 + Task 11 (sink wiring) |
| `paramsHash` (stable, key-order independent) | Task 6 (`paramsHashOf`) |
| Error handling — journal append never gates | Task 6 (`recordMutation` try/catch) |
| Error handling — corrupt journal line | Task 2 (`replay` skip) |
| Error handling — unknown-executor rebuild skip | Task 7 + Task 9 |
| Error handling — cycle rejection | Task 3 (`wouldCycle`) |

**Placeholder scan:** every code step has complete code; every command has expected output. The only "read the file first" steps (Task 8 Step 1, Task 10 Step 1) name the exact file + line range and what to look for — they are read-to-confirm steps, not deferred work.

**Type consistency:** `JournalRecord` / `JournalInput` (Task 2) are consumed unchanged by Task 3 (`applyRecord`), Task 6, Task 9. `DagSystem` (Task 6) is the `ctx.dag` type in every Task 9 handler and the `RoutingHandle.dag` field (Task 11). `RunNodeResult` (Task 7) is reused by `rebuild.ts` tool ctx (Task 9). `SliverRunInfo` / `SliverOnRun` (Task 8) match the `onRun` consumer in Task 11. `recordSliverRun`'s `SliverRunRecord` (Task 6) matches the call site in Task 11 Step 4. `paramsHashOf` (Task 6) is the only hash producer; the fence tool passes `paramsHash: ''` deliberately (a manual record has no params).

**Scope:** single module (`src/dag/`) + one sliver-spec field + one routing wire-up — one coherent plan, no decomposition needed.
