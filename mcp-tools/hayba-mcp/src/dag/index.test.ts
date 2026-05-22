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

    const b = setupDagSystem({ projectDir: dir });
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
