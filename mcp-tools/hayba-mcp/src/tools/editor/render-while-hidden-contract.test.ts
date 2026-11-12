/**
 * A production project, 2026-11-10: lane PIE bursts ran at 3 fps whenever the user minimized the editor. UEditorEngine::ShouldThrottleCPUUsage
 * throttles while AreAllWindowsHidden() even with bThrottleCPUWhenNotForeground off, and GetMaxTickRate then returns 3.
 * The engine's own way out is a ShouldDisableCPUThrottlingDelegates entry. editor_set_render_while_hidden {allow}
 * registers one while any owner holds it and removes it when the last owner lets go, so two lanes bursting at once do
 * not switch each other off. Default off, logged, never left behind by the handler.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import { setDefaultSender, type Sender } from '../tool-executor.js';
import { STATIC_TOOL_CATALOGUE } from '../index.js';

const priv = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..', 'unreal', 'HaybaMCPToolkit',
  'Source', 'HaybaMCPToolkit', 'Private');
const read = (...p: string[]) => readFileSync(join(priv, ...p), 'utf8').replace(/\r\n/g, '\n');
const editor = read('handlers', 'HaybaMCPEditorHandler.cpp');
const header = read('handlers', 'HaybaMCPEditorHandler.h');
const commands = read('HaybaMCPCommandHandler.cpp');
const fn = (src: string, name: string) => src.slice(src.indexOf(name), src.indexOf('\n}\n', src.indexOf(name)));
const body = fn(editor, 'FHaybaHandlerResult FHaybaMCPEditorHandler::SetRenderWhileHidden(');
const sidecar = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'legacy-commands',
  'sidecar.json'), 'utf8')) as { commands: Record<string, { has_ts_wrapper: boolean; agent_callable: boolean }> };

describe('editor_set_render_while_hidden', () => {
  it('is a registered, plan-gated command surfaced from the sidecar', () => {
    expect(editor).toContain('TEXT("editor_set_render_while_hidden")');
    expect(editor).toContain('if (Cmd == TEXT("editor_set_render_while_hidden")) return SetRenderWhileHidden(Params);');
    expect(commands).toContain('TEXT("editor_set_render_while_hidden")');
    expect(sidecar.commands['editor_set_render_while_hidden']).toMatchObject({ has_ts_wrapper: false, agent_callable: true });
  });

  it('takes allow only and refuses anything else before changing state', () => {
    expect(body).toContain('HaybaUnknownParamsError(P, TEXT("editor_set_render_while_hidden"), { TEXT("allow") })');
    expect(body).toContain('TryGetBoolField(TEXT("allow"), bAllow)');
  });

  it('holds per owner, so one lane letting go does not throttle another', () => {
    expect(body).toContain('FHaybaMCPLeaseManager::Get().EffectiveOwner()');
    expect(body).toContain('RenderWhileHiddenHolders.Add(Owner)');
    expect(body).toContain('RenderWhileHiddenHolders.Remove(Owner)');
  });

  it('registers the engine throttle override while held and removes exactly its own entry when not', () => {
    const remove = fn(editor, 'static void RemoveThrottleOverride(');
    expect(body).toContain('GEditor->ShouldDisableCPUThrottlingDelegates.Add(');
    expect(body).toContain('RemoveThrottleOverride(RenderWhileHiddenHandle)');
    expect(remove).toContain('GEditor->ShouldDisableCPUThrottlingDelegates.RemoveAll(');
    expect(remove).toContain('GetHandle() == Handle');
    expect(body).toContain('UE_LOG(LogHaybaMCPEditor, Log,');
    expect(body).toContain('GEditor->ShouldThrottleCPUUsage()');
  });

  it('starts off and never outlives the handler', () => {
    expect(header).toContain('TSet<FString> RenderWhileHiddenHolders;');
    expect(header).toContain('FDelegateHandle RenderWhileHiddenHandle;');
    expect(fn(editor, 'FHaybaMCPEditorHandler::~FHaybaMCPEditorHandler()')).toContain('RemoveThrottleOverride(RenderWhileHiddenHandle)');
  });
});

describe('the MCP tool', () => {
  const calls: Array<{ cmd: string; params: Record<string, unknown> }> = [];
  beforeEach(() => {
    calls.length = 0;
    setDefaultSender((async (cmd: string, params: Record<string, unknown>) => {
      calls.push({ cmd, params });
      return { id: 'inmem', ok: true, data: { ok: true } };
    }) as Sender);
  });

  it('sends allow', async () => {
    const tool = STATIC_TOOL_CATALOGUE.find((d) => d.name === 'editor_set_render_while_hidden')!;
    await tool.handler({ allow: true }, undefined as never);
    expect(calls).toEqual([{ cmd: 'editor_set_render_while_hidden', params: { allow: true } }]);
  });
});
