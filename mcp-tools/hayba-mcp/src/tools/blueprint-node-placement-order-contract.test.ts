/**
 * Story's SEH trip, FoA 2026-11-09 22:55:41: blueprint_add_node spawn_actor_from_class asserted at
 * EdGraphNode.h:586. Hayba called PostPlacedNewNode() before AllocateDefaultPins(), the reverse of UE's palette
 * spawner, and UK2Node_SpawnActorFromClass::PostPlacedNewNode sets its scale-method pin through FindPinChecked.
 * This pins the order at every placement site, and the class_path check spawn_actor_from_class now makes.
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

describe('blueprint nodes get their pins before PostPlacedNewNode', () => {
  it('never calls PostPlacedNewNode on a node without pins', () => {
    expect(bp).not.toMatch(/PostPlacedNewNode\(\);\s*\n\s*Node->AllocateDefaultPins\(\);/);
    expect(bp.match(/Node->AllocateDefaultPins\(\);[^\n]*\n\s*Node->PostPlacedNewNode\(\);/g)?.length).toBe(3);
  });

  it('spawn_actor_from_class refuses a class_path that is not a concrete Actor class before placing', () => {
    const at = bp.indexOf('SpawnClass->IsChildOf(AActor::StaticClass())');
    expect(at).toBeGreaterThan(-1);
    expect(at).toBeLessThan(bp.indexOf('UK2Node* Node = NewObject<UK2Node>(Graph, NodeClass);'));
    expect(bp).toContain('TrySetDefaultObject(*ClassPin, SpawnClass);');
  });
});
