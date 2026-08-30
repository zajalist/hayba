import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const handlerPath = join(
  here,
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
  'HaybaMCPUIHandler.cpp',
);
const source = readFileSync(handlerPath, 'utf8');
const opsSource = readFileSync(
  join(
    here,
    '..',
    '..',
    '..',
    '..',
    'unreal',
    'HaybaMCPToolkit',
    'Source',
    'HaybaMCPToolkit',
    'Private',
    'HaybaUIOps.cpp',
  ),
  'utf8',
);

function bodyOf(signature: string, nextSignature: string): string {
  const start = source.indexOf(signature);
  const end = source.indexOf(nextSignature, start + signature.length);
  expect(start, `${signature} exists`).toBeGreaterThanOrEqual(0);
  expect(end, `${nextSignature} follows it`).toBeGreaterThan(start);
  return source.slice(start, end);
}

describe('UMG GUID invariant crash boundary (#406)', () => {
  it('has exactly one raw structural-compile call, inside the invariant adapter', () => {
    const calls = source.match(/FBlueprintEditorUtils::MarkBlueprintAsStructurallyModified\(/g) ?? [];
    expect(calls).toHaveLength(1);

    const adapter = bodyOf(
      'bool FinalizeWidgetTreeMutation(',
      'UClass* ResolveWidgetClass(',
    );
    expect(adapter).toContain('ReconcileWidgetVariableGuids(WBP, Context');
    expect(adapter).toContain('MarkBlueprintAsStructurallyModified(WBP)');
  });

  it('has exactly one raw explicit compile, after reconciliation in the wrapper', () => {
    const calls = source.match(/FKismetEditorUtilities::CompileBlueprint\(/g) ?? [];
    expect(calls).toHaveLength(1);

    const compile = bodyOf(
      'FCompileResult CompileWidgetBlueprint(',
      '/** Save and verify against the file system.',
    );
    expect(compile.indexOf('ReconcileWidgetVariableGuids(')).toBeGreaterThanOrEqual(0);
    expect(compile.indexOf('FKismetEditorUtilities::CompileBlueprint(')).toBeGreaterThan(
      compile.indexOf('ReconcileWidgetVariableGuids('),
    );
  });

  it('never deletes the compiler GUID when a widget stops being exposed as a variable', () => {
    const setVariable = bodyOf(
      'FHaybaHandlerResult FHaybaMCPUIHandler::HandleSetVariable(',
      'FHaybaHandlerResult FHaybaMCPUIHandler::HandleBindProperty(',
    );
    expect(setVariable).toContain('RegisterWidgetVariable(WBP, Widget)');
    expect(setVariable).not.toMatch(/WidgetVariableNameToGuidMap\.Remove/);
    expect(setVariable).toContain('FinalizeWidgetTreeMutation(WBP, TEXT("ui_set_variable")');
  });

  it('preflights properties, all tree mutations, variable changes, bindings, compile and save', () => {
    for (const marker of [
      'ui_set_widget_properties preflight',
      'ui_mutate_tree preflight',
      'ui_build_tree preflight',
      'ui_set_variable preflight',
      'ui_bind_property preflight',
      'ui_compile_widget',
      'ui_save_widget preflight',
    ]) {
      expect(source, marker).toContain(marker);
    }
  });

  it('retires discarded widget objects out of the WidgetTree source population', () => {
    const retire = bodyOf(
      'bool RetireWidgetTreeObject(',
      '/** Remove every object allocated for a staged operation',
    );
    expect(retire).toContain('GetTransientPackage()');
    expect(retire).toContain('Widget->Rename(');

    const discard = bodyOf(
      'bool DiscardStagedWidgets(',
      '/** Copy every property the two widgets share',
    );
    expect(discard).toContain('RetireWidgetTreeObject(WBP, Widget)');
  });

  it('retires the outgoing replacement subtree before final GUID reconciliation', () => {
    const replace = bodyOf(
      'else if (Operation == TEXT("replace"))',
      'FHaybaHandlerResult FHaybaMCPUIHandler::HandleCompile(',
    );
    const retire = replace.indexOf('RetireWidgetTreeObject(WBP, Widget)');
    const finalize = replace.indexOf(
      'FinalizeWidgetTreeMutation(WBP, TEXT("ui_mutate_tree replace")',
    );
    expect(retire).toBeGreaterThanOrEqual(0);
    expect(finalize).toBeGreaterThan(retire);
  });

  it('keeps missing and stale GUID repair behavior pinned in the pure planner', () => {
    expect(opsSource).toMatch(
      /if \(!ExistingGuid\)[\s\S]{0,300}Missing\.Add\(Name\)[\s\S]{0,300}FreshGuid\(Name, Used\)[\s\S]{0,300}Reconciled\.Add\(Name, NewGuid\)/,
    );
    expect(opsSource).toMatch(
      /for \(const TPair<FName, FGuid>& Pair : Existing\)[\s\S]{0,200}!LiveNames\.Contains\(Pair\.Key\)[\s\S]{0,100}Stale\.Add\(Pair\.Key\)/,
    );
  });

  it('keeps rollback diagnostics compatible with UE checked format strings', () => {
    expect(source).not.toMatch(/FString::Printf\(\s*\w+\s*\?\s*TEXT\(/);
    for (const marker of [
      'if (bRecovered)',
      'if (bStillOriginal)',
      'Widget and slot restored',
      'the staged subtree was removed',
    ]) {
      expect(source, marker).toContain(marker);
    }
  });
});
