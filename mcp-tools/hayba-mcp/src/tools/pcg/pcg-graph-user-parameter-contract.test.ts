/**
 * A production project, 2026-11-12: a runtime-generated PCG graph that samples a virtual texture needs a struct-typed
 * graph user parameter (FPCGVirtualTexturePrimingInfo) so generation primes the texture first. Python can neither add
 * graph user parameters nor set a struct-typed one, and PCG does not export that struct, so a lane shipped its own
 * C++ helper. Pins UHaybaPCGLibrary::SetPCGGraphUserParameter: it finds the struct by path or name, refuses a type
 * clash or a missing parameter before changing anything, adds a missing struct parameter through AddUserParameters,
 * writes the value inside UpdateUserParametersStruct (so graph instances refresh), and names every struct field that
 * did not land.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const source = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
  '..',
  'unreal',
  'HaybaMCPToolkit',
  'Source',
  'HaybaMCPToolkit',
);
const read = (...p: string[]) => readFileSync(join(source, ...p), 'utf8').replace(/\r\n/g, '\n');
const header = read('Public', 'pcg', 'HaybaPCGLibrary.h');
const cpp = read('Private', 'pcg', 'HaybaPCGLibrary.cpp');
const body = cpp.slice(cpp.indexOf('FString UHaybaPCGLibrary::SetPCGGraphUserParameter('));

describe('UHaybaPCGLibrary::SetPCGGraphUserParameter', () => {
  it('is a static BlueprintCallable, so python_run reaches it as unreal.HaybaPCGLibrary.set_pcg_graph_user_parameter', () => {
    expect(header).toMatch(
      /UFUNCTION\(BlueprintCallable, Category = "Hayba\|PCG"\)\s*static FString SetPCGGraphUserParameter\(UPCGGraph\* Graph, FName Name, const FString& StructType, const FString& ValueJson\);/,
    );
  });

  it('finds a struct PCG does not export by path or by name', () => {
    expect(body).toContain('LoadObject<UScriptStruct>(nullptr, *StructType)');
    expect(body).toContain('FindFirstObject<UScriptStruct>(*StructType, EFindFirstObjectOptions::NativeFirst)');
  });

  it('refuses an unknown struct, a type clash or a missing parameter before changing anything', () => {
    const modify = body.indexOf('Graph->Modify();');
    expect(modify).toBeGreaterThan(-1);
    for (const refusal of [
      "no struct '%s'; nothing was changed",
      'already exists with another type; nothing was changed',
      'pass StructType to add it. Nothing was changed',
    ]) {
      expect(body.indexOf(refusal), refusal).toBeGreaterThan(-1);
      expect(body.indexOf(refusal), refusal).toBeLessThan(modify);
    }
  });

  it('adds a missing struct parameter, then writes the value inside UpdateUserParametersStruct', () => {
    expect(body).toContain(
      'Graph->AddUserParameters({ FPropertyBagPropertyDesc(Name, EPropertyBagPropertyType::Struct, Struct) })',
    );
    expect(body).toContain('Graph->UpdateUserParametersStruct([&](FInstancedPropertyBag& Bag)');
    expect(body).not.toContain('GetMutableUserParametersStruct_Unsafe');
  });

  it('names every struct field that did not land instead of calling a partial write a success', () => {
    expect(body).toContain(
      'HaybaReflection::ApplyStructFields(StructProp->Struct, StructProp->ContainerPtrToValuePtr<void>(Memory), Value->AsObject(), &NotApplied);',
    );
    expect(body).toContain('was set except %s');
  });
});
