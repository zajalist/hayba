import { afterEach, describe, expect, it } from 'vitest';
import { scriptedUe, type ScriptedUe } from '../testing/scripted-ue.js';
import { editorGetStateHandler } from './editor-get-state.js';

let ue: ScriptedUe | undefined;
afterEach(() => {
  ue?.restore();
  ue = undefined;
});

describe('editor_get_state native wrapper', () => {
  it('dispatches the native command without python_run or dynamic getattr', async () => {
    ue = scriptedUe().replies('editor_get_state', {
      ok: true,
      map: '/Game/Maps/Main.Main',
      pie_running: false,
      selection_count: 0,
      dirty_packages: [],
      dirty_count: 0,
    });

    const result = await editorGetStateHandler({}, {} as never);

    expect(result.isError).toBeUndefined();
    expect(ue.called('editor_get_state')).toBe(true);
    expect(ue.called('python_run')).toBe(false);
    expect(JSON.stringify(ue.calls)).not.toContain('getattr(');
    expect(JSON.parse(result.content[0].text)).toMatchObject({
      map: '/Game/Maps/Main.Main',
      pie_running: false,
      dirty_count: 0,
    });
  });

  it('surfaces native refusal without falling back to python_run', async () => {
    ue = scriptedUe().fails('editor_get_state', 'GEditor is not available');

    const result = await editorGetStateHandler({}, {} as never);

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('GEditor is not available');
    expect(ue.called('python_run')).toBe(false);
  });
});
