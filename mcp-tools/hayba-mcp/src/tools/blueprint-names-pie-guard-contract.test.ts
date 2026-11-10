/**
 * FoA's 6 h freeze, 2026-11-09: blueprint_add_function took the name of BP_RoomAudio's component "Presence". The
 * class stopped compiling ("Name collision - function and property have the same name"), and the next
 * editor_request_begin_play opened UE's modal "Blueprint Compilation Errors" prompt, which parked the game thread
 * until a human answered it. This pins both halves of the fix in the source: the add commands run the editor's own
 * member-name check before they change anything, and every PIE start Hayba sees is refused while a loaded Blueprint
 * fails to compile.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const priv = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'unreal', 'HaybaMCPToolkit', 'Source',
  'HaybaMCPToolkit', 'Private');
const read = (...p: string[]) => readFileSync(join(priv, ...p), 'utf8').replace(/\r\n/g, '\n');
const bp = read('handlers', 'HaybaMCPBlueprintHandler.cpp');
const editor = read('handlers', 'HaybaMCPEditorHandler.cpp');
const python = read('handlers', 'HaybaMCPPythonHandler.cpp');
const between = (src: string, from: string, to: string) => src.slice(src.indexOf(from), src.indexOf(to, src.indexOf(from)));

describe('Blueprint add commands refuse a member name that is already taken', () => {
  it('checks with the editor name validator, which sees variables, components, functions, events and parents', () => {
    expect(bp).toContain('FKismetNameValidator(BP).IsValid(FName(*Name))');
  });

  for (const [cmd, from, to, mutation] of [
    ['blueprint_add_component', 'FHaybaHandlerResult FHaybaMCPBlueprintHandler::AddComponent(', 'static bool HaybaResolvePinType(',
      'SimpleConstructionScript->CreateNode('],
    ['blueprint_add_variable', 'FHaybaHandlerResult FHaybaMCPBlueprintHandler::AddVariable(', 'FHaybaHandlerResult FHaybaMCPBlueprintHandler::AddFunction(',
      'FBlueprintEditorUtils::AddMemberVariable('],
    ['blueprint_add_function', 'FHaybaHandlerResult FHaybaMCPBlueprintHandler::AddFunction(', 'UK2Node_FunctionEntry* Entry = nullptr;',
      'FBlueprintEditorUtils::CreateNewGraph('],
  ] as const) {
    it(`${cmd} refuses before it creates anything`, () => {
      const body = between(bp, from, to);
      const check = body.indexOf(`MemberNameTaken(BP, TEXT("${cmd}")`);
      expect(check).toBeGreaterThan(-1);
      expect(check).toBeLessThan(body.indexOf(mutation));
    });
  }
});

describe('PIE never starts into the modal compile-error prompt', () => {
  it('lists loaded Blueprints on the same condition UE prompts on', () => {
    const guard = read('HaybaPlayGuard.cpp');
    expect(guard).toContain('Blueprint->Status == BS_Error');
    expect(guard).toContain('Blueprint->bDisplayCompilePIEWarning || Blueprint->IsPossiblyDirty()');
  });

  it('editor_start_pie refuses before it requests a play session', () => {
    const body = between(editor, 'FHaybaHandlerResult FHaybaMCPEditorHandler::StartPIE(', '\n}\n');
    const refuse = body.indexOf('HaybaPlayGuard::RefusalFor(TEXT("editor_start_pie"))');
    expect(refuse).toBeGreaterThan(-1);
    expect(refuse).toBeLessThan(body.indexOf('GEditor->RequestPlaySession('));
  });

  it('python_run and python_exec_file refuse a script that starts PIE', () => {
    expect(python).toContain('TEXT("editor_request_begin_play"), TEXT("editor_play_simulate")');
    expect(between(python, 'FHaybaHandlerResult FHaybaMCPPythonHandler::Run(', 'EPythonTier Tier = ClassifyScript(Code);'))
      .toContain('PlayStartRefusal(Code, TEXT("python_run"))');
    expect(between(python, 'FHaybaHandlerResult FHaybaMCPPythonHandler::ExecFile(', 'TSharedPtr<FJsonObject> Env'))
      .toContain('PlayStartRefusal(Source, TEXT("python_exec_file"))');
  });
});
