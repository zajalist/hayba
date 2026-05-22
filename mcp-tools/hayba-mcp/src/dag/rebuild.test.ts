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
    sys.recordMutation({ actor: 'manual', reads: [], writes: ['ue://A'], paramsHash: 'h', ok: true });

    const ran: string[] = [];
    const result = await rebuildDirty(sys.dag, {
      runNode: async (uri) => { ran.push(uri); return { ok: true }; },
    });
    expect(ran).toEqual(['sliver://B', 'sliver://C']);
    expect(result.rebuilt).toEqual(['sliver://B', 'sliver://C']);
    expect(sys.dag.dirtySet()).toEqual([]);
  });

  it('skips a node the runner cannot rebuild and reports it', async () => {
    const sys = setupDagSystem({ projectDir: dir });
    sys.recordMutation({ actor: 'manual', reads: ['ue://A'], writes: ['ue://B'], paramsHash: 'h', ok: true });
    sys.recordMutation({ actor: 'manual', reads: [], writes: ['ue://A'], paramsHash: 'h', ok: true });

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
    sys.recordMutation({ actor: 'manual', reads: [], writes: ['ue://A'], paramsHash: 'h', ok: true });
    sys.recordMutation({ actor: 'manual', reads: [], writes: ['ue://X'], paramsHash: 'h', ok: true });

    const ran: string[] = [];
    await rebuildDirty(sys.dag, { runNode: async (u) => { ran.push(u); return { ok: true }; } }, 'ue://A');
    expect(ran).toEqual(['sliver://B']);
  });
});
