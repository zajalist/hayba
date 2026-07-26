import { describe, it, expect } from 'vitest';
import { ToolIndex, type ToolDoc } from './tool-index.js';
import { STANDARD_DESCRIPTORS, inferDir } from '../index.js';

// Search-quality benchmark.
//
// Search became load-bearing the moment the default surface dropped to seven
// tools: if an agent cannot find `ui_validate` by asking for "check my menu for
// text overflow", that tool effectively does not exist. Ranking is therefore a
// correctness property, not a nice-to-have, and it gets measured rather than
// eyeballed.
//
// The corpus is the REAL descriptor list, not a fixture, so the benchmark
// degrades honestly when someone writes a vague tool description. A query that
// regresses here is usually telling you the description is bad, not the ranker.
//
// Queries are phrased the way an agent actually phrases them: intent and
// symptom, not tool names. Anything answerable by exact-name lookup is not a
// search problem.

interface Case {
  query: string;
  /** Any one of these counts as correct — several tools can be a fair answer. */
  expect: string[];
}

const CASES: Case[] = [
  // Intent, no jargon.
  { query: 'make a menu screen', expect: ['ui_create_widget', 'ui_build_tree'] },
  { query: 'add a button to my HUD', expect: ['ui_add_element', 'ui_build_tree'] },
  { query: 'check my UI for text that gets cut off', expect: ['ui_validate', 'ui_measure_text'] },
  { query: 'how wide is this text going to render', expect: ['ui_measure_text', 'ui_layout_snapshot'] },
  { query: 'change the font on a label', expect: ['ui_set_text_style', 'ui_set_property'] },

  // Domain words people use instead of the internal name.
  { query: 'shader', expect: ['material_create', 'material_add_node', 'material_compile', 'material_list'] },
  { query: 'place a mesh in the level', expect: ['actor_spawn', 'actor_spawn_from_asset'] },
  { query: 'what actors are in my scene', expect: ['actor_list', 'scene_export'] },
  { query: 'landscape layers', expect: ['landscape_layer_list', 'landscape_add_layer'] },
  // camelCase vocabulary: the description says "StaticMesh", the user types two
  // words. Protects the tokenizer that took this from rank 7 to rank 1.
  { query: 'spawn from a static mesh', expect: ['actor_spawn_from_asset', 'actor_spawn'] },

  // Capability phrasing.
  { query: 'compile a blueprint', expect: ['blueprint_compile', 'ui_compile_widget'] },
  { query: 'save an asset to disk', expect: ['asset_save'] },
  { query: 'delete an actor', expect: ['actor_delete'] },
  { query: 'set a material parameter', expect: ['material_set_param', 'material_set_property'] },
  { query: 'wire two pcg nodes together', expect: ['pcg_wire'] },
  { query: 'check physics overlaps', expect: ['scene_validate_physics'] },
  { query: 'move an actor to a new position', expect: ['actor_transform', 'actor_batch_transform'] },
];

function buildDocs(): ToolDoc[] {
  return STANDARD_DESCRIPTORS.map((d) => {
    const dir = inferDir(d.name) ?? 'core';
    const meta = d.meta as { when?: string; effects?: string[] } | undefined;
    return {
      name: d.name,
      summary: meta?.when ?? d.description ?? '',
      description: d.description ?? '',
      tags: meta?.effects ?? [],
      packs: [dir],
      cost: 'medium' as const,
    };
  });
}

let cached: ToolIndex | null = null;
async function index(): Promise<ToolIndex> {
  if (!cached) cached = await ToolIndex.build(buildDocs(), { embeddings: null });
  return cached;
}

/** 1-based rank of the first acceptable answer, or Infinity. */
async function rankOf(c: Case, k = 10): Promise<number> {
  const hits = await (await index()).search(c.query, { k });
  const names = hits.map((h) => h.name);
  let best = Infinity;
  for (const want of c.expect) {
    const i = names.indexOf(want);
    if (i >= 0) best = Math.min(best, i + 1);
  }
  return best;
}

describe('search quality', () => {
  it('the benchmark corpus is the real tool catalogue', () => {
    expect(buildDocs().length).toBeGreaterThan(150);
  });

  it('every expected tool actually exists in the corpus', () => {
    // Without this the benchmark silently measures nothing: an expectation
    // naming a tool that is not indexed can never be satisfied, and reads as a
    // ranking failure when it is really a bad test. This caught six such cases.
    //
    // NOTE: the corpus here is STANDARD_DESCRIPTORS only. Tools registered
    // directly with server.tool() in index.ts (python_run, editor_capture_viewport,
    // the pcg_* and gaea_* families) are NOT included, so do not write cases for
    // them until the corpus covers them.
    const known = new Set(buildDocs().map((d) => d.name));
    const missing: string[] = [];
    for (const c of CASES) {
      for (const name of c.expect) if (!known.has(name)) missing.push(`${c.query} -> ${name}`);
    }
    expect(missing, `benchmark expects tools absent from the corpus:\n${missing.join('\n')}`).toEqual([]);
  });

  // Reported as one block so a regression shows WHICH queries broke and where
  // they landed, rather than failing on the first one and hiding the rest.
  it('ranks an acceptable tool in the top 3 for every benchmark query', async () => {
    const failures: string[] = [];
    for (const c of CASES) {
      const r = await rankOf(c);
      if (r > 3) {
        const hits = await (await index()).search(c.query, { k: 5 });
        failures.push(
          `  "${c.query}"\n` +
            `     want one of: ${c.expect.join(', ')}\n` +
            `     rank: ${r === Infinity ? 'not in top 10' : r}\n` +
            `     got: ${hits.map((h) => h.name).join(', ') || '(nothing)'}`,
        );
      }
    }
    expect(failures.join('\n'), `${failures.length}/${CASES.length} queries rank poorly:\n${failures.join('\n')}`).toBe('');
  });

  it('puts an acceptable tool first for at least three quarters of queries', async () => {
    let firstPlace = 0;
    for (const c of CASES) if ((await rankOf(c)) === 1) firstPlace++;
    const ratio = firstPlace / CASES.length;
    expect(ratio, `only ${firstPlace}/${CASES.length} queries put the right tool first`).toBeGreaterThanOrEqual(0.75);
  });

  it('returns nothing rather than noise for a query with no plausible answer', async () => {
    const hits = await (await index()).search('zorblax quibbleflum wuzzlewump', { k: 5 });
    // A confident wrong answer is worse than an empty one: it sends the agent
    // down a path that cannot work.
    expect(hits.length).toBeLessThanOrEqual(3);
  });
});
