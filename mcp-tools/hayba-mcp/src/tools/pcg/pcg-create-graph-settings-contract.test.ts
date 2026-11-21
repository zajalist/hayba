/**
 * A production project, 2026-11-12: pcg_create_graph could not set graph-level settings such as hierarchical
 * generation (bUseHierarchicalGeneration, HiGenGridSize, HiGenGridSizeMultiplier), which runtime scatter graphs need.
 * Pins the fix: "graphSettings" at the graph root (else metadata.graphSettings, where the exporter puts it) is applied
 * to the graph by property name, refusing a name that is not an editable PCGGraph property, and each value goes
 * through the graph's own PostEditChangeChainProperty so HiGen changes reach the generation grid.
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

describe('pcg_create_graph graph settings', () => {
  it('reads graphSettings at the root, else metadata.graphSettings', () => {
    expect(body).toContain('TryGetObjectField(TEXT("graphSettings"), GraphSettingsObj)');
    expect(body).toContain('(*MetadataObj)->TryGetObjectField(TEXT("graphSettings"), GraphSettingsObj);');
  });

  it('only sets editable PCGGraph properties and reports the rest', () => {
    expect(body).toContain('UPCGGraph::StaticClass()->FindPropertyByName(FName(*PropName))');
    expect(body).toContain('!Prop->HasAnyPropertyFlags(CPF_Edit) || Prop->HasAnyPropertyFlags(CPF_EditConst)');
    expect(body).toContain('no such editable property on PCGGraph');
    expect(body).toContain('could not apply the given value to a %s');
  });

  it("runs each change through the graph's own edit handler", () => {
    expect(body).toContain(
      'FPropertyChangedChainEvent Changed(Chain, FPropertyChangedEvent(Prop, EPropertyChangeType::ValueSet));',
    );
    expect(body).toContain('static_cast<UObject*>(NewGraph)->PostEditChangeChainProperty(Changed);');
  });

  it('tells agents building a spec how to use it', () => {
    expect(getGraphPatterns()).toContain('"graphSettings"');
  });
});
