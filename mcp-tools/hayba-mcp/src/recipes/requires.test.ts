import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { requirementsToConstraints, validateRecipeRequires, checkRecipeRequires } from './requires.js';
import { parseRecipeSpec } from './spec-schema.js';
import {
  bakeProfile, putProfile, upsertConstraint, setProfilesPath, setConstraintsPath,
  type InstanceState,
} from '../plumb/index.js';
import type { RecipeSpec } from './types.js';

const baseSpec: Omit<RecipeSpec, 'requires'> = {
  id: 'com.hayba.scatter.trees',
  version: '1.0.0',
  category: 'scatter',
  title: 'Tree scatter',
  description: 'x',
  author: 'me',
  params: [],
  executor: { kind: 'scatter.trees' },
  determinism: { pure: false, declared_outputs: [], side_effects: ['pcg.graph.create'], reads: [], seed_param: null },
};

function inst(object: string, pos: [number, number, number], asset?: string): InstanceState {
  return { object, asset, transform: { pos, quat: [0, 0, 0, 1], scale: [1, 1, 1] } };
}

describe('recipe requires — schema + conversion', () => {
  it('parses a spec with a requires block', () => {
    const r = parseRecipeSpec({
      ...baseSpec,
      requires: [{ primitive: 'grounded', params: { tolerance_m: 0.05 }, binding: { asset: '/Game/Tree' } }],
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.spec.requires!.length).toBe(1);
  });

  it('derives stable constraint ids from the spec id', () => {
    const spec: RecipeSpec = { ...baseSpec, requires: [
      { primitive: 'grounded', binding: { asset: '/Game/Tree' } },
      { primitive: 'upright', params: { max_deg: 5 }, binding: { asset: '/Game/Tree' } },
    ] };
    const cs = requirementsToConstraints(spec);
    expect(cs.map(c => c.id)).toEqual(['com.hayba.scatter.trees#req0', 'com.hayba.scatter.trees#req1']);
  });

  it('rejects a requirement with an unknown primitive', () => {
    const spec: RecipeSpec = { ...baseSpec, requires: [{ primitive: 'teleport', binding: { asset: '/Game/Tree' } }] };
    const errs = validateRecipeRequires(spec);
    expect(errs.some(e => e.field.startsWith('requires[0].primitive'))).toBe(true);
  });
});

describe('checkRecipeRequires — union of inline + library constraints', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sreq-'));
    setProfilesPath(join(dir, 'p.json'));
    setConstraintsPath(join(dir, 'c.json'));
    putProfile(bakeProfile({ asset_id: '/Game/Tree', origin_cm: [0, 0, 380], extent_cm: [100, 100, 380], pivot_to_base_cm: -380 }, 'now'));
  });
  afterEach(() => { setProfilesPath(null); setConstraintsPath(null); rmSync(dir, { recursive: true, force: true }); });

  it('inline grounded requirement fails for a floating tree', () => {
    const spec: RecipeSpec = { ...baseSpec, requires: [{ primitive: 'grounded', params: { tolerance_m: 0.05 }, binding: { asset: '/Game/Tree' } }] };
    const v = checkRecipeRequires(spec, [inst('t', [0, 0, 5], '/Game/Tree')]);
    expect(v.ok).toBe(false);
    expect(v.stopped_at).toBe('stability');
  });

  it('also enforces a library constraint bound to the same asset', () => {
    // recipe has NO inline requires; library carries the grounded rule.
    upsertConstraint({ id: 'lib_tree_grounded', primitive: 'grounded', params: { tolerance_m: 0.05 }, binding: { asset: '/Game/Tree' } });
    const spec: RecipeSpec = { ...baseSpec };
    const bad = checkRecipeRequires(spec, [inst('t', [0, 0, 5], '/Game/Tree')]);
    expect(bad.ok).toBe(false);
    const good = checkRecipeRequires(spec, [inst('t', [0, 0, 3.8], '/Game/Tree')]);
    expect(good.ok).toBe(true);
  });

  it('passes when both inline and library constraints are satisfied', () => {
    upsertConstraint({ id: 'lib_tree_grounded', primitive: 'grounded', params: { tolerance_m: 0.05 }, binding: { asset: '/Game/Tree' } });
    const spec: RecipeSpec = { ...baseSpec, requires: [{ primitive: 'upright', params: { max_deg: 5 }, binding: { asset: '/Game/Tree' } }] };
    const v = checkRecipeRequires(spec, [inst('t', [0, 0, 3.8], '/Game/Tree')]);
    expect(v.ok).toBe(true);
  });
});
