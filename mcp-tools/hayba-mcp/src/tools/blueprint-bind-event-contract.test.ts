/**
 * A production project, 2026-11-12: a HUD widget could not bind runtime delegates (a subsystem's OnMessage, a
 * component's OnHealthChanged, a game state's OnPhaseChanged). blueprint_add_node and blueprint_graph_batch had no
 * "Bind Event to X" node, so pushed events could only be polled. Pins the fix: node_type bind_event / unbind_event
 * places UK2Node_AddDelegate / UK2Node_RemoveDelegate for a multicast delegate on class_path (default this Blueprint),
 * and with event_name links that custom event to the node's Delegate pin, creating it from the delegate's signature
 * for bind_event, the way the editor's "Create Event" does. Every refusal happens before anything is placed.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { STATIC_TOOL_CATALOGUE } from './index.js';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(
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
    'handlers',
    'HaybaMCPBlueprintHandler.cpp',
  ),
  'utf8',
).replace(/\r\n/g, '\n');
const addNode = src.slice(
  src.indexOf('FHaybaHandlerResult FHaybaMCPBlueprintHandler::AddNode('),
  src.indexOf('\n}\n', src.indexOf('FHaybaHandlerResult FHaybaMCPBlueprintHandler::AddNode(')),
);
const block = addNode.slice(addNode.indexOf('if (NodeType == TEXT("bind_event") || NodeType == TEXT("unbind_event"))'));
const placed = block.indexOf('FHaybaHandlerResult Placed = Place(Node);');
const sidecar = JSON.parse(readFileSync(join(here, '..', 'legacy-commands', 'sidecar.json'), 'utf8')) as {
  commands: Record<string, { params: Array<{ name: string; description?: string }> }>;
};

describe('blueprint_add_node bind_event / unbind_event', () => {
  it('is a supported node type, reachable from blueprint_graph_batch through AddNode', () => {
    expect(addNode).toContain('TEXT("bind_event"), TEXT("unbind_event"),');
    expect(src).toContain('if      (Step.Command == TEXT("blueprint_add_node"))        Res = AddNode(Step.Params);');
  });

  it('takes delegate_name, falling back to dispatcher_name', () => {
    expect(addNode).toContain('ParamR.OptionalString(TEXT("delegate_name"), DispatcherName)');
  });

  it('finds the multicast delegate on class_path (default this Blueprint) and refuses before placing anything', () => {
    expect(block).toContain('UClass* Owner = ClassPath.IsEmpty() ? Scope : LoadObject<UClass>(nullptr, *ClassPath);');
    expect(block).toContain('FindFProperty<FMulticastDelegateProperty>(Owner, FName(*DelegateName))');
    for (const refusal of [
      "is not one on '%s'. Nothing was changed.",
      "unbind_event: no custom event '%s' to unbind. Nothing was changed.",
      'goes in the event graph that holds (or will hold)',
      'is already a graph/function name on this Blueprint',
    ]) {
      const at = block.indexOf(refusal);
      expect(at, refusal).toBeGreaterThan(-1);
      expect(at, refusal).toBeLessThan(placed);
    }
  });

  it('places AddDelegate for bind and RemoveDelegate for unbind, self-context only for its own delegates', () => {
    expect(block).toContain('NewObject<UK2Node_AddDelegate>(Graph)');
    expect(block).toContain('NewObject<UK2Node_RemoveDelegate>(Graph)');
    expect(block).toContain(
      'Node->SetFromProperty(Delegate, Scope && Scope->IsChildOf(Delegate->GetOwnerClass()), Delegate->GetOwnerClass());',
    );
  });

  it('creates the event from the delegate signature when missing and links its Delegate pin', () => {
    expect(block).toContain('UK2Node_CustomEvent::CreateFromFunction(');
    expect(block).toContain('Delegate->SignatureFunction, /*bSelectNewNode=*/false)');
    expect(block).toContain('Event->FindPin(UK2Node_Event::DelegateOutputName)');
    expect(block).toContain('TryCreateConnection(EventPin, Node->GetDelegatePin())');
  });

  it('reports the event, whether it linked, and why not', () => {
    expect(block).toContain('Placed.Data->SetObjectField(TEXT("event"), HaybaDescribeNode(Event));');
    expect(block).toContain('Placed.Data->SetBoolField(TEXT("event_linked"), bLinked);');
    expect(block).toContain('TEXT("event_link_error")');
  });
});

describe('the MCP tool', () => {
  it('documents the node types and declares delegate_name', () => {
    const params = sidecar.commands['blueprint_add_node'].params;
    expect(params.find((p) => p.name === 'node_type')?.description).toContain('bind_event, unbind_event');
    expect(params.map((p) => p.name)).toContain('delegate_name');
  });

  it('accepts a bind_event call under the strict parse hayba_invoke applies', () => {
    const tool = STATIC_TOOL_CATALOGUE.find((d) => d.name === 'blueprint_add_node')!;
    const strict = z.object(tool.schema).strict();
    const call = { path: '/Game/UI/WBP_Hud', node_type: 'bind_event', class_path: '/Script/Game.GameUISubsystem' };
    expect(strict.safeParse({ ...call, delegate_name: 'OnMessage', event_name: 'HandleMessage' }).success).toBe(true);
    expect(strict.safeParse({ ...call, dispatcher_name: 'OnMessage' }).success).toBe(true);
  });
});
