import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..', '..', '..');
const handlers = join(root, 'unreal', 'HaybaMCPToolkit', 'Source', 'HaybaMCPToolkit', 'Private', 'handlers');

const blueprint = readFileSync(join(handlers, 'HaybaMCPBlueprintHandler.cpp'), 'utf8');
const dataAsset = readFileSync(join(handlers, 'HaybaMCPDataAssetHandler.cpp'), 'utf8');
const level = readFileSync(join(handlers, 'HaybaMCPLevelHandler.cpp'), 'utf8');
const material = readFileSync(join(handlers, 'HaybaMCPMaterialHandler.cpp'), 'utf8');

function between(source: string, start: string, end: string): string {
  const begin = source.indexOf(start);
  const finish = source.indexOf(end, begin + start.length);
  expect(begin, `missing start marker: ${start}`).toBeGreaterThanOrEqual(0);
  expect(finish, `missing end marker: ${end}`).toBeGreaterThan(begin);
  return source.slice(begin, finish);
}

function expectBefore(source: string, earlier: string, later: string): void {
  expect(source.indexOf(earlier), `${earlier} must precede ${later}`).toBeGreaterThanOrEqual(0);
  expect(source.indexOf(later), `missing ${later}`).toBeGreaterThan(source.indexOf(earlier));
}

describe('stateful handler atomicity contracts (#369)', () => {
  it('stages DataAsset conversion away from the live UObject and reports persistence/readback', () => {
    const set = between(dataAsset, '// ---------- data_set ----------', 'TEXT("DataAssetHandler: unknown command');
    expectBefore(set, 'NewObject<UObject>', 'const bool bOk = FJsonObjectConverter::JsonValueToUProperty');
    expectBefore(set, 'ValidateMutationJsonShape', 'NewObject<UObject>');
    expectBefore(set, 'const bool bOk = FJsonObjectConverter::JsonValueToUProperty', 'Asset->Modify()');
    expectBefore(set, 'Asset->Modify()', 'Prop->CopyCompleteValue_InContainer(Asset, StagedAsset)');
    for (const fact of ['Identical_InContainer', 'observed_value', 'TEXT("saved")', 'TEXT("dirty")']) {
      expect(set).toContain(fact);
    }
    expect(dataAsset).toContain('CLASS_Abstract');
    expect(dataAsset).toContain('32-level mutation depth limit');
  });

  it('preflights world replacement and restores sanitizer edits on save failure', () => {
    const load = between(level, '::LevelLoad(', '::LevelSave(');
    expectBefore(load, 'DoesPackageExist', 'LoadMap(');
    expectBefore(load, 'IsPlayingSessionInEditor', 'LoadMap(');
    expectBefore(load, 'IsDirty()', 'LoadMap(');

    const create = between(level, '::LevelCreate(', '::LevelGetInfo(');
    expectBefore(create, 'IsValidLongPackageName', 'CreateNewMapForEditing');
    expectBefore(create, 'DoesPackageExist', 'CreateNewMapForEditing');
    expectBefore(create, 'FindPackage', 'CreateNewMapForEditing');
    expectBefore(create, 'IsPlayingSessionInEditor', 'CreateNewMapForEditing');
    expectBefore(create, 'IsDirty()', 'CreateNewMapForEditing');
    expect(create).toContain('world_changed');
    expect(create).toContain('previous_world');

    const save = between(level, '::LevelSave(', '::LevelCreate(');
    expectBefore(save, 'SaveCurrentLevel()', 'RestoreSanitizedStaticMeshRefs');
    expect(save).toContain('SetDirtyFlag(bWasDirty)');
  });

  it('validates Blueprint defaults before Modify and re-resolves after compile', () => {
    const pin = between(blueprint, '::SetPinDefault(', '::ConnectNodes(');
    expectBefore(pin, 'could not load', 'BP->Modify()');
    expectBefore(pin, 'IsPinDefaultValid', 'BP->Modify()');
    expect(pin).toContain('verified');

    const connect = between(blueprint, '::ConnectNodes(', '::Compile(');
    expectBefore(connect, 'CanCreateConnection', 'BP->Modify()');
    expectBefore(connect, 'TryCreateConnection', 'LinkedTo.Contains');
    expect(connect).toContain('TEXT("verified")');

    const defaults = blueprint.slice(blueprint.indexOf('::SetDefaults('));
    expectBefore(defaults, 'HaybaValidateMutationJsonShape', 'CDO->Modify()');
    expectBefore(defaults, 'CLASS_Abstract', 'NewObject<UObject>');
    expectBefore(defaults, 'NewObject<UObject>', 'CDO->Modify()');
    expectBefore(defaults, 'SetValueFromJson(Prop, StagedCDO', 'CDO->Modify()');
    expectBefore(defaults, 'RecompileAndTrack', 'ObservedCDO = BP->GeneratedClass');
    expect(defaults).toContain('verification_failed');
  });

  it('keeps crash-prone material function compilation at one guarded boundary', () => {
    const calls = material.match(/UMaterialEditingLibrary::UpdateMaterialFunction\(/g) ?? [];
    expect(calls).toHaveLength(1);
    const compile = material.slice(material.indexOf('::MatCompile('));
    expect(compile).toContain('HaybaSeh::RunGuarded');
    expect(compile).toContain('UMaterialEditingLibrary::UpdateMaterialFunction');
  });

  it('preflights material JSON before creating or touching graph state', () => {
    const add = between(material, '::MatAddNode(', 'static int32 CountSourceFanout');
    expectBefore(add, 'PreflightNodeProps', 'CreateMaterialExpressionInFunction');
    expectBefore(add, 'PreflightNodeProps', 'CreateMaterialExpression(Mat');
    const applyProps = between(
      material,
      'static FApplyNodePropsResult ApplyNodeProps',
      'static TArray<FString> HaybaListNodeProps',
    );
    expect(applyProps).not.toContain('Expr->PostEditChange()');

    const setProperty = between(material, '::MatSetProperty(', 'static void CollectMaterialGraphProblems');
    expectBefore(setProperty, 'NewObject<UMaterial>', 'Mat->Modify()');
    expectBefore(setProperty, 'ValidateJsonForProperty', 'Mat->Modify()');
    expectBefore(setProperty, 'Problems.Num() > 0', 'Mat->Modify()');
    expect(setProperty).toContain('verification_failed');
    expect(material).toContain('32-level mutation depth limit');
  });
});
