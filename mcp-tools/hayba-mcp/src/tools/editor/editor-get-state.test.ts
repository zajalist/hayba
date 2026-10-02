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

  it('forwards include_dirty to the native command', async () => {
    ue = scriptedUe().replies('editor_get_state', { ok: true, pie: 'none', dirty_packages_skipped: 'include_dirty' });

    const result = await editorGetStateHandler({ include_dirty: false }, {} as never);

    expect(result.isError).toBeUndefined();
    expect(ue.paramsFor('editor_get_state')).toEqual({ include_dirty: false });
  });

  it('passes the extended state through unchanged', async () => {
    const state = {
      ok: true, map: '/Game/Maps/Main.Main', selection_count: 0, caller_owner: 'lane5',
      pie: 'agent:lane5', pie_running: true, pie_phase: 'running', pie_since_s: 12.5, pie_simulating: false,
      compiling: false, shader_jobs: 0, saving: false, building: [],
      editor_unsafe: false, python_unhealthy: false, health: { editor_unsafe: false },
      dirty_packages: [], dirty_count: 0,
    };
    ue = scriptedUe().replies('editor_get_state', state);

    const result = await editorGetStateHandler({}, {} as never);

    expect(JSON.parse(result.content[0].text)).toEqual(state);
  });

  it('rejects a non-boolean include_dirty without calling the editor', async () => {
    ue = scriptedUe().replies('editor_get_state', { ok: true });

    const result = await editorGetStateHandler({ include_dirty: 'no' }, {} as never);

    expect(result.isError).toBe(true);
    expect(ue.called('editor_get_state')).toBe(false);
  });

  it('rejects an unknown parameter', async () => {
    ue = scriptedUe().replies('editor_get_state', { ok: true });

    const result = await editorGetStateHandler({ includeDirty: false }, {} as never);

    expect(result.isError).toBe(true);
    expect(ue.called('editor_get_state')).toBe(false);
  });
});
