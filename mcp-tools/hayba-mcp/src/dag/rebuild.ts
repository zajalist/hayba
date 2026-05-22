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
  runNode: (uri: string) => Promise<RunNodeResult>;
}

export interface RebuildResult {
  rebuilt: string[];
  skipped: Array<{ uri: string; reason: string }>;
  stillDirty: string[];
}

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
