import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const handler = readFileSync(
  join(root, 'unreal', 'HaybaMCPMetaSound', 'Source', 'HaybaMCPMetaSound', 'Private', 'HaybaMCPMetaSoundHandler.cpp'),
  'utf8',
);
const assetHandler = readFileSync(
  join(
    root,
    'unreal',
    'HaybaMCPToolkit',
    'Source',
    'HaybaMCPToolkit',
    'Private',
    'handlers',
    'HaybaMCPAssetHandler.cpp',
  ),
  'utf8',
);
const nativeTest = readFileSync(
  join(
    root,
    'unreal',
    'HaybaMCPMetaSound',
    'Source',
    'HaybaMCPMetaSound',
    'Private',
    'Tests',
    'HaybaMCPMetaSoundHandlerTest.cpp',
  ),
  'utf8',
);

describe('editor-safe MetaSound handler contract', () => {
  it('has native coverage for the public input boundary', () => {
    expect(nativeTest).toContain('Hayba.MCP.MetaSound.InputBoundary');
    expect(nativeTest).toContain('create cannot write mounted engine content');
    expect(nativeTest).toContain('save is validated before any asset is loaded');
    expect(nativeTest).toContain('malformed canonical path cannot fall through to an alias');
  });

  it.each([
    'metasound_create',
    'metasound_add_node',
    'metasound_connect',
    'metasound_set_input',
    'metasound_compile',
    'metasound_inspect',
  ])('%s dispatches to a real implementation', (command) => {
    expect(handler).toContain(`Cmd == TEXT("${command}")`);
    expect(handler).not.toMatch(new RegExp(`${command}: pending MetaSoundFrontendDocumentBuilder`));
  });

  it('keeps graph edits in memory until the explicit compile/save boundary', () => {
    expect(handler).toMatch(/MSAddNode[\s\S]*MarkPackageDirty/);
    expect(handler).toMatch(/MSCompile[\s\S]*UPackage::SavePackage/);
  });

  it('inspects the active UE 5.8 graph page instead of the empty legacy graph field', () => {
    expect(handler).toContain('GetConstDocumentChecked()');
    expect(handler).toContain('GetBuildPageID()');
    expect(handler).toContain('FindConstGraph(RequestedPageID)');
    expect(handler).not.toContain('Doc.RootGraph.Graph.Nodes');
    expect(handler).not.toContain('Doc.RootGraph.Graph.Edges');
  });

  it('uses the frontend compiler and never mistakes conformance for validity', () => {
    expect(handler).toContain('UpdateAndRegisterForExecution');
    expect(handler).toContain('GetGraphRegistryKey().IsValid()');
    expect(handler).toContain('TArray<FGuid> PageOrder({ BuildPageID })');
    expect(handler).not.toContain('PageOrder.Add(Metasound::Frontend::DefaultPageID)');
    expect(handler).toContain('SetBoolField(TEXT("conformed_object_data"),bConformed)');
    expect(handler).toContain('SetBoolField(TEXT("valid"),true)');
    expect(handler).not.toContain('SetBoolField(TEXT("valid"),bConformed)');
  });

  it('guards the engine checkf when runtime graph execution is unavailable', () => {
    expect(handler).toContain('#include "MetasoundGlobals.h"');
    expect(handler).toMatch(/!Metasound::CanEverExecuteGraph\(\)[\s\S]*UpdateAndRegisterForExecution/);
    expect(handler).not.toContain('false && !Metasound::CanEverExecuteGraph()');
    expect(handler).toMatch(/!Metasound::CanEverExecuteGraph\(\)[\s\S]*InitNodeLocations/);
  });

  it('preflights every checked document-builder-registry condition', () => {
    expect(handler).toMatch(/AttachBuilder[\s\S]*!IsInGameThread\(\)/);
    expect(handler).toContain('!Asset.IsAsset()');
    expect(handler).toContain('!Cast<IMetaSoundDocumentInterface>(&Asset)');
    expect(handler).toContain('!Metasound::Frontend::IDocumentBuilderRegistry::Get()');
    expect(handler).toContain('RootGraph.Metadata.GetClassName().IsValid()');
    expect(handler).toMatch(/GetClassName\(\)\.IsValid\(\)[\s\S]*FindOrBeginBuilding/);
    expect(handler).not.toContain('false && !Document->GetConstDocument().RootGraph.Metadata.GetClassName().IsValid()');
    expect(handler).toContain('RootGraph.FindConstGraph(Metasound::Frontend::DefaultPageID)');
    expect(handler).not.toContain('RootGraph.GetConstDefaultGraph()');
    expect(handler).toMatch(/FHaybaMCPMetaSoundHandler::Handle[\s\S]*if \(!IsInGameThread\(\)\)/);
  });

  it('preflights the checked MetaSound asset-manager singleton before compiling', () => {
    expect(handler).toContain('!Metasound::Frontend::IMetaSoundAssetManager::Get()');
    expect(handler).toMatch(/IMetaSoundAssetManager::Get\(\)[\s\S]*UpdateAndRegisterForExecution/);
    expect(handler).not.toContain('false && !Metasound::Frontend::IMetaSoundAssetManager::Get()');
  });

  it('preflights the checked node registry and exact selected graph page', () => {
    expect(handler).toContain('#include "MetasoundFrontendNodeClassRegistry.h"');
    expect(handler).toContain('!Metasound::Frontend::INodeClassRegistry::Get()');
    expect(handler).toMatch(/INodeClassRegistry::Get\(\)[\s\S]*AddNodeByClassName/);
    expect(handler).toMatch(/MSCompile[\s\S]*FindConstGraph\(BuildPageID\)[\s\S]*UpdateAndRegisterForExecution/);
    expect(handler).toContain('page_fallback');
    expect(handler).toContain('requested_page_id');
  });

  it('uses recoverable module loads instead of checked loads', () => {
    expect(handler).toContain('LoadModulePtr<FAssetToolsModule>');
    expect(handler).toContain('LoadModulePtr<FAssetRegistryModule>');
    expect(handler).not.toContain('LoadModuleChecked<FAssetToolsModule>');
    expect(handler).not.toContain('LoadModuleChecked<FAssetRegistryModule>');
  });

  it('filters by MetaSound class and stops enumeration at the response cap', () => {
    expect(handler).toContain('Filter.ClassPaths.Add(UMetaSoundSource::StaticClass()->GetClassPathName())');
    expect(handler).toContain('Filter.ClassPaths.Add(UMetaSoundPatch::StaticClass()->GetClassPathName())');
    expect(handler).toContain('AR.EnumerateAssets(Filter');
    expect(handler).toMatch(/Out\.Num\(\) >= Cap[\s\S]*return false/);
    expect(handler).not.toContain('GetAssetsByPath(FName(*Path), Assets');
  });

  it('bounds hostile graph payloads before doing game-thread compiler work', () => {
    expect(handler).toContain('MaxGraphPages = 64');
    expect(handler).toContain('MaxGraphNodes = 4096');
    expect(handler).toContain('MaxGraphEdges = 16384');
    expect(handler).toContain('MaxGraphVertices = 65536');
    expect(handler).toContain('MaxInspectNodes = 512');
    expect(handler).toContain('MaxInspectEdges = 2048');
    expect(handler).toContain('MaxInspectVertices = 8192');
    expect(handler).toMatch(/IsGraphWithinLimits\(Doc, LimitError\)[\s\S]*UpdateAndRegisterForExecution/);
    expect(handler).toMatch(/MSInspect[\s\S]*IsGraphWithinLimits\(Doc, LimitError\)/);
    expect(handler).toMatch(/LoadMetaSound[\s\S]*IsGraphWithinLimits\(ConstDocument, LimitError\)/);
    expect(handler).toContain('FMath::IsFinite(V)');
    expect(handler).toContain('IsValidObjectPath');
  });

  it('rejects fractional or non-finite node versions instead of truncating them', () => {
    expect(handler).toContain('FMath::FloorToDouble(RawMajor) != RawMajor');
    expect(handler).toContain('FMath::IsFinite(RawMajor)');
    expect(handler).not.toContain('TryGetNumberField(TEXT("major_version"), Major)');
  });

  it('does not reinterpret malformed optional fields as omitted defaults', () => {
    expect(handler).toContain('namespace must be a string');
    expect(handler).toContain('variant must be a string');
    expect(handler).toContain('type must be a string');
    expect(handler).toContain('node_id must be a valid GUID when supplied');
    expect(handler).toContain('save must be a boolean');
    expect(handler).toContain('SaveValue->Type != EJson::Boolean');
    expect(handler).toMatch(
      /SaveValue->Type != EJson::Boolean[\s\S]*LoadMetaSound\(P, Path, Error/,
    );
    expect(handler).not.toContain('TryGetBoolField(TEXT("save"), bSave)');
    expect(handler).toContain('path_prefix must be a string');
    expect(handler).toMatch(/bool bSave = true;[\s\S]*LoadMetaSound\(P, Path, Error/);
  });

  it('rejects stale or foreign node GUIDs before calling builder mutations', () => {
    expect(handler).toContain('bool GraphContainsNode');
    expect(handler).toContain('from_node_id is not present on the active graph page');
    expect(handler).toContain('to_node_id is not present on the active graph page');
    expect(handler).toContain('node_id is not present on the active graph page');
    expect(handler).toMatch(/GraphContainsNode\(\*ActiveGraph, FromID\)[\s\S]*ConnectNodes/);
    expect(handler).toMatch(/GraphContainsNode\(\*ActiveGraph, NodeID\)[\s\S]*FindNodeInputByName/);
  });

  it('validates stored edge topology before reaching engine checkf calls', () => {
    expect(handler).toContain('struct FNodeVertexKey');
    expect(handler).toContain('graph contains an edge whose node or pin no longer exists');
    expect(handler).toContain('graph contains multiple edges to one input pin');
    expect(handler).toMatch(
      /IsGraphWithinLimits[\s\S]*OutputVertices\.Contains\(From\)[\s\S]*ConnectedInputs\.Contains\(To\)/,
    );
    expect(handler).toMatch(/LoadMetaSound[\s\S]*IsGraphWithinLimits[\s\S]*AttachBuilder/);
  });

  it('bounds validation diagnostics before returning them over TCP', () => {
    expect(handler).toContain('MaxValidationIssues = 256');
    expect(handler).toContain('MaxDiagnosticChars = 2048');
    expect(handler).toContain('Issue.Message.ToString().Left(MaxDiagnosticChars)');
  });

  it('confines asset creation and enumeration to project content', () => {
    expect(handler).toContain('bool IsGameContentPath');
    expect(handler).toContain('Path == TEXT("/Game") || Path.StartsWith(TEXT("/Game/"))');
    expect(handler).toMatch(/MSCreate[\s\S]*IsGameContentPath\(Dir\)/);
    expect(handler).toMatch(/MSList[\s\S]*IsGameContentPath\(Path\)/);
  });

  it('does not let graph mutations write engine or plugin content', () => {
    expect(handler).toContain('FPackageName::ObjectPathToPackageName(OutPath)');
    expect(handler).toContain('metasound_path must reference project content under /Game for mutation');
    expect(handler.match(/LoadMetaSound\(P, Path, Error, \/\*bRequireGameContent=\*\/true\)/g)).toHaveLength(4);
  });

  it('normalizes package-only object paths with the asset basename', () => {
    expect(assetHandler).toContain('FPackageName::GetShortName(Path)');
    expect(assetHandler).not.toContain('Path += TEXT(".") + Path');
  });

  it('validates folders recursively and returns per-asset diagnostics', () => {
    expect(assetHandler).toContain('GetAssetsByPath(FName(*Path), ToValidate, /*bRecursive*/true)');
    expect(assetHandler).toContain('Settings.bCollectPerAssetDetails = true');
    expect(assetHandler).toContain('Results.AssetsDetails');
  });
});
