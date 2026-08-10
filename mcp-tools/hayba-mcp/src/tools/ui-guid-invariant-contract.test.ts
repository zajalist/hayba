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
});
