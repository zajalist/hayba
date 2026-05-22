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
    if (this.edgeList.some(e => e.from === from && e.to === to)) return;
    if (this.wouldCycle(from, to)) {
      this.warningList.push(`edge ${from} → ${to} rejected: would create a cycle`);
      return;
    }
    this.edgeList.push({ from, to, provenance, viaSeq });
  }

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
