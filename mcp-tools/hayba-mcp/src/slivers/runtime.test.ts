// mcp-tools/hayba-mcp/src/slivers/runtime.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { ExecutorRegistry } from './registry.js';
import { SliverRuntime } from './runtime.js';
import type { SliverSpec, SliverExecutor } from './types.js';

function makeSpec(id: string, kind: string, extra: Partial<SliverSpec> = {}): SliverSpec {
  return {
    id,
    version: '1.0.0',
    category: 'test',
    title: id,
    description: '',
    author: 'test',
    params: [],
    executor: { kind },
    determinism: { pure: true, declared_outputs: ['v'], side_effects: [], seed_param: null },
    ...extra,
  };
}

describe('SliverRuntime.runSliver', () => {
  let registry: ExecutorRegistry;
  let runtime: SliverRuntime;
  let specs: Map<string, SliverSpec>;

  beforeEach(() => {
    registry = new ExecutorRegistry();
    specs = new Map();
    runtime = new SliverRuntime({
      registry,
      getSpec: (id) => specs.get(id),
      maxDepth: 8,
    });
  });

  it('returns the executor output and durationMs', async () => {
    specs.set('com.t.a', makeSpec('com.t.a', 'k.a'));
    registry.register('k.a', async () => ({ v: 42 }));
    const r = await runtime.runSliver('com.t.a', {});
    expect(r.ok).toBe(true);
    expect(r.outputs).toEqual({ v: 42 });
    expect(r.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('returns SliverNotFoundError shape when spec is missing', async () => {
    const r = await runtime.runSliver('com.t.missing', {});
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/com\.t\.missing/);
  });

  it('returns error when executor.kind is not registered', async () => {
    specs.set('com.t.x', makeSpec('com.t.x', 'k.unregistered'));
    const r = await runtime.runSliver('com.t.x', {});
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/k\.unregistered/);
  });

  it('validates params against the spec', async () => {
    specs.set('com.t.p', makeSpec('com.t.p', 'k.p', {
      params: [{ id: 'x', type: 'float', range: [0, 1] }],
    }));
    registry.register('k.p', async () => ({}));
    const r = await runtime.runSliver('com.t.p', { x: 5 });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/out of range/);
  });

  it('aggregates declared side_effects into the result', async () => {
    specs.set('com.t.s', makeSpec('com.t.s', 'k.s', {
      determinism: { pure: false, declared_outputs: [], side_effects: ['lighting_change'], seed_param: null },
    }));
    registry.register('k.s', async () => ({}));
    const r = await runtime.runSliver('com.t.s', {});
    expect(r.side_effects).toEqual(['lighting_change']);
  });

  it('detects direct cycles (sliver calls itself)', async () => {
    specs.set('com.t.cyc', makeSpec('com.t.cyc', 'k.cyc'));
    const exec: SliverExecutor = async (_p, ctx) => {
      await ctx.runSliver('com.t.cyc', {});
      return {};
    };
    registry.register('k.cyc', exec);
    const r = await runtime.runSliver('com.t.cyc', {});
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/cycle/i);
  });

  it('detects indirect cycles (a → b → a)', async () => {
    specs.set('com.t.a', makeSpec('com.t.a', 'k.a'));
    specs.set('com.t.b', makeSpec('com.t.b', 'k.b'));
    registry.register('k.a', async (_p, ctx) => { await ctx.runSliver('com.t.b', {}); return {}; });
    registry.register('k.b', async (_p, ctx) => { await ctx.runSliver('com.t.a', {}); return {}; });
    const r = await runtime.runSliver('com.t.a', {});
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/cycle/i);
  });

  it('enforces maxDepth', async () => {
    const small = new SliverRuntime({ registry, getSpec: (id) => specs.get(id), maxDepth: 2 });
    specs.set('com.t.deep', makeSpec('com.t.deep', 'k.deep'));
    let i = 0;
    registry.register('k.deep', async (_p, ctx) => {
      if (i++ < 5) await ctx.runSliver('com.t.deep2', {});
      return {};
    });
    specs.set('com.t.deep2', makeSpec('com.t.deep2', 'k.deep2'));
    registry.register('k.deep2', async (_p, ctx) => {
      if (i++ < 5) await ctx.runSliver('com.t.deep', {});
      return {};
    });
    const r = await small.runSliver('com.t.deep', {});
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/depth/i);
  });

  it('allows the same sliver to be called sequentially (no false cycle)', async () => {
    specs.set('com.t.leaf', makeSpec('com.t.leaf', 'k.leaf'));
    specs.set('com.t.par',  makeSpec('com.t.par',  'k.par'));
    registry.register('k.leaf', async () => ({ v: 1 }));
    registry.register('k.par', async (_p, ctx) => {
      const a = await ctx.runSliver('com.t.leaf', {});
      const b = await ctx.runSliver('com.t.leaf', {});
      return { a: a.outputs.v, b: b.outputs.v };
    });
    const r = await runtime.runSliver('com.t.par', {});
    expect(r.ok).toBe(true);
    expect(r.outputs).toEqual({ a: 1, b: 1 });
  });
});
