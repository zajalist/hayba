import { afterEach, describe, expect, it } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { STATIC_TOOL_CATALOGUE, captureStaticToolCatalogue } from '../index.js';
import { registerTool } from '../register-tool.js';
import { scriptedUe, type ScriptedUe } from '../testing/scripted-ue.js';
import { WorkflowResultSchema } from '../workflows/contracts.js';
import { worldIngestDescriptor } from './world-ingest.js';
import { normalizeWorldFacts } from './world-inspect.js';

let ue: ScriptedUe | undefined;
afterEach(() => { ue?.restore(); ue = undefined; });
const request = { source: { kind: 'heightmap', path: 'D:/terrain.r16' }, destination: { mode: 'open_world' }, partition: { mode: 'preserve' } };
const world = {
  world: { type: 'Editor', package: '/Game/Maps/World', current_level: '/Game/Maps/Sub',
    landscape_scope: 'loaded_actors', source_control_scope: 'cached_provider_availability',
    save_readiness_scope: 'current_level_existing_writable_map_file_only; external_actor_packages_and_checkout_not_checked' },
  landscape: [], partition: { enabled: false, runtime_grids: [], enumeration_scope: 'loaded_actors' }, data_layers: [],
  hlod: { layers: [], enumeration_scope: 'loaded_actors_and_world_default' },
  capabilities: { world_partition: true, hlod: true, web_browser: false, web_browser_scope: 'module_loaded' }, save_ready: true,
};
const landscape = { path: '/Game/Maps/Sub.Sub:PersistentLevel.Landscape_1', package: '/Game/Maps/Sub' };

function importable(options: { actor?: Record<string, unknown>; saved?: Record<string, unknown>; saveReady?: boolean; partitioned?: boolean } = {}) {
  let imported = false;
  ue = scriptedUe().replies('world_inspect', () => ({ ...world,
    save_ready: options.saveReady ?? true, partition: { ...world.partition, enabled: options.partitioned ?? false },
    landscape: imported ? [options.actor ?? landscape] : [],
  })).replies('landscape_import', () => { imported = true; return {}; })
    .replies('level_save', options.saved ?? { path: '/Game/Maps/Sub', saved: true, verified: true, dirty: false });
}
async function ingest() {
  const response = await worldIngestDescriptor.handler(request, {});
  return { response, result: WorkflowResultSchema.parse(JSON.parse(response.content.find((b) => b.type === 'text')!.text)) };
}

describe('world final-review regressions', () => {
  it('preserves separate world/current-level identities and native scope qualifiers', () => {
    expect(normalizeWorldFacts(world).facts).toMatchObject({ worldPackage: '/Game/Maps/World', currentLevel: '/Game/Maps/Sub',
      scopes: { landscape: 'loaded_actors', partition: 'loaded_actors', hlod: 'loaded_actors_and_world_default',
        sourceControl: 'cached_provider_availability', webBrowser: 'module_loaded', saveReadiness: world.world.save_readiness_scope } });
  });

  it('saves the actual current level package when it differs from the world package', async () => {
    importable();
    const { result } = await ingest();
    expect(result.ok).toBe(true);
    expect(ue!.paramsFor('level_save')).toEqual({ path: '/Game/Maps/Sub' });
  });

  it.each([
    { path: '/Game/Maps/World', saved: true, verified: true, dirty: false },
    { saved: true, verified: true, dirty: false },
    { path: '/Game/Maps/Sub', saved: true },
    { path: '/Game/Maps/Sub', saved: true, verified: true, dirty: true },
  ])('refuses a save without verified persistence of the affected package: %j', async (saved) => {
    importable({ saved });
    const { result } = await ingest();
    expect(result.ok).toBe(false);
    expect(result.stages.at(-1)).toMatchObject({ stage: 'saveVerify', status: 'failed' });
    expect(result.affectedResources).toHaveLength(1);
  });

  it.each([undefined, '/Game/Maps/Other'])('never saves an unrelated package when an imported actor package is %s', async (actorPackage) => {
    importable({ actor: { ...landscape, package: actorPackage } });
    const { result } = await ingest();
    expect(result.stages.at(-1)).toMatchObject({ status: 'unsupported', code: 'affected_package_persistence_unavailable' });
    expect(ue!.called('level_save')).toBe(false);
  });

  it('blocks partitioned ingest in preflight before the importer runs', async () => {
    importable({ partitioned: true });
    const { result } = await ingest();
    expect(result.stages.at(-1)).toMatchObject({ stage: 'normalize', code: 'external_actor_persistence_unavailable' });
    expect(ue!.calls.map((c) => c.cmd)).toEqual(['world_inspect']);
  });

  it('blocks empty world identity before mutation even when save_ready is true', async () => {
    ue = scriptedUe().replies('world_inspect', { ...world, world: {} });
    const { result } = await ingest();
    expect(result.ok).toBe(false);
    expect(result.stages.at(-1)).toMatchObject({ stage: 'inspect', code: 'world_inspect_malformed' });
    expect(ue.calls.map((c) => c.cmd)).toEqual(['world_inspect']);
  });

  it.each(['landscape_import', 'level_save'])('preserves an approval-required native %s outcome without ordinary failure', async (command) => {
    importable();
    ue!.replies(command, { status: 'plan_mode_required' });
    const { result, response } = await ingest();
    expect(result.ok).toBe(false);
    expect(response.isError).toBe(false);
    expect(result.stages.at(-1)).toMatchObject({ status: 'pending', code: 'plan_mode_required' });
    expect(result.stages.some((s) => s.status === 'failed')).toBe(false);
    if (command === 'landscape_import') expect(ue!.called('level_save')).toBe(false);
    else expect(result.affectedResources).toHaveLength(1);
  });

  it.each(['hayba_import_landscape', 'import_landscape'])('keeps %s import-only on an unsaved partitioned map', async (name) => {
    importable({ saveReady: false, partitioned: true });
    const tool = STATIC_TOOL_CATALOGUE.find((d) => d.name === name)!;
    const response = await tool.handler({ heightmapPath: 'D:/terrain.r16' }, {});
    const result = JSON.parse(response.content.find((b) => b.type === 'text')!.text);
    expect(result.ok).toBe(true);
    expect(result.stages.find((s: { stage: string }) => s.stage === 'saveVerify')).toMatchObject({ status: 'skipped', code: 'legacy_import_only' });
    expect(ue!.called('level_save')).toBe(false);
  });

  it('extends the single public asset_inspect with actual native evidence and policy decisions', async () => {
    const path = '/Game/Mesh';
    ue = scriptedUe().replies('python_run', { stdout: `HAYBA_JSON:${JSON.stringify({ ok: true, asset_path: path, class: 'StaticMesh' })}` })
      .replies('mesh_get_info', { path, lod_count: 2, lod_screen_sizes: [1, 0.5] });
    const tools = STATIC_TOOL_CATALOGUE.filter((d) => d.name === 'asset_inspect');
    expect(tools).toHaveLength(1);
    const response = await tools[0]!.handler({ asset_path: path, preparation_policy: { intent: 'environment', nanite: 'auto' } }, {});
    const result = JSON.parse(response.content.find((b) => b.type === 'text')!.text);
    expect(result).toMatchObject({ ok: true, asset_path: path, class: 'StaticMesh', preparation: {
      evidence: { naniteSupport: null, foliage: null, deformation: null },
    } });
    expect(result.preparation.decisions).toContainEqual(expect.objectContaining({ capability: 'nanite', resolved: 'preserve', code: 'nanite_eligibility_unknown' }));
    expect(ue.called('mesh_set_lod')).toBe(false);
  });

  it('rejects misspelled top-level dryRun at the real eager MCP transport boundary', async () => {
    ue = scriptedUe();
    const server = new McpServer({ name: 'workflow-regression', version: '1' });
    registerTool(server, {}, worldIngestDescriptor);
    const client = new Client({ name: 'regression-client', version: '1' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const response = await client.callTool({ name: 'world_ingest', arguments: { ...request, dryRun: true } });
      expect(response.isError).toBe(true);
      expect(ue.calls).toEqual([]);
    } finally { await client.close(); await server.close(); }
  });

  it('preserves strict validation for the direct handler and deferred catalogue', async () => {
    ue = scriptedUe();
    await expect(worldIngestDescriptor.handler({ ...request, dryRun: true }, {})).rejects.toThrow();
    const captured = captureStaticToolCatalogue({}).get('world_ingest')!;
    expect(captured.inputSchema?.safeParse({ ...request, dryRun: true }).success).toBe(false);
    await expect(captured.handler({ ...request, dryRun: true })).rejects.toThrow();
    expect(ue.calls).toEqual([]);
  });
});
