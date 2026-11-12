import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const source = readFileSync(
  join(root, 'unreal', 'HaybaMCPToolkit', 'Source', 'HaybaMCPToolkit', 'Private', 'handlers', 'HaybaMCPBlueprintHandler.cpp'),
  'utf8',
).replace(/\r\n/g, '\n'); // CRLF checkouts (core.autocrlf)
const start = source.indexOf('FHaybaHandlerResult FHaybaMCPBlueprintHandler::AddEvent(');
const addEvent = source.slice(start, source.indexOf('\nFHaybaHandlerResult FHaybaMCPBlueprintHandler::', start + 10));

// UUserWidget::OnKeyDown returns FEventReply, so it cannot be an event node; the only route was
// BlueprintEditorLibrary.add_function_override, banned on Widget Blueprints after the 18:53 crash.
describe('blueprint_add_event implements parent functions with a return value as override graphs', () => {
  it('branches on the event-placeable check before it needs an event graph', () => {
    const branch = addEvent.indexOf('if (!UEdGraphSchema_K2::FunctionCanBePlacedAsEvent(EventFn))');
    expect(branch).toBeGreaterThan(-1);
    expect(branch).toBeLessThan(addEvent.indexOf('HaybaFindGraph(BP, GraphName)'));
  });

  it('builds the graph the way the editor Override menu does, and only once', () => {
    expect(addEvent).toContain('FBlueprintEditorUtils::GetOverrideFunctionClass(BP, EventFn->GetFName(), &OverrideFn)');
    expect(addEvent).toContain('UEdGraphSchema_K2::CanKismetOverrideFunction(OverrideFn)');
    expect(addEvent).toContain('FindObject<UEdGraph>(BP, *EventFn->GetName())');
    expect(addEvent).toContain('FBlueprintEditorUtils::AddFunctionGraph(BP, FnGraph, /*bIsUserCreated*/ false, OverrideClass)');
  });

  it('reports the graph and its entry and result nodes', () => {
    for (const field of ['graph_name', 'entry_node_id', 'result_node_id', 'already_existed']) {
      expect(addEvent).toContain(`TEXT("${field}")`);
    }
  });
});
