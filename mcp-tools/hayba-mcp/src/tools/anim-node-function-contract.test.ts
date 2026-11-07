import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getSidecar } from '../legacy-commands/index.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const cpp = (...parts: string[]) =>
  readFileSync(join(root, 'unreal', 'HaybaMCPToolkit', 'Source', 'HaybaMCPToolkit', 'Private', ...parts), 'utf8')
    .replace(/\r\n/g, '\n'); // CRLF checkouts (core.autocrlf)
const anim = cpp('handlers', 'HaybaMCPAnimationHandler.cpp');
const blueprint = cpp('handlers', 'HaybaMCPBlueprintHandler.cpp');
const commandHandler = cpp('HaybaMCPCommandHandler.cpp');

function body(source: string, qualifiedName: string): string {
  const start = source.indexOf(`FHaybaHandlerResult ${qualifiedName}(`);
  expect(start, `${qualifiedName} not found`).toBeGreaterThan(-1);
  const next = source.indexOf('\nFHaybaHandlerResult ', start + 10);
  return source.slice(start, next === -1 ? undefined : next);
}

// Every parameter the sidecar documents must be one the C++ actually reads, or agents send keys that do nothing.
function expectSidecarParamsRead(command: string, handlerBody: string) {
  const entry = getSidecar().commands[command];
  expect(entry, `${command} has no sidecar entry`).toBeDefined();
  expect(entry.agent_callable).toBe(true);
  for (const p of entry.params) expect(handlerBody, `${command}.${p.name} is never read`).toContain(`TEXT("${p.name}")`);
}

describe('anim node functions (a production project restart 6)', () => {
  it('dispatches the three new anim commands', () => {
    for (const cmd of ['anim_blueprint_add_node_function', 'anim_graph_node_bind_function', 'blendspace_set_samples']) {
      expect(anim.match(new RegExp(`TEXT\\("${cmd}"\\)`, 'g'))?.length ?? 0).toBeGreaterThanOrEqual(3); // list, PIE guard, dispatch
    }
  });

  it('creates node functions the way the editor Create Binding does', () => {
    const add = body(anim, 'FHaybaMCPAnimationHandler::AddNodeFunction');
    expect(anim).toContain('AnimExecutionContextLibrary.Prototype_ThreadSafeAnimUpdateCall');
    expect(add).toContain('FindObject<UFunction>(nullptr, GHaybaAnimUpdatePrototype)');
    expect(add).toContain('FBlueprintEditorUtils::AddFunctionGraph(BP, Graph, /*bIsUserCreated*/ true, Prototype)');
    expect(add).toContain('Entry->MetaData.bThreadSafe = true');
    expectSidecarParamsRead('anim_blueprint_add_node_function', add);
  });

  it('refuses a binding the compiler would reject, before changing anything', () => {
    const bind = body(anim, 'FHaybaMCPAnimationHandler::BindNodeFunction');
    const check = bind.indexOf('Prototype->IsSignatureCompatibleWith(Fn)');
    expect(check).toBeGreaterThan(-1);
    expect(bind).toContain('FBlueprintEditorUtils::HasFunctionBlueprintThreadSafeMetaData(Fn)');
    expect(check).toBeLessThan(bind.indexOf('Node->Modify()'));
    expect(bind).toContain('Ref->SetFromField<UFunction>(Fn, bSelfContext)');
    expectSidecarParamsRead('anim_graph_node_bind_function', bind);
  });

  it('validates every blend space sample before the first edit', () => {
    const set = body(anim, 'FHaybaMCPAnimationHandler::BlendSpaceSetSamples');
    expect(set.indexOf('IsAnimationCompatibleWithSkeleton')).toBeLessThan(set.indexOf('BS->Modify()'));
    expect(set).toContain('BS->ResampleData()');
    expectSidecarParamsRead('blendspace_set_samples', set);
  });
});

describe('blueprint_add_function declares anim-node-compatible functions', () => {
  const add = body(blueprint, 'FHaybaMCPBlueprintHandler::AddFunction');
  it('takes thread_safe and const-by-ref inputs', () => {
    expect(add).toContain('Entry->MetaData.bThreadSafe = bThreadSafe');
    expect(add).toContain('Param.Type.bIsReference = bByRef');
    expect(add).toContain('Param.Type.bIsConst = bConstParam');
    expect(add).toContain('TEXT("by_ref")');
    expectSidecarParamsRead('blueprint_add_function', add);
  });
});

describe('graph reads page under the reply cap', () => {
  it('never pages more than the command layer returns', () => {
    const cap = Number(/Limits\.MaxArrayItems = (\d+);/.exec(commandHandler)?.[1]);
    const page = Number(/HaybaGraphPageMax = (\d+);/.exec(blueprint)?.[1]);
    expect(cap).toBeGreaterThan(0);
    expect(page).toBeGreaterThan(0);
    expect(page).toBeLessThanOrEqual(cap);
  });

  it('pages blueprint_inspect_graph nodes and edges and reports pin defaults', () => {
    const inspect = body(blueprint, 'FHaybaMCPBlueprintHandler::InspectGraph');
    expect(inspect).toContain('Out->SetObjectField(TEXT("page"), Page)');
    expect(blueprint).toContain('TEXT("default_value"), Pin->DefaultValue');
    expectSidecarParamsRead('blueprint_inspect_graph', inspect);
  });

  it('pages blueprint_measure_nodes', () => {
    const measure = body(blueprint, 'FHaybaMCPBlueprintHandler::MeasureNodes');
    expect(measure).toContain('Out->SetObjectField(TEXT("page"), Page)');
    expectSidecarParamsRead('blueprint_measure_nodes', measure);
  });
});
