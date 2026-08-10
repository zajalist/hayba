import { afterEach, describe, expect, it } from 'vitest';
import { scriptedUe, type ScriptedUe } from '../testing/scripted-ue.js';
import { editorSaveAllAndQuitHandler } from './editor-save-all-and-quit.js';

const verified = (quit: boolean) => ({
  dirty_package_count_before: 2,
  dirty_package_count_after: 0,
  save_candidate_count: 2,
  save_verified: true,
  quit_scheduled: quit,
});

describe('editor_save_all_and_quit', () => {
  let ue: ScriptedUe | undefined;
  afterEach(() => ue?.restore());

  it('routes save+quit through the single native command', async () => {
    ue = scriptedUe().replies('editor_save_all_and_quit', verified(true));
    const result = await editorSaveAllAndQuitHandler({}, {} as never);
    expect(result.isError).not.toBe(true);
    expect(ue.paramsFor('editor_save_all_and_quit')).toEqual({ quit: true });
    expect(ue.called('python_run')).toBe(false);
  });

  it('quit:false uses the same native persistence boundary without exit', async () => {
    ue = scriptedUe().replies('editor_save_all_and_quit', verified(false));
    const result = await editorSaveAllAndQuitHandler({ quit: false }, {} as never);
    expect(result.isError).not.toBe(true);
    expect(ue.paramsFor('editor_save_all_and_quit')).toEqual({ quit: false });
  });

  it('fails closed on missing verification fields', async () => {
    ue = scriptedUe().silentlySucceeds('editor_save_all_and_quit');
    const result = await editorSaveAllAndQuitHandler({}, {} as never);
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('incomplete or contradictory');
  });

  it('fails closed when native verification is contradictory', async () => {
    ue = scriptedUe().replies('editor_save_all_and_quit', {
      ...verified(true),
      save_verified: false,
    });
    const result = await editorSaveAllAndQuitHandler({}, {} as never);
    expect(result.isError).toBe(true);
  });

  it('surfaces native save refusal without issuing another command', async () => {
    ue = scriptedUe().fails('editor_save_all_and_quit', 'dirty packages remain');
    const result = await editorSaveAllAndQuitHandler({}, {} as never);
    expect(result.isError).toBe(true);
    expect(ue.calls).toHaveLength(1);
  });
});
