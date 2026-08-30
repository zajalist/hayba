import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..', '..', '..');
const handlers = join(root, 'unreal', 'HaybaMCPToolkit', 'Source', 'HaybaMCPToolkit', 'Private', 'handlers');

const blueprint = readFileSync(join(handlers, 'HaybaMCPBlueprintHandler.cpp'), 'utf8');
const dataAsset = readFileSync(join(handlers, 'HaybaMCPDataAssetHandler.cpp'), 'utf8');
const commandRouter = readFileSync(
  join(root, 'unreal', 'HaybaMCPToolkit', 'Source', 'HaybaMCPToolkit', 'Private', 'HaybaMCPCommandHandler.cpp'),
  'utf8',
);
const level = readFileSync(join(handlers, 'HaybaMCPLevelHandler.cpp'), 'utf8');
const material = readFileSync(join(handlers, 'HaybaMCPMaterialHandler.cpp'), 'utf8');
const sidecar = JSON.parse(
  readFileSync(join(root, 'mcp-tools', 'hayba-mcp', 'src', 'legacy-commands', 'sidecar.json'), 'utf8'),
) as {
  commands: Record<string, { notes?: string; returns: { fields?: Array<{ name: string }> } }>;
};

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

function emittedOutFields(source: string): string[] {
  return [
    ...new Set(
      [...source.matchAll(/Out->Set(?:String|Bool|Number|Object|Array)?Field\(TEXT\("([^"]+)"\)/g)].map(
        (match) => match[1]!,
      ),
    ),
  ].sort();
}

describe('stateful handler atomicity contracts (#369)', () => {
  it('bounds data_create strings and refuses unsafe classes before AssetTools (#368)', () => {
    const create = between(dataAsset, '// ---------- data_create ----------', '// ---------- data_get ----------');
    for (const fact of [
      'FHaybaParamReader R',
      'RequiredGamePath(TEXT("path"), MaxDataAssetPathChars)',
      'RequiredString(TEXT("name"), MaxDataAssetNameChars)',
      'RequiredString(TEXT("class_name"), MaxDataAssetClassChars)',
      'IsValidLongPackageName(PackagePath)',
      'IsSafeAssetName',
      'IsSafeClassReference',
      'CLASS_Abstract | CLASS_Deprecated | CLASS_NewerVersionExists',
      'LoadModulePtr<FAssetToolsModule>',
      'AssetTools module is unavailable; nothing was created',
    ]) {
      expect(create).toContain(fact);
    }
    expectBefore(create, 'if (R.HasErrors())', 'const FString IntendedPackage');
    expectBefore(create, 'if (R.HasErrors())', 'ResolveClass(ClassName)');
    expectBefore(create, 'AssetNameTaken', 'LoadModulePtr<FAssetToolsModule>');
    expectBefore(create, 'CLASS_Abstract | CLASS_Deprecated | CLASS_NewerVersionExists', 'AssetTools.CreateAsset');
    expectBefore(create, 'LoadModulePtr<FAssetToolsModule>', 'AssetTools.CreateAsset');
    expectBefore(create, 'CreatedWeak = NewAsset', 'DirtyTarget->MarkPackageDirty()');
    expectBefore(create, 'DirtyTarget->MarkPackageDirty()', 'SaveTarget = LoadObject<UObject>');
    expectBefore(create, 'SaveLoadedAsset(', 'ObservedAsset = LoadObject<UObject>');
    expect(create).toContain('data_create_unknown_outcome');
    expect(create).toContain('Out->SetBoolField(TEXT("ok"), bOutcomeTrustworthy)');
    expect(create).not.toContain('NewAsset->GetOutermost()->IsDirty()');
    expect(create).not.toContain('LoadModuleChecked<FAssetToolsModule>');
    expect(create).not.toContain('TryGetStringField(TEXT("path"), PackagePath)');

    const createFields = sidecar.commands.data_create.returns.fields?.map((field) => field.name) ?? [];
    expect([...createFields].sort()).toEqual(emittedOutFields(create));
    expect(sidecar.commands.data_create.notes).toContain('no raw creation pointer crosses');
    expect(sidecar.commands.data_create.notes).toContain('data_create_unknown_outcome');
  });

  it('stages DataAsset conversion away from the live UObject and reports persistence/readback', () => {
    const get = between(dataAsset, '// ---------- data_get ----------', '// ---------- data_set ----------');
    const set = between(dataAsset, '// ---------- data_set ----------', 'TEXT("DataAssetHandler: unknown command');
    const reflectionHelper = between(
      dataAsset,
      'static bool ReflectPropertyValueBounded(',
      '// Reflect a bounded prefix of properties',
    );
    expect(get).toContain('RequiredGamePath(TEXT("path"), MaxDataAssetPathChars)');
    expectBefore(get, 'if (R.HasErrors())', 'LoadDataAsset(Path)');
    for (const fact of [
      'ReflectObjectPropertiesBounded',
      'reflection_complete',
      'reflection_truncated',
      'properties_omitted_at_least',
      'omitted_count_exact',
      'reflection_limits',
    ]) {
      expect(get).toContain(fact);
    }
    expect(get).not.toContain('UPropertyToJsonValue');
    expect(reflectionHelper).toContain('Property->HasSetterOrGetter()');
    expectBefore(
      reflectionHelper,
      'if (Property->HasSetterOrGetter())',
      'return ReflectScalarPropertyBounded(Property, Value, Depth, Budget, OutValue)',
    );

    expect(set).toContain('RequiredGamePath(TEXT("path"), MaxDataAssetPathChars)');
    expect(set).toContain('RequiredString(TEXT("property_name"), MaxDataAssetPropertyNameChars)');
    expectBefore(set, 'if (R.HasErrors())', 'ValidateMutationJsonShape');
    expectBefore(set, 'ValidateMutationJsonShape', 'LoadDataAsset(Path)');
    expectBefore(set, 'IsSafePropertyName(PropertyName)', 'FindFProperty<FProperty>');
    expectBefore(set, 'CLASS_Abstract | CLASS_Deprecated | CLASS_NewerVersionExists', 'FindFProperty<FProperty>');
    expectBefore(set, 'ValidateMutationPropertyGraph', 'FDefaultConstructedPropertyElement StagedValue');
    expectBefore(set, 'ValidateMutationPropertyGraph', 'const bool bOk = AssignAuditedScalarValue');
    expectBefore(set, 'ValidateMutationValueForProperty', 'FDefaultConstructedPropertyElement StagedValue');
    expectBefore(set, 'ValidateMutationValueForProperty', 'const bool bOk = AssignAuditedScalarValue');
    expectBefore(set, 'MaxMutationStagingBytes', 'FDefaultConstructedPropertyElement StagedValue');
    expectBefore(set, 'ExistingValueBudget', 'FDefaultConstructedPropertyElement StagedValue');
    expectBefore(set, 'ValidateMutationJsonShape', 'FDefaultConstructedPropertyElement StagedValue');
    expect(set).not.toContain('NewObject<UObject>');
    expectBefore(
      set,
      'const bool bOk = AssignAuditedScalarValue',
      'Prop->CopyCompleteValue(LiveMutableValuePtr, StagedValuePtr)',
    );
    for (const forbidden of [
      'Asset->Modify()',
      'Asset->PreEditChange',
      'Asset->PostEditChangeProperty',
      'SaveLoadedAsset',
      'Prop->Identical(',
      'PPF_DeepComparison',
    ]) {
      expect(set).not.toContain(forbidden);
    }
    for (const fact of [
      'FJsonValue::CompareEqual',
      'TargetWeak = Asset',
      'TargetObjectPath = Asset->GetPathName()',
      'TargetClassPath = Class->GetPathName()',
      'DirtyTarget->MarkPackageDirty()',
      'LoadDataAsset(TargetObjectPath)',
      'FindFProperty<FProperty>(ObservedClass',
      'TEXT("target_re_resolved")',
      'TEXT("dirty_marked")',
      'TEXT("copy_completed")',
      'TEXT("ok"), bOutcomeTrustworthy',
      'data_set_unknown_outcome',
      'TEXT("dirty_known")',
      'observed_value',
      'observed_value_omitted',
      'observed_value_truncated',
      'ReflectPropertyValueBounded',
      'TEXT("save_requested")',
      'TEXT("persistence_tip")',
      'TEXT("dirty")',
    ]) {
      expect(set).toContain(fact);
    }
    expectBefore(set, 'FDefaultConstructedPropertyElement StagedValue', 'DirtyTarget->MarkPackageDirty()');
    expectBefore(set, 'DirtyTarget->MarkPackageDirty()', 'LoadDataAsset(TargetObjectPath)');
    expectBefore(set, 'LoadDataAsset(TargetObjectPath)', 'FindFProperty<FProperty>(ObservedClass');
    expectBefore(set, 'FindFProperty<FProperty>(ObservedClass', 'FJsonValue::CompareEqual');
    expect(set).toContain('All staged/property-owned state was destroyed above');
    expect(set).not.toContain('UPropertyToJsonValue');
    expect(dataAsset).toContain('CLASS_Abstract');
    expect(dataAsset).toContain('MaxReflectionNodes = 4096');
    expect(dataAsset).toContain('MaxReflectionContainerSlots = 1024');
    expect(dataAsset).toContain('Helper.Num(), Helper.GetMaxIndex(), TEXT("set")');
    expect(dataAsset).toContain('Helper.Num(), Helper.GetMaxIndex(), TEXT("map")');
    expect(dataAsset).toContain('sparse-slot traversal limit');
    expect(dataAsset).toContain('MaxReflectionStringChars = 16 * 1024');
    expect(dataAsset).toContain('GetMemoryFootprint() > MaxFootprint');
    expect(dataAsset).toContain('FText::ToString can expand an arbitrarily large formatted');
    expect(dataAsset).toContain('contains instanced object construction hooks');
    expect(dataAsset).toContain('is not one of the supported scalar property types');
    expect(dataAsset).toContain('even a hook-free');
    expect(dataAsset).toContain('DefaultInstance');
    expect(dataAsset).toContain('must be a non-empty control-free string of at most 256 characters');
    expect(dataAsset).toContain('conversion was not entered and nothing was changed');
    expect(dataAsset).toContain('MaxExactJsonInteger = 9007199254740991LL');
    expect(dataAsset).toContain('MaxMutationStagingBytes = 1024 * 1024');
    expect(dataAsset).toContain('GetUnsignedIntPropertyValue');
    expect(dataAsset).toContain('TryParseCanonicalUnsignedDecimal');
    expect(dataAsset).toContain('ResolveAuditedEnumString');
    expect(dataAsset).toContain('GetIndexByNameString');
    expect(dataAsset).toContain('GetValueByIndex');
    expect(dataAsset).toContain('Tokens.Num() > 1 && !Enum->HasAnyEnumFlags(EEnumFlags::Flags)');
    const enumNativeTest = readFileSync(
      join(
        root,
        'unreal',
        'HaybaMCPToolkit',
        'Source',
        'HaybaMCPToolkit',
        'Private',
        'Tests',
        'HaybaMCPDataAssetPreflightTest.cpp',
      ),
      'utf8',
    );
    expect(enumNativeTest).toContain('SignedEnum->GetName() + TEXT("::MinusOne")');
    expect(enumNativeTest).toContain('FlagsEnum->GetName() + TEXT("::First")');
    expect(enumNativeTest).toContain('FlagsEnum->GetName() + TEXT("::Second")');
    expect(enumNativeTest).not.toContain('EHaybaSignedProbe::MinusOne');
    expect(enumNativeTest).not.toContain('EHaybaFlagsProbe::First');
    expect(dataAsset).toContain('CPF_SkipSerialization');
    expect(dataAsset).toContain('has a native getter or setter; raw storage would bypass its semantics');
    expect(set.match(/ValidateMutationPropertyGraph\(/g)).toHaveLength(2);
    expect(dataAsset).toContain('FSoftObjectProperty');
    expect(dataAsset).toContain('FWeakObjectProperty');
    expect(dataAsset).toContain('FLazyObjectProperty');
    expect(dataAsset).not.toContain('FJsonObjectConverter::JsonValueToUProperty');
    expect(dataAsset).toContain('large_integers_as_strings');
    expect(commandRouter).toContain('if (Cmd == TEXT("data_set")) return false;');

    const getFields = sidecar.commands.data_get.returns.fields?.map((field) => field.name) ?? [];
    const setFields = sidecar.commands.data_set.returns.fields?.map((field) => field.name) ?? [];
    for (const fact of [
      'reflection_complete',
      'reflection_truncated',
      'properties_omitted_at_least',
      'unsupported_values',
      'large_integers_as_strings',
      'reflection_limits',
    ]) {
      expect(getFields).toContain(fact);
    }
    for (const fact of [
      'copy_completed',
      'ok',
      'error',
      'verified',
      'target_re_resolved',
      'dirty_marked',
      'save_requested',
      'dirty_known',
      'dirty',
      'observed_value',
      'observed_value_omitted',
      'observed_value_truncated',
      'persistence_tip',
    ]) {
      expect(setFields).toContain(fact);
    }
    expect(sidecar.commands.data_get.notes).toContain('bounded property snapshot');
    expect(sidecar.commands.data_set.notes).toContain('Only exact built-in numeric, enum, bool, string, and name property classes');
    expect(sidecar.commands.data_set.notes).toContain('save_requested is always false');
    expect(sidecar.commands.data_set.notes).toContain('nested ok:false');
    expect([...getFields].sort()).toEqual(emittedOutFields(get));
    expect([...setFields].sort()).toEqual(emittedOutFields(set));
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
