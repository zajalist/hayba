/**
 * A production project, 2026-11-12: in a pcg_create_graph spec, "MeshSelectorType": "PCGMeshSelectorByAttribute" on
 * a Static Mesh Spawner was written straight into the TSubclassOf property, leaving the old instanced selector in
 * place: the node said ByAttribute but ran the weighted selector. The selector and packer settings themselves
 * (AttributeName, TemplateDescriptor, AttributeSelectors) live on those instanced objects, which the generic path
 * cannot reach. Pins the fix: the two *Type keys go through SetMeshSelectorType / SetInstancePackerType first, the
 * *Parameters objects then fill the new instances field by field, every miss is reported, and the generic loop skips
 * the four keys.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { getGraphPatterns } from '../../graph-patterns.js';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(
  join(
    here,
    '..',
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
    'HaybaMCPLegacyHandler.cpp',
  ),
  'utf8',
).replace(/\r\n/g, '\n');
const start = src.indexOf('FHaybaHandlerResult FHaybaMCPLegacyHandler::Cmd_CreateGraph(');
const body = src.slice(start, src.indexOf('\n}\n', start));
const genericLoop = body.indexOf('for (const auto& Pair : PropsObj->Values)');

describe('pcg_create_graph Static Mesh Spawner selector and packer', () => {
  it('sets the types through the engine setters before the generic loop', () => {
    const typed = body.indexOf('Spawner->SetMeshSelectorType(Type);');
    expect(typed).toBeGreaterThan(-1);
    expect(typed).toBeLessThan(genericLoop);
    expect(body).toContain('else Spawner->SetInstancePackerType(Type);');
  });

  it('only accepts a concrete class of the property meta class', () => {
    expect(body).toContain('CastField<FClassProperty>(SettingsClass->FindPropertyByName(TypeKey))');
    expect(body).toContain('!Type->IsChildOf(TypeProp->MetaClass)');
    expect(body).toContain('Type->HasAnyClassFlags(CLASS_Abstract)');
    expect(body).toContain('is not a concrete %s class');
  });

  it('fills the new instances field by field and reports every miss', () => {
    expect(body).toContain('static_cast<UObject*>(Spawner->MeshSelectorParameters)');
    expect(body).toContain('static_cast<UObject*>(Spawner->InstanceDataPackerParameters)');
    expect(body).toContain('HaybaReflection::SetProp(Instanced, FieldName, Field.Value)');
    expect(body).toContain('needs an object of fields for the node');
    expect(body).toContain('could not apply to a %s');
  });

  it('keeps the generic loop from writing the four keys again', () => {
    const skip = body.indexOf("continue; // applied above, through the engine's setters");
    expect(skip).toBeGreaterThan(genericLoop);
    expect(skip).toBeLessThan(body.indexOf('HaybaReflection::SetValueFromJson(Prop, Settings, Pair.Value, Settings)'));
  });

  it('tells agents building a spec how to use it', () => {
    expect(getGraphPatterns()).toContain('"MeshSelectorParameters"');
  });
});
