// mcp-tools/hayba-mcp/src/recipes/runtime.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { ExecutorRegistry } from './registry.js';
import { RecipeRuntime } from './runtime.js';
import type { RecipeSpec, RecipeExecutor } from './types.js';

function makeSpec(id: string, kind: string, extra: Partial<RecipeSpec> = {}): RecipeSpec {
  return {
    id,
    version: '1.0.0',
    category: 'test',
    title: id,
    description: '',
    author: 'test',
    params: [],
    executor: { kind },
    determinism: { pure: true, declared_outputs: ['v'], side_effects: [], reads: [], seed_param: null },
    ...extra,
  };
}

describe('RecipeRuntime.runRecipe', () => {
  let registry: ExecutorRegistry;
  let runtime: RecipeRuntime;
  let specs: Map<string, RecipeSpec>;

  beforeEach(() => {
    registry = new ExecutorRegistry();
    specs = new Map();
    runtime = new RecipeRuntime({
      registry,
      getSpec: (id) => specs.get(id),
      maxDepth: 8,
    });
  });

  it('returns the executor output and durationMs', async () => {
    specs.set('com.t.a', makeSpec('com.t.a', 'k.a'));
    registry.register('k.a', async () => ({ v: 42 }));
    const r = await runtime.runRecipe('com.t.a', {});
    expect(r.ok).toBe(true);
    expect(r.outputs).toEqual({ v: 42 });
    expect(r.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('returns RecipeNotFoundError shape when spec is missing', async () => {
    const r = await runtime.runRecipe('com.t.missing', {});
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/com\.t\.missing/);
  });

  it('returns error when executor.kind is not registered', async () => {
    specs.set('com.t.x', makeSpec('com.t.x', 'k.unregistered'));
    const r = await runtime.runRecipe('com.t.x', {});
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/k\.unregistered/);
  });

  it('validates params against the spec', async () => {
    specs.set('com.t.p', makeSpec('com.t.p', 'k.p', {
      params: [{ id: 'x', type: 'float', range: [0, 1] }],
    }));
    registry.register('k.p', async () => ({}));
    const r = await runtime.runRecipe('com.t.p', { x: 5 });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/out of range/);
  });

  it('aggregates declared side_effects into the result', async () => {
    specs.set('com.t.s', makeSpec('com.t.s', 'k.s', {
      determinism: { pure: false, declared_outputs: [], side_effects: ['lighting_change'], reads: [], seed_param: null },
    }));
    registry.register('k.s', async () => ({}));
    const r = await runtime.runRecipe('com.t.s', {});
    expect(r.side_effects).toEqual(['lighting_change']);
  });

  it('detects direct cycles (recipe calls itself)', async () => {
    specs.set('com.t.cyc', makeSpec('com.t.cyc', 'k.cyc'));
    const exec: RecipeExecutor = async (_p, ctx) => {
      await ctx.runRecipe('com.t.cyc', {});
      return {};
    };
    registry.register('k.cyc', exec);
    const r = await runtime.runRecipe('com.t.cyc', {});
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/cycle/i);
  });

  it('detects indirect cycles (a → b → a)', async () => {
    specs.set('com.t.a', makeSpec('com.t.a', 'k.a'));
    specs.set('com.t.b', makeSpec('com.t.b', 'k.b'));
    registry.register('k.a', async (_p, ctx) => { await ctx.runRecipe('com.t.b', {}); return {}; });
    registry.register('k.b', async (_p, ctx) => { await ctx.runRecipe('com.t.a', {}); return {}; });
    const r = await runtime.runRecipe('com.t.a', {});
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/cycle/i);
  });

  it('enforces maxDepth', async () => {
    const small = new RecipeRuntime({ registry, getSpec: (id) => specs.get(id), maxDepth: 2 });
    specs.set('com.t.deep', makeSpec('com.t.deep', 'k.deep'));
    let i = 0;
    registry.register('k.deep', async (_p, ctx) => {
      if (i++ < 5) await ctx.runRecipe('com.t.deep2', {});
      return {};
    });
    specs.set('com.t.deep2', makeSpec('com.t.deep2', 'k.deep2'));
    registry.register('k.deep2', async (_p, ctx) => {
      if (i++ < 5) await ctx.runRecipe('com.t.deep', {});
      return {};
    });
    const r = await small.runRecipe('com.t.deep', {});
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/depth/i);
  });

  it('allows the same recipe to be called sequentially (no false cycle)', async () => {
    specs.set('com.t.leaf', makeSpec('com.t.leaf', 'k.leaf'));
    specs.set('com.t.par',  makeSpec('com.t.par',  'k.par'));
    registry.register('k.leaf', async () => ({ v: 1 }));
    registry.register('k.par', async (_p, ctx) => {
      const a = await ctx.runRecipe('com.t.leaf', {});
      const b = await ctx.runRecipe('com.t.leaf', {});
      return { a: a.outputs.v, b: b.outputs.v };
    });
    const r = await runtime.runRecipe('com.t.par', {});
    expect(r.ok).toBe(true);
    expect(r.outputs).toEqual({ a: 1, b: 1 });
  });

  it('fires onRun once per root run with id, params, writes, and ok', async () => {
    const calls: Array<{ id: string; ok: boolean; writes: string[] }> = [];
    specs.set('com.t.a', makeSpec('com.t.a', 'k.a'));
    registry.register('k.a', async () => ({ v: 42 }));
    const rt = new RecipeRuntime({
      registry,
      getSpec: (id) => specs.get(id),
      maxDepth: 8,
      onRun: (info) => calls.push({ id: info.recipeId, ok: info.ok, writes: info.writes }),
    });
    await rt.runRecipe('com.t.a', {});
    expect(calls).toHaveLength(1);
    expect(calls[0].id).toBe('com.t.a');
    expect(calls[0].ok).toBe(true);
  });

  it('aggregates side_effects across the call tree (parent + child) and dedupes', async () => {
    specs.set('com.t.parent', makeSpec('com.t.parent', 'k.parent', {
      determinism: { pure: false, declared_outputs: [], side_effects: ['actor_spawn'], reads: [], seed_param: null },
    }));
    specs.set('com.t.child', makeSpec('com.t.child', 'k.child', {
      determinism: { pure: false, declared_outputs: [], side_effects: ['lighting_change', 'actor_spawn'], reads: [], seed_param: null },
    }));
    registry.register('k.parent', async (_p, ctx) => { await ctx.runRecipe('com.t.child', {}); return {}; });
    registry.register('k.child', async () => ({}));

    const r = await runtime.runRecipe('com.t.parent', {});
    expect(r.ok).toBe(true);
    expect(r.side_effects).toEqual(['actor_spawn', 'lighting_change']);
    // 'actor_spawn' appears in both parent and child — should appear once, in first-seen order
  });
});

describe('a run returns its own verdict', () => {
  let registry: ExecutorRegistry;
  let runtime: RecipeRuntime;
  let specs: Map<string, RecipeSpec>;

  // A requirement that is trivially satisfiable or violable depending on where
  // the instance sits, so the verdict can be steered from the test.
  const withRequires = (id: string): RecipeSpec =>
    makeSpec(id, 'k.place', {
      requires: [{
        primitive: 'clearance',
        params: { min_m: 1 },
        binding: { asset: '/Game/Test/SM_Thing.SM_Thing' },
        hard: true,
      }],
    });

  const instance = (x: number) => ({
    object: `Thing_${x}`,
    asset: '/Game/Test/SM_Thing.SM_Thing',
    transform: { pos: [x, 0, 0] as [number, number, number], quat: [0, 0, 0, 1] as [number, number, number, number], scale: [1, 1, 1] as [number, number, number] },
  });

  beforeEach(() => {
    registry = new ExecutorRegistry();
    specs = new Map();
    runtime = new RecipeRuntime({ registry, getSpec: (id) => specs.get(id), maxDepth: 8 });
  });

  it('says nothing when there is nothing to judge', async () => {
    specs.set('com.t.plain', makeSpec('com.t.plain', 'k.plain'));
    registry.register('k.plain', async () => ({ v: 1 }));

    const r = await runtime.runRecipe('com.t.plain', {});

    // No declared requirements and no bound constraints: a verdict here would
    // be noise, not reassurance.
    expect(r.verdict).toBeUndefined();
  });

  it('judges what the executor reported, without being asked', async () => {
    specs.set('com.t.place', withRequires('com.t.place'));
    registry.register('k.place', async (_p, ctx) => {
      ctx.placed([instance(0), instance(10)]);
      return { v: 1 };
    });

    const r = await runtime.runRecipe('com.t.place', {});

    // The whole point: the answer arrives with the edit. Nobody navigated to
    // a Rules panel to ask for it.
    expect(r.ok).toBe(true);
    expect(r.verdict?.checked).toBe(true);
    // Not merely present: the clearance constraint actually ran against both
    // instances. An empty gate list would mean the verdict judged nothing.
    const ran = r.verdict?.plumb?.gates.flatMap(g => g.constraints) ?? [];
    expect(ran.map(c => c.primitive)).toContain('clearance');
  });

  it('refuses to call an unchecked run a clean one', async () => {
    specs.set('com.t.place', withRequires('com.t.place'));
    // An executor that declares requirements but reports nothing has checked
    // nothing. Reporting `ok` here would be the exact lie the validator
    // refuses to tell when a geometry rule has no geometry.
    registry.register('k.place', async () => ({ v: 1 }));

    const r = await runtime.runRecipe('com.t.place', {});

    expect(r.ok).toBe(true);
    expect(r.verdict?.checked).toBe(false);
    expect(r.verdict?.plumb).toBeUndefined();
    expect(r.verdict?.reason).toMatch(/reported no instances/);
  });

  it('judges instances a child recipe placed', async () => {
    specs.set('com.t.parent', makeSpec('com.t.parent', 'k.parent', {
      requires: withRequires('x').requires,
    }));
    specs.set('com.t.child', makeSpec('com.t.child', 'k.place'));
    registry.register('k.parent', async (_p, ctx) => {
      await ctx.runRecipe('com.t.child', {});
      return { v: 1 };
    });
    registry.register('k.place', async (_p, ctx) => {
      ctx.placed([instance(0)]);
      return { v: 1 };
    });

    const r = await runtime.runRecipe('com.t.parent', {});

    // Delegating placement to a child must not lose the judgement -- otherwise
    // a recipe could dodge its own requirements by wrapping another one.
    expect(r.verdict?.checked).toBe(true);
  });

  // NOTE: `judge()` catches a throwing evaluator and reports checked:false.
  // That path has no test, deliberately -- PLUMB proved defensive enough that
  // no input I could construct actually makes it throw, and a test that cannot
  // fail for the reason it names is worse than an acknowledged gap.
});
