/**
 * A production project, 2026-11-12: Hayba's JSON property setter refused soft object references, so a Load Data Table
 * node's DataTable (TSoftObjectPtr) came back from pcg_create_graph as "could not apply the given value", and a
 * struct holding a soft reference (a virtual texture to prime) dropped that field while the rest applied. Hard
 * references worked. Pins the fix: every object-reference property kind goes through the same resolve-and-type-check
 * path, so a bad path is still refused rather than stored.
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
  'unreal',
  'HaybaMCPToolkit',
  'Source',
  'HaybaMCPToolkit',
);
const read = (...p: string[]) => readFileSync(join(source, ...p), 'utf8').replace(/\r\n/g, '\n');
const header = read('Public', 'HaybaMCPReflection.h');
const objectBranch = header.slice(header.indexOf('CastField<FObjectPropertyBase>(Prop)'));

describe('HaybaReflection::SetValueFromJson object references', () => {
  it('handles every object-reference kind, soft, weak and lazy included', () => {
    expect(header).toContain('if (FObjectPropertyBase* O = CastField<FObjectPropertyBase>(Prop))');
    expect(header).not.toContain('CastField<FObjectProperty>(Prop)');
  });

  it('still refuses a reference that does not resolve or has the wrong type', () => {
    expect(objectBranch).toContain('UObject* Obj = ResolveObjectRef(V);');
    expect(objectBranch).toContain('if (!Obj || !Obj->IsA(O->PropertyClass)) return false;');
  });

  it('is the path pcg_create_graph node properties take', () => {
    expect(read('Private', 'handlers', 'HaybaMCPLegacyHandler.cpp')).toContain(
      'HaybaReflection::SetValueFromJson(Prop, Settings, Pair.Value, Settings)',
    );
  });
});
