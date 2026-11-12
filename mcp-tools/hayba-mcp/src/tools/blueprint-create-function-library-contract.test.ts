/**
 * UI's BPFL_ItemInspect (2026-11-10): blueprint_create with a BlueprintFunctionLibrary parent made a BPTYPE_Normal
 * Blueprint, so its functions had no world-context pin and a GetActorOfClass inside one failed to compile with
 * "World Context Object must have a connection". The editor's factory makes BPTYPE_FunctionLibrary; so must we.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const bp = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'unreal', 'HaybaMCPToolkit', 'Source',
    'HaybaMCPToolkit', 'Private', 'handlers', 'HaybaMCPBlueprintHandler.cpp'),
  'utf8',
).replace(/\r\n/g, '\n');
const create = bp.slice(bp.indexOf('FHaybaHandlerResult FHaybaMCPBlueprintHandler::Create('),
  bp.indexOf('FHaybaHandlerResult FHaybaMCPBlueprintHandler::', bp.indexOf('FHaybaHandlerResult FHaybaMCPBlueprintHandler::Create(') + 10));

describe('blueprint_create makes a function library a function library', () => {
  it('picks BPTYPE_FunctionLibrary for a BlueprintFunctionLibrary parent', () => {
    expect(create).toContain('ParentClass->IsChildOf(UBlueprintFunctionLibrary::StaticClass())');
    expect(create).toMatch(/\?\s*BPTYPE_FunctionLibrary\s*:\s*BPTYPE_Normal/);
    expect(create).toMatch(/CreateBlueprint\(\s*ParentClass, Package, \*Name, BlueprintType,/);
  });
});
