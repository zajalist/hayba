import { afterEach, describe, expect, it } from 'vitest';
import { NON_IDEMPOTENT } from '../tool-executor.js';
import { scriptedUe, type ScriptedUe } from '../testing/scripted-ue.js';
import { assetRegistryQueryHandler, meta, schema } from './asset-registry-query.js';

let ue: ScriptedUe | undefined;
afterEach(() => {
  ue?.restore();
  ue = undefined;
});

describe('asset_registry_query native wrapper', () => {
  it('uses native dispatch, applies defaults, and never invokes Python', async () => {
    ue = scriptedUe().replies('asset_registry_query', {
      ok: true,
      assets: [],
      total: 0,
      has_more: false,
      next_offset: 0,
    });
    const result = await assetRegistryQueryHandler({ path_prefix: '/Game/Meshes' }, {} as never);
    expect(result.isError).toBeUndefined();
    expect(ue.paramsFor('asset_registry_query')).toEqual({
      path_prefix: '/Game/Meshes',
      recursive: true,
      limit: 50,
      offset: 0,
    });
    expect(ue.called('python_run')).toBe(false);
    expect(JSON.stringify(ue.calls)).not.toContain('getattr(');
  });

  it('forwards all filters and paging fields', async () => {
    ue = scriptedUe().replies('asset_registry_query', {
      ok: true,
      assets: [{ name: 'SM_Rock', path: '/Game/Meshes/SM_Rock', class: 'StaticMesh' }],
      total: 12,
      has_more: true,
      next_offset: 6,
    });
    const result = await assetRegistryQueryHandler(
      {
        class_filter: 'StaticMesh',
        name_contains: 'rock',
        path_prefix: '/Game/Meshes',
        recursive: false,
        limit: 1,
        offset: 5,
      },
      {} as never,
    );
    expect(result.isError).toBeUndefined();
    expect(ue.paramsFor('asset_registry_query')).toMatchObject({
      class_filter: 'StaticMesh',
      name_contains: 'rock',
      recursive: false,
      limit: 1,
      offset: 5,
    });
  });

  it.each([
    { limit: 0 },
    { limit: 501 },
    { limit: 1.5 },
    { offset: -1 },
    { offset: 2.5 },
    { path_prefix: 'Game/Meshes' },
    { path_prefix: '/Game/Foo.Bar' },
    { class_filter: '' },
    { name_contains: '   ' },
    { recursive: 'true' },
  ])('rejects invalid input before transport: %j', async (input) => {
    ue = scriptedUe();
    const result = await assetRegistryQueryHandler(input, {} as never);
    expect(result.isError).toBe(true);
    expect(ue.called('asset_registry_query')).toBe(false);
  });

  it.each([
    {},
    { ok: true, assets: [], total: 0, has_more: true, next_offset: 0 },
    { ok: true, assets: [], total: 2_147_483_648, has_more: false, next_offset: 2_147_483_648 },
    { ok: true, assets: [{ name: 'A', path: '/Game/A' }], total: 1, has_more: false, next_offset: 1 },
    {
      ok: true,
      assets: new Array(3).fill({ name: 'A', path: '/Game/A', class: 'X' }),
      total: 3,
      has_more: false,
      next_offset: 3,
    },
  ])('fails closed on false-green native response: %j', async (reply) => {
    ue = scriptedUe().replies('asset_registry_query', reply);
    const result = await assetRegistryQueryHandler({ limit: 2 }, {} as never);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('contract validation');
  });

  it.each([
    {
      args: { limit: 2 },
      reply: { ok: true, assets: [], total: 12, has_more: false, next_offset: 12 },
    },
    {
      args: { class_filter: 'StaticMesh' },
      reply: {
        ok: true,
        assets: [{ name: 'M_Rock', path: '/Game/M_Rock', class: 'Material' }],
        total: 1,
        has_more: false,
        next_offset: 1,
      },
    },
    {
      args: { name_contains: 'rock' },
      reply: {
        ok: true,
        assets: [{ name: 'SM_Tree', path: '/Game/SM_Tree', class: 'StaticMesh' }],
        total: 1,
        has_more: false,
        next_offset: 1,
      },
    },
    {
      args: { path_prefix: '/Game/Meshes', recursive: false },
      reply: {
        ok: true,
        assets: [{ name: 'SM_Rock', path: '/Game/Meshes/Sub/SM_Rock', class: 'StaticMesh' }],
        total: 1,
        has_more: false,
        next_offset: 1,
      },
    },
    {
      args: { limit: 2 },
      reply: {
        ok: true,
        assets: [
          { name: 'B', path: '/Game/B', class: 'StaticMesh' },
          { name: 'A', path: '/Game/A', class: 'StaticMesh' },
        ],
        total: 2,
        has_more: false,
        next_offset: 2,
      },
    },
    {
      args: {},
      reply: {
        ok: true,
        assets: [{ name: '', path: 'not-a-package', class: 'StaticMesh' }],
        total: 1,
        has_more: false,
        next_offset: 1,
      },
    },
    {
      args: {},
      reply: {
        ok: true,
        assets: [{ name: 'Bar', path: '/Game/Foo', class: 'StaticMesh' }],
        total: 1,
        has_more: false,
        next_offset: 1,
      },
    },
  ])('rejects skipped, filter-violating, or unstable pages: $reply', async ({ args, reply }) => {
    ue = scriptedUe().replies('asset_registry_query', reply);
    const result = await assetRegistryQueryHandler(args, {} as never);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('contract validation');
  });

  it('surfaces native refusal without Python fallback', async () => {
    ue = scriptedUe().fails('asset_registry_query', 'AssetRegistry is still discovering assets');
    const result = await assetRegistryQueryHandler({}, {} as never);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('still discovering assets');
    expect(ue.called('python_run')).toBe(false);
  });

  it('is explicitly read-only and retry-safe', () => {
    expect(meta.effects).toEqual([]);
    expect(NON_IDEMPOTENT.has('asset_registry_query')).toBe(false);
    expect(schema.safeParse({}).success).toBe(true);
  });
});
