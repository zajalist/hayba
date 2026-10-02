import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getSidecar } from '../legacy-commands/index.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const privateDir = join(root, 'unreal', 'HaybaMCPToolkit', 'Source', 'HaybaMCPToolkit', 'Private');
const source = readFileSync(join(privateDir, 'handlers', 'HaybaMCPBlueprintHandler.cpp'), 'utf8');
const commandHandler = readFileSync(join(privateDir, 'HaybaMCPCommandHandler.cpp'), 'utf8');

/** The body of a C++ brace-initialised set, from its declaration to the closing `};`. */
function setLiteral(src: string, declaration: string): string {
  const start = src.indexOf(declaration);
  expect(start, `${declaration} not found — was it renamed?`).toBeGreaterThan(-1);
  const end = src.indexOf('};', start);
  expect(end, `${declaration} is unterminated`).toBeGreaterThan(start);
  return src.slice(start, end);
}

function textLiterals(block: string): string[] {
  return [...block.matchAll(/TEXT\("([^"]+)"\)/g)].map((m) => m[1]);
}

describe('Blueprint event-graph authoring contract', () => {
  it('exports exact nodes, pins and edges before mutation', () => {
    expect(source).toContain('blueprint_inspect_graph');
    expect(source).toContain('HaybaDescribeNode(Node)');
    expect(source).toContain('Linked->GetOwningNode()->NodeGuid');
  });

  it.each(['branch', 'select', 'timer_by_function', 'call_function', 'sequence', 'self', 'create_widget'])(
    'supports %s nodes', (kind) => expect(source).toContain(`TEXT("${kind}")`),
  );

  // The sidecar description is the only place an agent learns which node kinds
  // exist. Two copies of one list drift; parse the real set so they cannot.
  it('documents every node kind the handler accepts', () => {
    const kinds = textLiterals(setLiteral(source, 'static const TSet<FString> SupportedNodeTypes'));
    expect(kinds.length).toBeGreaterThanOrEqual(7);
    const nodeType = getSidecar().commands['blueprint_add_node']?.params.find((p) => p.name === 'node_type');
    for (const kind of kinds) expect(nodeType?.description ?? '').toContain(kind);
  });

  describe('events, signatures and removal', () => {
    it.each([
      ['blueprint_add_custom_event', 'AddCustomEvent'],
      ['blueprint_add_bound_event', 'AddBoundEvent'],
      ['blueprint_remove_node', 'RemoveNode'],
    ])('advertises and routes %s', (cmd, fn) => {
      expect(textLiterals(setLiteral(source, 'FHaybaMCPBlueprintHandler::GetCommands() const'))).toContain(cmd);
      expect(source).toMatch(new RegExp(`if \\(Cmd == TEXT\\("${cmd}"\\)\\)\\s*return ${fn}\\(P\\);`));
    });

    it('binds a widget or component delegate with the engine bound-event node, once', () => {
      expect(source).toContain('InitializeComponentBoundEventParams');
      // A second bind must return the existing node, not stack a duplicate that
      // fails the compile with "event already bound".
      expect(source).toContain('FKismetEditorUtilities::FindBoundEventForComponent');
    });

    it('gives custom events and functions typed pins through the editable-pin API', () => {
      expect(source).toContain('UK2Node_CustomEvent');
      expect(source).toContain('CreateUserDefinedPin');
      expect(source).toContain('FBlueprintEditorUtils::FindOrCreateFunctionResultNode');
      expect(source).toContain('FUNC_BlueprintPure');
    });

    it('verifies a variable default on the class default object', () => {
      // FBPVariableDescription::DefaultValue is emptied once the compile moves the
      // default onto the CDO, so reading it back always failed — found live by
      // scripts/probe-blueprint-authoring.mjs. The CDO is where the value lives.
      const start = source.indexOf('FHaybaHandlerResult FHaybaMCPBlueprintHandler::AddVariable(');
      const next = source.indexOf('\nFHaybaHandlerResult FHaybaMCPBlueprintHandler::', start + 1);
      const body = source.slice(start, next);
      expect(body).toContain('GetDefaultObject');
      expect(body).toContain('->Identical(');
    });

    it('creates a real function library when the parent is BlueprintFunctionLibrary', () => {
      expect(source).toContain('BPTYPE_FunctionLibrary');
    });

    it('never deletes the nodes a function graph cannot live without', () => {
      // Scoped to the RemoveNode body: AddFunction names the same node classes,
      // so a whole-file match would pass with the guard missing.
      const start = source.indexOf('FHaybaHandlerResult FHaybaMCPBlueprintHandler::RemoveNode(');
      expect(start, 'RemoveNode handler not found').toBeGreaterThan(-1);
      const next = source.indexOf('\nFHaybaHandlerResult FHaybaMCPBlueprintHandler::', start + 1);
      const body = source.slice(start, next === -1 ? undefined : next);
      expect(body).toContain('FBlueprintEditorUtils::RemoveNode');
      expect(body).toContain('UK2Node_FunctionEntry');
      expect(body).toContain('UK2Node_FunctionResult');
      // The guard must run before the delete, or it guards nothing.
      expect(body.indexOf('UK2Node_FunctionEntry')).toBeLessThan(body.indexOf('FBlueprintEditorUtils::RemoveNode'));
    });

    it('puts every new mutation behind the broken-blueprint compile gate', () => {
      const gated = textLiterals(setLiteral(source, 'static const TSet<FString> MutatingCommands'));
      for (const cmd of ['blueprint_add_custom_event', 'blueprint_add_bound_event', 'blueprint_remove_node']) {
        expect(gated).toContain(cmd);
      }
    });

    it('wraps every event-authoring mutation in an undoable, plan-gated transaction', () => {
      const destructive = textLiterals(setLiteral(commandHandler, 'static const TSet<FString> DestructiveCommands'));
      for (const cmd of ['blueprint_add_event', 'blueprint_add_custom_event', 'blueprint_add_bound_event', 'blueprint_remove_node']) {
        expect(destructive).toContain(cmd);
      }
    });
  });

  it('uses schema-checked pin connections and defaults', () => {
    expect(source).toContain('Schema->CanCreateConnection');
    expect(source).toContain('Schema->TryCreateConnection');
    expect(source).toContain('Schema->TrySetDefaultValue');
  });

  it('saves only after a clean explicit compile', () => {
    expect(source).toMatch(/if \(bOk && bSave\)[\s\S]*HaybaSaveVerify::SaveAndVerify\(BP\)/);
  });
});
