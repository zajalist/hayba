/**
 * A production project, 2026-11-12: pcg_create_graph always wrote /Game/Hayba/Generated/<name>, and running it again
 * renamed the existing graph into the transient package, so subgraph nodes in other graphs and PCG components kept
 * pointing at a dead copy. Pins the fix: path picks the content folder and is validated before anything is created;
 * an existing PCG graph is rebuilt in place (same object), an existing non-graph asset is refused; the reply says
 * which happened.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import { setDefaultSender, type Sender } from '../tool-executor.js';
import { STATIC_TOOL_CATALOGUE } from '../index.js';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(
  join(
    here,
    '..',
    '..',
    '..',
    '..',
    '..',
    'unreal',
    'HaybaMCPToolkit',
    'Source',
    'HaybaMCPToolkit',
    'Private',
    'handlers',
    'HaybaMCPLegacyHandler.cpp',
  ),
  'utf8',
).replace(/\r\n/g, '\n');
const start = src.indexOf('FHaybaHandlerResult FHaybaMCPLegacyHandler::Cmd_CreateGraph(');
const body = src.slice(start, src.indexOf('\n}\n', start));
const sidecar = JSON.parse(readFileSync(join(here, '..', '..', 'legacy-commands', 'sidecar.json'), 'utf8')) as {
  commands: Record<string, { params: Array<{ name: string; required: boolean; default?: unknown }> }>;
};

describe('pcg_create_graph path', () => {
  it('defaults to the old folder and validates the path before creating anything', () => {
    expect(body).toContain('FString PackagePath = TEXT("/Game/Hayba/Generated");');
    expect(body).toContain('Params->TryGetStringField(TEXT("path"), PackagePath);');
    const check = body.indexOf('FPackageName::IsValidLongPackageName(FullPath');
    expect(check).toBeGreaterThan(-1);
    expect(check).toBeLessThan(body.indexOf('CreatePackage('));
    expect(body).toContain('is not a writable content folder');
  });

  it('is declared on both sidecar names', () => {
    for (const name of ['create_graph', 'pcg_create_graph']) {
      expect(sidecar.commands[name].params).toContainEqual(
        expect.objectContaining({ name: 'path', required: false, default: '/Game/Hayba/Generated' }),
      );
    }
  });
});

describe('an existing graph is rebuilt in place', () => {
  it('never moves the existing object into the transient package', () => {
    expect(body).not.toContain('GetTransientPackage()');
    expect(body).not.toContain('->Rename(');
  });

  it('reuses an existing PCG graph and clears its nodes and any Input-to-Output edge', () => {
    expect(body).toContain('UPCGGraph* NewGraph = Cast<UPCGGraph>(Existing);');
    expect(body).toContain('NewGraph->RemoveNodes(OldNodes);');
    expect(body).toContain('if (Pin) Pin->BreakAllEdges();');
  });

  it('refuses an existing asset that is not a PCG graph before changing anything', () => {
    const refusal = body.indexOf('not a PCG graph. Nothing was changed.');
    expect(refusal).toBeGreaterThan(-1);
    expect(refusal).toBeLessThan(body.indexOf('RemoveNodes('));
  });

  it('registers only a new asset and reports which happened', () => {
    expect(body).toContain('if (!bRebuiltInPlace) FAssetRegistryModule::AssetCreated(NewGraph);');
    expect(body).toContain('Data->SetBoolField(TEXT("rebuiltInPlace"), bRebuiltInPlace);');
  });
});

describe('hayba_create_pcg_graph', () => {
  const calls: Array<{ cmd: string; params: Record<string, unknown> }> = [];
  beforeEach(() => {
    calls.length = 0;
    setDefaultSender((async (cmd: string, params: Record<string, unknown>) => {
      calls.push({ cmd, params });
      return { id: 'inmem', ok: true, data: { created: true } };
    }) as Sender);
  });
  const tool = () => STATIC_TOOL_CATALOGUE.find((d) => d.name === 'hayba_create_pcg_graph')!;

  it('forwards path, and leaves it out when not given', async () => {
    const graph = JSON.stringify({ nodes: [], edges: [] });
    await tool().handler({ graph, name: 'G', path: '/Game/Env/PCG' }, undefined as never);
    await tool().handler({ graph, name: 'G' }, undefined as never);
    expect(calls).toEqual([
      { cmd: 'create_graph', params: { graph: { nodes: [], edges: [] }, name: 'G', path: '/Game/Env/PCG' } },
      { cmd: 'create_graph', params: { graph: { nodes: [], edges: [] }, name: 'G' } },
    ]);
  });
});
