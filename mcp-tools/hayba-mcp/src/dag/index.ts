// mcp-tools/hayba-mcp/src/dag/index.ts
//
// setupDagSystem — one-shot wiring of the operation journal + the
// in-memory dependency DAG. The DAG is rebuilt by replaying the journal
// at construction. recordMutation() is the generic append path;
// recordRecipeRun() additionally infers read edges from param URIs.

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
  recordRecipeRun: (run: RecipeRunRecord) => void;
}

export interface RecipeRunRecord {
  recipeId: string;
  params: Record<string, unknown>;
  declaredReads: string[];
  writes: string[];
  ok: boolean;
}

export interface DagSetupOpts {
  projectDir?: string;
}

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
      console.error('[dag] recordMutation failed:', err);
    }
  };

  const recordRecipeRun = (run: RecipeRunRecord): void => {
    const inferred = inferReadsFromParams(run.params, run.declaredReads);
    const rec = (() => {
      try {
        return journal.append({
          actor: `recipe:${run.recipeId}`,
          reads: [...run.declaredReads, ...inferred],
          writes: run.writes,
          paramsHash: paramsHashOf(run.params),
          ok: run.ok,
        });
      } catch (err) {
        console.error('[dag] recordRecipeRun failed:', err);
        return null;
      }
    })();
    if (!rec) return;
    dag.applyRecord({ ...rec, reads: run.declaredReads });
    for (const r of inferred) {
      for (const w of run.writes) dag.addInferredEdge(r, w, rec.seq);
    }
  };

  return { journal, dag, recordMutation, recordRecipeRun };
}
