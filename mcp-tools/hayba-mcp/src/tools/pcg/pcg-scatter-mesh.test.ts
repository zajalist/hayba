import { describe, it, expect, vi, beforeEach } from 'vitest';

const runUePythonJsonMock = vi.fn();
const executeCommandMock = vi.fn();

vi.mock('../ue-python.js', () => ({
  runUePythonJson: (...args: unknown[]) => runUePythonJsonMock(...(args as [])),
  pyStr: (s: string) => JSON.stringify(s),
}));
vi.mock('../tool-executor.js', () => ({
  executeCommand: (...args: unknown[]) => executeCommandMock(...(args as [])),
}));

import { pcgScatterMeshHandler } from './pcg-scatter-mesh.js';

const baseParams = {
  area_or_landscape: '/Game/Maps/Demo.Landscape_0',
  mesh: '/Game/Foliage/SM_Pine',
  density: 0.5,
  scale_min: 0.9,
  scale_max: 1.3,
  yaw_jitter: 180,
  seed: 1337,
};

/** Route executeCommand by command name; capture the create_graph payload. */
function wireExecuteCommand(captured: { graph?: unknown }) {
  executeCommandMock.mockImplementation(async (cmd: string, params: Record<string, unknown>) => {
    if (cmd === 'create_graph') {
      captured.graph = params.graph;
      return { created: true, assetPath: '/Game/Hayba/Generated/G' };
    }
    if (cmd === 'wait_for_idle') return { settled: true };
    return {};
  });
}

describe('pcg_scatter_mesh', () => {
  beforeEach(() => {
    runUePythonJsonMock.mockReset();
    executeCommandMock.mockReset();
  });

  it('runs the full flow and returns instances on a good cook', async () => {
    const captured: { graph?: unknown } = {};
    wireExecuteCommand(captured);
    runUePythonJsonMock
      .mockResolvedValueOnce({ ok: true, volume_actor: '/Game/Maps/Demo.PCGVolume_0' }) // spawn+generate
      .mockResolvedValueOnce({ ok: true, total: 87, ism: [{ mesh: '/Game/Foliage/SM_Pine', count: 87 }] }); // inspect

    const r = await pcgScatterMeshHandler(baseParams);
    expect(r.isError).toBeFalsy();
    const out = JSON.parse(r.content[0].text);
    expect(out.ok).toBe(true);
    expect(out.graph_asset).toBe('/Game/Hayba/Generated/G');
    expect(out.volume_actor).toBe('/Game/Maps/Demo.PCGVolume_0');
    expect(out.instances).toBe(87);

    // The created graph carries the jitter transform node + bound mesh.
    const g = captured.graph as { nodes: Array<{ id: string; class: string; properties: Record<string, unknown> }>; edges: unknown[] };
    const transform = g.nodes.find(n => n.id === 'transform')!;
    expect(transform.class).toBe('PCGTransformPointsSettings');
    expect(transform.properties.RotationMax).toBe('(Pitch=0,Yaw=180,Roll=0)');
    expect(transform.properties.Seed).toBe(1337);
    const spawner = g.nodes.find(n => n.id === 'spawner')!;
    expect(spawner.properties.MeshEntries).toEqual([{ mesh: '/Game/Foliage/SM_Pine', weight: 1 }]);
    expect(g.edges).toContainEqual({ fromNode: 'transform', fromPin: 'Out', toNode: 'spawner', toPin: 'In' });
  });

  it('honours a weighted mesh list', async () => {
    const captured: { graph?: unknown } = {};
    wireExecuteCommand(captured);
    runUePythonJsonMock
      .mockResolvedValueOnce({ ok: true, volume_actor: '/Game/Maps/Demo.PCGVolume_0' })
      .mockResolvedValueOnce({ ok: true, total: 10 });

    const r = await pcgScatterMeshHandler({
      ...baseParams,
      mesh: undefined,
      meshes: [{ mesh: '/Game/A', weight: 3 }, { mesh: '/Game/B', weight: 1 }],
    });
    expect(r.isError).toBeFalsy();
    const g = captured.graph as { nodes: Array<{ id: string; properties: Record<string, unknown> }> };
    const spawner = g.nodes.find(n => n.id === 'spawner')!;
    expect(spawner.properties.MeshEntries).toEqual([
      { mesh: '/Game/A', weight: 3 },
      { mesh: '/Game/B', weight: 1 },
    ]);
  });

  it('hard-fails (ok:false) when the cook produces ZERO instances', async () => {
    wireExecuteCommand({});
    runUePythonJsonMock
      .mockResolvedValueOnce({ ok: true, volume_actor: '/Game/Maps/Demo.PCGVolume_0' })
      .mockResolvedValueOnce({ ok: true, total: 0, ism: [] });

    const r = await pcgScatterMeshHandler(baseParams);
    expect(r.isError).toBe(true);
    const out = JSON.parse(r.content[0].text);
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/0 instances/);
    expect(out.volume_actor).toBe('/Game/Maps/Demo.PCGVolume_0');
  });

  it('treats a missing total as zero and hard-fails', async () => {
    wireExecuteCommand({});
    runUePythonJsonMock
      .mockResolvedValueOnce({ ok: true, volume_actor: '/Game/Maps/Demo.PCGVolume_0' })
      .mockResolvedValueOnce({ ok: true, ism: [] });

    const r = await pcgScatterMeshHandler(baseParams);
    expect(r.isError).toBe(true);
    expect(JSON.parse(r.content[0].text).ok).toBe(false);
  });

  it('surfaces a spawn/generate failure', async () => {
    wireExecuteCommand({});
    runUePythonJsonMock.mockResolvedValueOnce({ ok: false, error: 'failed to spawn PCGVolume' });

    const r = await pcgScatterMeshHandler(baseParams);
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/spawn\/generate failed.*failed to spawn PCGVolume/);
  });

  it('rejects a graph-validation failure from create_graph', async () => {
    executeCommandMock.mockImplementation(async (cmd: string) =>
      cmd === 'create_graph' ? { created: false, errors: [{ detail: 'bad node' }] } : {});
    const r = await pcgScatterMeshHandler(baseParams);
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/validation failed/);
  });

  it('requires a mesh or non-empty meshes list', async () => {
    const r = await pcgScatterMeshHandler({ ...baseParams, mesh: undefined });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/provide `mesh`/);
  });
});
