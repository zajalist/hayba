/**
 * Editor-state guards (docs/adr/0012) are named C++ sets and a few load-bearing
 * call orders. This contract keeps them honest without an editor: every name is
 * a real command, no writer hides in a PIE-safe set, the PIE rule fails closed,
 * the hooks are bound where no request can beat them, the PIE state never reads
 * the stale engine flag, the batch holds after its keep-alive, and the handler
 * reads the field its TS schema declares. Hayba.MCP.State.PieSafeDrift checks
 * the sets against the live router. Every check fails closed on a missing file.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { NON_IDEMPOTENT } from '../tool-executor.js';
import { schema as editorGetStateSchema } from '../editor/editor-get-state.js';

const PRIVATE = join(process.cwd(), '../../unreal/HaybaMCPToolkit/Source/HaybaMCPToolkit/Private');
const ROUTER_INLINE = new Set(['hayba_propose_plan', 'ui_memory_set', 'ui_tool_stream', 'ui_tool_stream_new_turn', 'ui_capture_panel']);

function read(rel: string): string {
  const path = join(PRIVATE, rel);
  expect(existsSync(path), `${rel} must exist`).toBe(true);
  return readFileSync(path, 'utf-8');
}

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

function between(src: string, start: string, end: string): string {
  const from = src.indexOf(start);
  expect(from, `'${start}' not found`).toBeGreaterThan(-1);
  const to = src.indexOf(end, from + start.length);
  expect(to, `'${end}' not found after '${start}'`).toBeGreaterThan(from);
  return src.slice(from, to);
}

function setNames(src: string, fn: string): string[] {
  const match = new RegExp(`&\\s*${fn}\\s*\\(\\s*\\)\\s*\\{`).exec(src);
  expect(match, `${fn}() not found`).not.toBeNull();
  const end = src.indexOf('};', match!.index);
  return [...src.slice(match!.index, end).matchAll(/TEXT\("([^"]+)"\)/g)].map((m) => m[1]!);
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

const METASOUND_PRIVATE = join(process.cwd(), '../../unreal/HaybaMCPMetaSound/Source/HaybaMCPMetaSound/Private');

function handlerCommands(): Set<string> {
  const cmds = new Set<string>();
  // The MetaSound satellite registers metasound_inspect and metasound_list, two R-12 reads.
  expect(existsSync(METASOUND_PRIVATE), 'the MetaSound satellite sources must exist').toBe(true);
  const files = [...walk(join(PRIVATE, 'handlers')), ...walk(METASOUND_PRIVATE)].filter(
    (f) => f.endsWith('.cpp') && !f.includes('Tests'),
  );
  expect(files.length).toBeGreaterThan(20);
  for (const f of files) {
    for (const m of readFileSync(f, 'utf-8').matchAll(/TEXT\("([a-z][a-z0-9_]{2,})"\)/g)) cmds.add(m[1]!);
  }
  return cmds;
}

const sets = read('HaybaMCPCommandSets.h');
const policy = read('HaybaMCPEditorStatePolicy.h');
const controlPlane = setNames(sets, 'ControlPlaneCommands');
const reads = setNames(sets, 'ReadCommands');
const observation = setNames(sets, 'PieObservationCommands');
const pieOwner = setNames(policy, 'PieOwnerCommands');
const pieSafe = [...controlPlane, ...reads, ...observation];

describe('editor-state policy names real commands', () => {
  it('parses sets of the expected size', () => {
    expect(controlPlane.length).toBe(20);
    expect(controlPlane).toContain('lease_adopt');
    expect(reads.length).toBeGreaterThanOrEqual(71);
    for (const name of ['wait_for_idle', 'wait_for_shaders', 'asset_validate', 'material_validate', 'mesh_audit', 'mesh_list_dynamic', 'mesh_topology_stats', 'metasound_inspect', 'metasound_list',
      'pcg_export_graph', 'pcg_read_node_output', 'pcg_validate_graph', 'placement_validate', 'scene_export', 'scene_validate_physics', 'texture_audit', 'ui_measure_text', 'copilot_get_key']) {
      expect(reads, `R-12 read ${name}`).toContain(name);
    }
    expect(observation.length).toBe(10);
    expect(pieOwner.length).toBe(8);
  });

  it('every PIE-safe and PIE-owner name is a handler command or router-inline', () => {
    const known = handlerCommands();
    const unknown = [...pieSafe, ...pieOwner].filter((c) => !known.has(c) && !ROUTER_INLINE.has(c));
    expect(unknown.sort()).toEqual([]);
  });
});

describe('no writer hides in a PIE-safe set', () => {
  it('no PIE-safe command is non-idempotent on the Node side', () => {
    expect(pieSafe.filter((c) => NON_IDEMPOTENT.has(c)).sort()).toEqual([]);
  });

  it('no PIE-safe command is Plan-Mode gated', () => {
    const router = read('HaybaMCPCommandHandler.cpp');
    const destructive = between(router, 'static const TSet<FString> DestructiveCommands = {', '};');
    const gated = new Set([...destructive.matchAll(/TEXT\("([^"]+)"\)/g)].map((m) => m[1]!));
    expect(gated.size).toBeGreaterThan(40);
    expect(pieSafe.filter((c) => gated.has(c)).sort()).toEqual([]);
  });

  it('no PIE-safe name reads like a writer', () => {
    const writerWord = /(^|_)(set|add|create|delete|remove|compile|save|spawn|import|rename|duplicate|paint|connect|disconnect|bind|build|mutate|run|start|stop|apply|fix|inject)(_|$)/;
    const allowed = new Set(['ui_memory_set', 'build_status', 'editor_pie_capture_start']);
    expect(pieSafe.filter((c) => writerWord.test(c) && !allowed.has(c)).sort()).toEqual([]);
  });
});

describe('the PIE rule fails closed', () => {
  it('PieRuleFor ends in Refuse and there is no during_pie escape', () => {
    const rule = between(policy, 'inline EPieRule PieRuleFor(', 'struct FPieVerdict');
    expect(rule.trimEnd()).toMatch(/return EPieRule::Refuse;\s*\}\s*$/);
    expect(stripComments(policy)).not.toContain('during_pie');
  });

  it('nobody drives or stops the user PIE', () => {
    expect(between(policy, 'inline FPieVerdict CheckPie(', 'inline FString FormatPieActiveMessage(')).toContain('Pie.Kind == EPieKind::User');
  });
});

describe('PIE state is eager and never reads the stale engine flag', () => {
  it('hooks are bound in StartupModule before the TCP server, in owned children too', () => {
    const module = read('HaybaMCPModule.cpp');
    const startup = module.indexOf('FHaybaMCPEditorState::Get().Startup()');
    expect(startup).toBeGreaterThan(-1);
    expect(startup).toBeLessThan(module.indexOf('const bool bOwnedAutomationChild'));
    const shutdown = between(module, 'void FHaybaMCPModule::ShutdownModule()', 'StopTcpServer();');
    expect(shutdown).toContain('FHaybaMCPEditorState::Get().Shutdown()');
  });

  it('the lazy PIE hooks are gone', () => {
    for (const file of ['handlers/HaybaMCPPIEHandler.h', 'handlers/HaybaMCPPIEHandler.cpp']) {
      const src = stripComments(read(file));
      expect(src).not.toContain('EnsureLifecycleHooks');
      expect(src).not.toContain('bCancelPending');
      expect(src).not.toContain('FEditorDelegates::');
    }
    expect(read('handlers/HaybaMCPPIEHandler.cpp')).toContain('FHaybaMCPEditorState::Get().IsPieActiveOrQueued()');
  });

  it('the resolved state never reads IsPlayingSessionInEditor or IsPlaySessionInProgress', () => {
    const state = stripComments(read('HaybaMCPEditorState.cpp'));
    expect(state).toContain('IsPlaySessionRequestQueued');
    expect(state).not.toContain('IsPlayingSessionInEditor');
    expect(state).not.toContain('IsPlaySessionInProgress');
    const getState = between(read('handlers/HaybaMCPEditorHandler.cpp'), 'FHaybaHandlerResult FHaybaMCPEditorHandler::GetState(', 'FHaybaHandlerResult FHaybaMCPEditorHandler::SaveAllAndQuit(');
    expect(getState).toContain('WritePieJson(Out)');
    expect(stripComments(getState)).not.toContain('IsPlaySessionInProgress');
  });

  it('the authorizer never cancels the play request itself', () => {
    const state = stripComments(read('HaybaMCPEditorState.cpp'));
    expect(state).toContain('RegisterModularFeature(IPIEAuthorizer::GetModularFeatureName()');
    expect(state).toContain('UnregisterModularFeature(IPIEAuthorizer::GetModularFeatureName()');
    expect(state).not.toContain('CancelRequestPlaySession');
  });
});

describe('the router and the batch', () => {
  it('slot 2 authorizes PIE commands past the lease gate (R13)', () => {
    const router = read('HaybaMCPCommandHandler.cpp');
    expect(router).toContain('bPieAuthorized = PieVerdict.bAuthorizedAsPie;');
    expect(router.indexOf('Refusal.Code = TEXT("pie_active")')).toBeLessThan(router.indexOf('if (!bPieAuthorized)'));
    expect(router).toContain('LogPieActiveRefusal(Cmd, Caller, Pie)');
  });

  it('pie_blocked is promoted to a top-level code', () => {
    const router = read('HaybaMCPCommandHandler.cpp');
    expect(between(router, 'static bool IsWireRefusalCode(', 'static FString ShapeOkResponse(')).toContain('TEXT("pie_blocked")');
    expect(between(router, 'static FString ShapeOkResponse(', 'FHaybaMCPCommandHandler::FHaybaMCPCommandHandler()')).toContain('IsWireRefusalCode(DataCode)');
  });

  it('the batch holds for PIE after the lease keep-alive and before the machine ticks', () => {
    const pump = between(read('handlers/HaybaMCPBatchHandler.cpp'), 'bool Pump(', 'TArray<FString> FHaybaMCPBatchHandler::GetCommands');
    const renew = pump.indexOf('Table.Renew(');
    const hold = pump.indexOf('In.bHeld = FHaybaMCPEditorState::Get().IsPieActiveOrQueued()');
    const tick = pump.indexOf('S->Machine->Tick(In)');
    expect(renew).toBeGreaterThan(-1);
    expect(hold).toBeGreaterThan(renew);
    expect(tick).toBeGreaterThan(hold);
    expect(read('HaybaMCPBatchPolicy.h')).toContain('PIE cannot run inside a batch; batches pause during PIE');
  });
});

describe('editor_get_state reads the field its TS schema declares', () => {
  it('include_dirty on both sides, and the router keeps every state field', () => {
    expect(Object.keys(editorGetStateSchema.shape)).toContain('include_dirty');
    expect(read('handlers/HaybaMCPEditorHandler.cpp')).toContain('TryGetBoolField(TEXT("include_dirty"), bIncludeDirty)');
    const limits = between(read('HaybaMCPCommandHandler.cpp'), 'FHaybaResponseLimits Limits', 'FHaybaMCPResponseBuilder Builder');
    expect(limits).toMatch(/Cmd == TEXT\("editor_get_state"\)\)\s*\{[\s\S]*?MaxTopLevelFields = 32;/);
  });
});
