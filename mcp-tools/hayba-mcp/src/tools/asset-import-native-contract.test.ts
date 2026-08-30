import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..', '..', '..');
const unrealPrivate = join(repo, 'unreal', 'HaybaMCPToolkit', 'Source', 'HaybaMCPToolkit', 'Private');
const handler = readFileSync(join(unrealPrivate, 'handlers', 'HaybaMCPAssetHandler.cpp'), 'utf8');
const handlerHeader = readFileSync(join(unrealPrivate, 'handlers', 'HaybaMCPAssetHandler.h'), 'utf8');
const nativeTest = readFileSync(join(unrealPrivate, 'Tests', 'HaybaMCPAssetImportSafetyTest.cpp'), 'utf8');
const command = readFileSync(join(unrealPrivate, 'HaybaMCPCommandHandler.cpp'), 'utf8');
const response = readFileSync(join(unrealPrivate, 'HaybaMCPResponseBuilder.h'), 'utf8');
const connectorShared = readFileSync(join(here, 'asset-sources', 'shared.ts'), 'utf8');
const sidecar = JSON.parse(
  readFileSync(join(repo, 'mcp-tools', 'hayba-mcp', 'src', 'legacy-commands', 'sidecar.json'), 'utf8'),
) as {
  commands: Record<
    string,
    {
      params: Array<{ name: string; required: boolean; description?: string }>;
      returns: { fields?: Array<{ name: string }> };
      notes?: string;
    }
  >;
};

function between(source: string, start: string, end: string): string {
  const begin = source.indexOf(start);
  const finish = source.indexOf(end, begin + start.length);
  expect(begin, `missing ${start}`).toBeGreaterThanOrEqual(0);
  expect(finish, `missing ${end}`).toBeGreaterThan(begin);
  return source.slice(begin, finish);
}

function expectBefore(source: string, earlier: string, later: string): void {
  const early = source.indexOf(earlier);
  const late = source.indexOf(later);
  expect(early, `missing ${earlier}`).toBeGreaterThanOrEqual(0);
  expect(late, `missing ${later}`).toBeGreaterThan(early);
}

describe('native single-file asset_import safety contract (#415)', () => {
  const assetImport = between(
    handler,
    'FHaybaHandlerResult FHaybaMCPAssetHandler::AssetImport(',
    'FHaybaHandlerResult FHaybaMCPAssetHandler::AssetDuplicate(',
  );

  it('rejects before modules/mutation and never auto-selects or overwrites', () => {
    expect(handlerHeader).toContain('ParseAndValidateRequest');
    expect(handlerHeader).toContain('ValidateFileHeader');
    expect(assetImport).toContain('FWinAssetSourceLease SourceLease');
    expectBefore(assetImport, 'ParseAndValidateRequest', 'SourceLease.Open');
    expectBefore(assetImport, 'SourceLease.Open', 'ValidateFileHeader');
    expectBefore(assetImport, 'ValidateFileHeader', 'LoadModulePtr<FAssetRegistryModule>');
    expectBefore(assetImport, 'GetAssetByObjectPath(ExpectedSoftPath)', 'LoadModulePtr<FAssetToolsModule>');
    expectBefore(assetImport, 'FPackageName::DoesPackageExist(Request.ExpectedPackageName)', 'ImportAssetsAutomated');
    expectBefore(assetImport, 'Factory->FactoryCanImport', 'ImportAssetsAutomated');
    expectBefore(assetImport, 'SourceLease.Recheck', 'ImportAssetsAutomated');
    expect(assetImport.match(/GetAssetByObjectPath\(ExpectedSoftPath\)/g)).toHaveLength(3);
    expectBefore(assetImport, 'the exact destination appeared during preflight', 'SourceLease.Recheck');
    expect(assetImport.match(/SourceLease\.Recheck/g)).toHaveLength(2);
    expect(assetImport).toContain('ImportData->bReplaceExisting = false');
    expect(assetImport).toContain('ImportData->Filenames = { Request.SourceFile }');
    expect(assetImport).toContain('ImportData->Factory = Factory.Get()');
    expect(assetImport).toContain('TStrongObjectPtr<UFactory> Factory');
    expect(assetImport).toContain('TStrongObjectPtr<UAutomatedAssetImportData> ImportData');
    expect(assetImport).not.toContain('LoadModuleChecked<FAssetToolsModule>');
    expect(assetImport).not.toContain('bReplaceExisting = true');
  });

  it('pins fixed local authority and rejects link/reparse/hardlink/device identities', () => {
    for (const fact of [
      'FPlatformProcess::UserTempDir()',
      'hayba-asset-connectors',
      'CreateFileW(',
      'FILE_FLAG_OPEN_REPARSE_POINT',
      'FILE_FLAG_BACKUP_SEMANTICS',
      'FILE_SHARE_READ',
      'GetFinalPathNameByHandleW',
      'GetFileInformationByHandle',
      'GetFileType(FileHandle) != FILE_TYPE_DISK',
      'FILE_ATTRIBUTE_REPARSE_POINT',
      'FILE_ATTRIBUTE_DEVICE',
      'Identity.nNumberOfLinks != 1',
      'SameWinIdentity(Identity, Current)',
      'GetDriveTypeW',
      'DRIVE_FIXED',
    ]) {
      expect(handler).toContain(fact);
    }
    expect(handler).not.toContain('FILE_SHARE_WRITE');
    expect(handler).not.toContain('FILE_SHARE_DELETE');
    expect(assetImport).toContain('HAI_PLATFORM_UNSUPPORTED');
  });

  it('uses exact bounded kind/magic/factory policy and rejects dependency-reading formats', () => {
    for (const fact of [
      'MaxTextureBytes = 64ll * 1024ll * 1024ll',
      'MaxWaveBytes = 128ll * 1024ll * 1024ll',
      'MaxFbxBytes = 256ll * 1024ll * 1024ll',
      'MaxImageDimension = 8192',
      'MaxImagePixels',
      'MaxFileBytesForKind',
      'ValidateFileSize',
      'ValidatePng',
      'ValidateJpeg',
      'ValidateWave',
      'ValidateFbx',
      'UTextureFactory',
      'USoundFactory',
      'UFbxFactory',
      'FBXIT_StaticMesh',
      'bCombineMeshes = true',
      'bImportMaterials = false',
      'bImportTextures = false',
      'bImportAnimations = false',
      'bBuildNanite = false',
      'bAutoCreateCue = false',
      'UdimRegexPattern = TEXT("a^")',
    ]) {
      expect(handler).toContain(fact);
    }
    expect(handler).toContain('glTF/GLB/OBJ/USD and dependency-reading formats are not accepted');
    expect(handler).toContain('only binary .fbx');
  });

  it('discards callback-returned pointers and re-resolves exact path/class/package truth', () => {
    expect(assetImport).toContain('const int32 ReturnedPointerCount = ImportedPointers.Num()');
    expect(assetImport).not.toMatch(/for\s*\([^)]*ImportedPointers/);
    expect(assetImport).not.toMatch(/ImportedPointers\s*\[/);
    const postImport = assetImport.slice(assetImport.indexOf('ImportAssetsAutomated(ImportData.Get())'));
    expectBefore(postImport, 'ImportAssetsAutomated(ImportData.Get())', 'SourceLease.Recheck(PostIdentityError)');
    expectBefore(
      postImport,
      'SourceLease.Recheck(PostIdentityError)',
      'Registry.GetAssetByObjectPath(ExpectedSoftPath)',
    );
    expectBefore(
      postImport,
      'Registry.GetAssetByObjectPath(ExpectedSoftPath)',
      'Readback.AssetClassPath == ExpectedClass',
    );
    expect(assetImport).toContain('FindPackage(nullptr, *Request.ExpectedPackageName)');
    expect(assetImport).toContain('const FTopLevelAssetPath ExpectedClassPath');
    expect(assetImport).toContain('Readback.AssetClassPath == ExpectedClassPath');
    expect(postImport).not.toContain('ExpectedClass->');
    expect(assetImport).toContain('Readback.GetObjectPathString()');
    expect(assetImport).toContain('Readback.PackageName.ToString()');
    expect(assetImport).toContain('Readback.AssetName.ToString()');
    expect(assetImport).not.toContain('Obj->GetPathName()');
    expect(assetImport).not.toContain('SavePackages(');
  });

  it('surfaces exact persistence/partial/unknown/session state through the advisory machine', () => {
    for (const fact of [
      'save_attempted',
      'saved',
      'dirty_known',
      'dirty',
      'partial',
      'unknown_outcome',
      'session_suspect',
      'mutation_status',
      'failure_kind',
      'crafted_format_safety',
      'readback_verified',
    ]) {
      expect(handler).toContain(`TEXT("${fact}")`);
      expect(response).toContain(`TEXT("${fact}")`);
    }
    expect(command).toContain('Data->TryGetStringField(TEXT("mutation_status")');
    expect(command).toContain('Data->TryGetStringField(TEXT("failure_kind")');
    expect(command).toContain('Data->TryGetBoolField(TEXT("unknown_outcome")');
    expect(command).toContain('Data->TryGetBoolField(TEXT("save_attempted")');
    expect(command).toContain('if (Cmd == TEXT("asset_import"))');
    expect(assetImport).toContain('do not prove crafted-format parser safety');
  });

  it('keeps the connector continuation blocked and documents the grant/sanitizer boundary', () => {
    expect(connectorShared).toContain('HAYBA-ASSET-IMPORT-TYPED-BLOCKED');
    expect(connectorShared).not.toMatch(/executeCommand\s*\(\s*['"]asset_import['"]/);
    const contract = sidecar.commands.asset_import!;
    expect(contract.params.map((param) => param.name)).toEqual(['source_file', 'destination_path', 'asset_type']);
    expect(contract.params.every((param) => param.required)).toBe(true);
    const fields = contract.returns.fields?.map((field) => field.name) ?? [];
    for (const field of [
      'code',
      'mutation_status',
      'failure_kind',
      'path',
      'class',
      'verified',
      'saved',
      'save_attempted',
      'dirty_known',
      'dirty',
      'partial',
      'unknown_outcome',
      'session_suspect',
      'crafted_format_safety',
    ]) {
      expect(fields).toContain(field);
    }
    expect(contract.notes).toContain('opaque single-use grant');
    expect(contract.notes).toContain('do NOT prove crafted files safe');
    expect(contract.notes).toContain('isolated sanitizer');
  });

  it('has native max/hostile request/header cases that do not enter AssetTools', () => {
    for (const fact of [
      'unknown overwrite option is rejected',
      'extension/type mismatch is rejected',
      'source traversal is rejected',
      'drive-relative source is rejected',
      'source controls are rejected',
      'non-Game destination is rejected',
      'oversized PNG dimensions fail',
      'arithmetic JPEG frame fails',
      'non-32-bit float WAV fails',
      'texture exact byte cap passes',
      'texture byte cap plus one fails',
      'zero-byte source fails',
      'WAV chunk overflow fails',
      'ASCII/noncanonical FBX fails',
      'AuthorityRejectsBeforeAssetTools',
      'authority refusal does not load AssetTools',
    ]) {
      expect(nativeTest).toContain(fact);
    }
  });
});
