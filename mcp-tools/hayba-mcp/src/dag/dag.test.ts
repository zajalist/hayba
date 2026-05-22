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
    d.applyRecord(rec(1, ['ue://A'], ['sliver://B']));
    d.applyRecord(rec(2, ['sliver://B'], ['sliver://C']));
    d.applyRecord(rec(3, [], ['ue://A']));
    expect(d.dirtySet().sort()).toEqual(['sliver://B', 'sliver://C']);
    expect(d.dirtySet()).not.toContain('ue://A');
  });

  it('rejects an edge that would create a cycle and records a warning', () => {
    const d = new DependencyDag();
    d.applyRecord(rec(1, ['ue://A'], ['ue://B']));
    d.applyRecord(rec(2, ['ue://B'], ['ue://A']));
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
