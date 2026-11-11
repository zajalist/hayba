/**
 * a production project story lane, 2026-11-10 18:53: an injected "P" tore PIE down. editor_pie_press_key built its key event with Slate's
 * LIVE modifier state, the user was holding Alt (Alt+Tab), and Alt+P is the editor's RepeatLastPlay chord. Keys also
 * went to whatever held keyboard focus, which can be the level editor's own SViewport. Pins the fix: injected input
 * carries only the modifiers the caller names (default none); keyboard input targets the PIE game viewport by default,
 * focusing it first and refusing when it cannot; editor_get_keyboard_focus reports where input would go.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import { setDefaultSender, type Sender } from '../tool-executor.js';
import { STATIC_TOOL_CATALOGUE } from '../index.js';

const here = dirname(fileURLToPath(import.meta.url));
const handlers = join(here, '..', '..', '..', '..', '..', 'unreal', 'HaybaMCPToolkit', 'Source', 'HaybaMCPToolkit',
  'Private', 'handlers');
const src = readFileSync(join(handlers, 'HaybaMCPPIEHandler.cpp'), 'utf8').replace(/\r\n/g, '\n');
const code = src.replace(/\/\/.*$/gm, '');
const fn = (name: string) => code.slice(code.indexOf(name), code.indexOf('\n}\n', code.indexOf(name)));
const sidecar = JSON.parse(readFileSync(join(here, '..', '..', 'legacy-commands', 'sidecar.json'), 'utf8')) as {
  commands: Record<string, { has_ts_wrapper: boolean; agent_callable: boolean; params: Array<{ name: string }> }>;
};

describe('injected PIE input never reads the live keyboard', () => {
  it('no injector builds an event from the OS modifier state', () => {
    expect(code).not.toContain('GetModifierKeys()');
  });

  it('key, character and pointer events carry the explicit modifiers', () => {
    expect(fn('bool SendKeyThroughSlate(const FKey& Key, EInputEvent Evt, const FModifierKeysState& Mods)\n')).toMatch(/FKeyEvent KeyEvent\(\s*Key,\s*Mods,/);
    expect(fn('bool SendCharThroughSlate(')).toMatch(/FCharacterEvent CharEvent\(\s*C,\s*Mods,/);
    expect(code).toContain('bool SendKeyThroughSlate(const FKey& Key, EInputEvent Evt, const FModifierKeysState& Mods = FModifierKeysState());');
  });

  for (const [name, cmd] of [
    ['FHaybaHandlerResult FHaybaMCPPIEHandler::PIEPressKey(', 'editor_pie_press_key'],
    ['FHaybaHandlerResult FHaybaMCPPIEHandler::PIETypeText(', 'editor_pie_type_text'],
    ['FHaybaHandlerResult FHaybaMCPPIEHandler::PIEMouse(', 'editor_pie_mouse'],
  ] as const) {
    it(`${cmd} takes modifiers explicitly`, () => {
      expect(fn(name)).toContain(`ParseInjectedModifiers(P, TEXT("${cmd}"), Mods, ModsEcho, InputError)`);
      expect(sidecar.commands[cmd].params.map((p) => p.name)).toContain('modifiers');
    });
  }

  it('the press and its deferred release both use them', () => {
    const press = fn('FHaybaHandlerResult FHaybaMCPPIEHandler::PIEPressKey(');
    expect(press).toContain('auto SendNow = [DeviceId, Key, SlateHandled, Mods](EInputEvent Evt) -> bool');
    expect(press).toContain('SendKeyThroughSlate(Key, Evt, Mods)');
  });
});

describe('keyboard input targets the PIE game viewport', () => {
  const resolve = fn('bool ResolveKeyTarget(');

  it('defaults to pie, focuses the game viewport, and refuses when focus does not land there', () => {
    expect(resolve).toContain('FString Target = TEXT("pie");');
    expect(resolve).toContain('Slate.SetKeyboardFocus(VP, EFocusCause::SetDirectly);');
    expect(resolve).toContain('did not take keyboard focus');
    expect(resolve).toContain('no PIE viewport (start PIE first). Nothing was sent.');
    expect(resolve).toContain('PIEViewportIdentity(Client)');
  });

  for (const [name, cmd] of [
    ['FHaybaHandlerResult FHaybaMCPPIEHandler::PIEPressKey(', 'editor_pie_press_key'],
    ['FHaybaHandlerResult FHaybaMCPPIEHandler::PIETypeText(', 'editor_pie_type_text'],
  ] as const) {
    it(`${cmd} resolves its target before sending anything`, () => {
      const body = fn(name);
      expect(body).toContain(`ResolveKeyTarget(P, TEXT("${cmd}"),`);
      expect(body.indexOf('ResolveKeyTarget(')).toBeLessThan(body.indexOf(cmd === 'editor_pie_press_key' ? 'SendNow(IE_Pressed)' : 'SendCharThroughSlate(C, Mods)'));
    });
  }

  it('editor_get_keyboard_focus reports the focused widget and whether it is the PIE viewport', () => {
    expect(code).toContain('TEXT("editor_get_keyboard_focus"),');
    expect(code).toContain('if (Cmd == TEXT("editor_get_keyboard_focus")) return GetKeyboardFocus(Params);');
    const body = fn('FHaybaHandlerResult FHaybaMCPPIEHandler::GetKeyboardFocus(');
    expect(body).toContain('TEXT("is_pie_viewport")');
    expect(body).toContain('TEXT("in_pie_viewport")');
    expect(body).toContain('TEXT("widget_path")');
    expect(sidecar.commands['editor_get_keyboard_focus']).toMatchObject({ agent_callable: true, has_ts_wrapper: false });
  });
});

describe('the MCP tools forward modifiers and target', () => {
  const calls: Array<{ cmd: string; params: Record<string, unknown> }> = [];
  beforeEach(() => {
    calls.length = 0;
    setDefaultSender((async (cmd: string, params: Record<string, unknown>) => {
      calls.push({ cmd, params });
      return { id: 'inmem', ok: true, data: { ok: true } };
    }) as Sender);
  });
  const tool = (name: string) => STATIC_TOOL_CATALOGUE.find((d) => d.name === name)!;

  it('editor_pie_press_key sends target pie by default and modifiers only when given', async () => {
    await tool('editor_pie_press_key').handler({ key: 'P' }, undefined as never);
    await tool('editor_pie_press_key').handler({ key: 'S', modifiers: ['ctrl'] }, undefined as never);
    expect(calls[0].params).toMatchObject({ key: 'P', target: 'pie' });
    expect(calls[0].params).not.toHaveProperty('modifiers');
    expect(calls[1].params).toMatchObject({ key: 'S', modifiers: ['ctrl'], target: 'pie' });
  });

  it('editor_pie_type_text and editor_pie_mouse forward them too', async () => {
    await tool('editor_pie_type_text').handler({ text: 'hi', target: 'focused' }, undefined as never);
    await tool('editor_pie_mouse').handler({ action: 'click', x: 1, y: 2, modifiers: ['shift'] }, undefined as never);
    expect(calls[0].params).toMatchObject({ text: 'hi', target: 'focused' });
    expect(calls[1].params).toMatchObject({ action: 'click', modifiers: ['shift'] });
  });

  it('editor_get_keyboard_focus is surfaced as a read-only tool', async () => {
    await tool('editor_get_keyboard_focus').handler({}, undefined as never);
    expect(calls[0].cmd).toBe('editor_get_keyboard_focus');
  });
});
