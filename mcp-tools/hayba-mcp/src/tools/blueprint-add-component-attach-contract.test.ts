/**
 * a production project UI lane, 2026-11-10: blueprint_add_component added every component with SCS->AddNode, i.e. as a ROOT node. The
 * first one became BP_ItemInspect's RootComponent, so its "relative" location acted as a world transform and the item
 * rendered at the world origin. Pins the fix: a scene component attaches under `parent`, else under the existing scene
 * root (SCS root node or the parent class's native root); it is a root only when the Blueprint has none; the reply
 * returns the hierarchy.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import { setDefaultSender, type Sender } from './tool-executor.js';
import { STATIC_TOOL_CATALOGUE } from './index.js';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, '..', '..', '..', '..', 'unreal', 'HaybaMCPToolkit', 'Source', 'HaybaMCPToolkit',
  'Private', 'handlers', 'HaybaMCPBlueprintHandler.cpp'), 'utf8').replace(/\r\n/g, '\n').replace(/\/\/.*$/gm, '');
const fn = (name: string) => src.slice(src.indexOf(name), src.indexOf('\n}\n', src.indexOf(name)));
const body = fn('FHaybaHandlerResult FHaybaMCPBlueprintHandler::AddComponent(');

describe('blueprint_add_component attaches instead of adding roots', () => {
  it('takes an optional parent', () => {
    expect(body).toContain('TEXT("component_name"), TEXT("parent") }');
  });

  it('attaches a scene component under the parent or the existing scene root', () => {
    expect(body).toContain('ParentNode = SCS->FindSCSNode(FName(*ParentName));');
    expect(body).toContain('ParentNode = SceneRootNode(SCS);');
    expect(body).toContain('ParentNode->AddChildNode(Node);');
    expect(body).toContain('NativeRoot = CDO->GetRootComponent();');
    expect(body).toContain('Node->SetParent(NativeRoot);');
  });

  it('only adds a root node when nothing can be its parent', () => {
    const add = body.indexOf('SCS->AddNode(Node);');
    expect(add).toBeGreaterThan(body.indexOf('if (ParentNode)'));
    expect(body.match(/AddNode\(Node\)/g)).toHaveLength(1);
  });

  it('refuses a bad parent before changing anything', () => {
    expect(body).toContain('is not a scene component of this Blueprint; nothing was changed');
    expect(body.indexOf('is not a scene component of this Blueprint')).toBeLessThan(body.indexOf('SCS->CreateNode('));
  });

  it('returns the resulting hierarchy', () => {
    expect(body).toContain('Out->SetArrayField(TEXT("hierarchy"), ScsHierarchyJson(SCS));');
    expect(body).toContain('TEXT("attached_to")');
    expect(body).toContain('TEXT("became_root")');
  });
});

describe('the MCP tool forwards parent', () => {
  const calls: Array<{ cmd: string; params: Record<string, unknown> }> = [];
  beforeEach(() => {
    calls.length = 0;
    setDefaultSender((async (cmd: string, params: Record<string, unknown>) => {
      calls.push({ cmd, params });
      return { id: 'inmem', ok: true, data: { ok: true } };
    }) as Sender);
  });
  it('sends parent when given', async () => {
    const tool = STATIC_TOOL_CATALOGUE.find((d) => d.name === 'blueprint_add_component')!;
    await tool.handler({ path: '/Game/BP', component_class_path: '/Script/Engine.StaticMeshComponent',
      component_name: 'Mesh', parent: 'Root' }, undefined as never);
    expect(calls[0]).toMatchObject({ cmd: 'blueprint_add_component', params: { parent: 'Root' } });
  });
});
