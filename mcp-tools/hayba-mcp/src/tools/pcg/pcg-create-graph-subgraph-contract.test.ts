/**
 * A production project, 2026-11-12: pcg_create_graph could not say which graph a Subgraph node runs. That graph
 * lives in SubgraphInstance, an instanced object the generic property path cannot set. Pins the fix:
 * properties.Subgraph on a subgraph node is set through UPCGBaseSubgraphSettings::SetSubgraph, the node's pins are
 * rebuilt from that graph so the spec's edges can reach them, and a value that is not a loadable PCG graph is
 * reported as a property problem.
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

describe('pcg_create_graph Subgraph nodes', () => {
  it('handles properties.Subgraph before the generic property lookup', () => {
    const special = body.indexOf('if (SubgraphSettings && PropName == TEXT("Subgraph"))');
    expect(special).toBeGreaterThan(-1);
    expect(special).toBeLessThan(
      body.indexOf('FProperty* Prop = SettingsClass->FindPropertyByName(FName(*PropName));'),
    );
  });

  it('sets the graph the way the editor does and rebuilds the node pins', () => {
    expect(body).toContain('Cast<UPCGGraphInterface>(HaybaReflection::ResolveObjectRef(Pair.Value))');
    expect(body).toContain('SubgraphSettings->SetSubgraph(Subgraph);');
    expect(body).toContain('NewNode->UpdateAfterSettingsChangeDuringCreation();');
  });

  it('reports a value that is not a loadable PCG graph instead of dropping it', () => {
    expect(body).toContain('not a loadable PCG graph');
  });

  it('tells agents building a spec how to use it', () => {
    expect(getGraphPatterns()).toContain('properties.Subgraph');
  });
});
