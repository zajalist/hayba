// The order matters, and so does the refusal.
//
// Shutting the editor down with a dirty asset parks it on a modal save prompt
// that nothing can answer, because the MCP port is already closed. Three editor
// deaths in one reported session each cost exactly the assets still unsaved.

import { describe, it, expect, beforeEach } from 'vitest';
import { scriptedUe, type ScriptedUe } from '../testing/scripted-ue.js';
import { editorSaveAllAndQuitHandler } from './editor-save-all-and-quit.js';

function payload(before: string[], after: string[]): { stdout: string } {
  return { stdout: `HAYBA_JSON:${JSON.stringify({ before, after, save_reported_ok: after.length === 0 })}` };
}

/** The quit is issued as a SECOND python_run carrying QUIT_EDITOR. */
function quitWasIssued(ue: ScriptedUe): boolean {
  return ue.calls.some(
    (c) => c.cmd === 'python_run' && String((c.params as { script?: string }).script ?? '').includes('QUIT_EDITOR'),
  );
}

describe('editor_save_all_and_quit', () => {
  let ue: ScriptedUe;

  beforeEach(() => {
    ue = scriptedUe();
  });

  it('saves everything, then quits', async () => {
    ue.replies('python_run', payload(['/Game/A', '/Game/B'], []));

    const r = await editorSaveAllAndQuitHandler({}, {} as never);
    const out = JSON.parse(r.content[0].text as string);

    expect(out.quit).toBe(true);
    expect(out.saved_count).toBe(2);
    expect(quitWasIssued(ue), 'QUIT_EDITOR must have been issued').toBe(true);
  });

  it('REFUSES to quit while anything is still unsaved', async () => {
    // The whole point. Quitting here is the failure the tool exists to prevent.
    ue.replies('python_run', payload(['/Game/A', '/Game/B'], ['/Game/B']));

    const r = await editorSaveAllAndQuitHandler({}, {} as never);
    const out = JSON.parse(r.content[0].text as string);

    expect(r.isError, 'a refusal is an error, not a quiet success').toBe(true);
    expect(out.quit).toBe(false);
    expect(out.still_dirty).toEqual(['/Game/B']);
    expect(quitWasIssued(ue), 'must NOT have issued QUIT_EDITOR').toBe(false);
  });

  it('quit:false saves and reports without shutting down', async () => {
    ue.replies('python_run', payload(['/Game/A'], []));

    const r = await editorSaveAllAndQuitHandler({ quit: false }, {} as never);
    const out = JSON.parse(r.content[0].text as string);

    expect(out.quit).toBe(false);
    expect(out.saved_count).toBe(1);
    expect(quitWasIssued(ue)).toBe(false);
  });

  it('a clean editor still quits', async () => {
    ue.replies('python_run', payload([], []));

    const r = await editorSaveAllAndQuitHandler({}, {} as never);
    const out = JSON.parse(r.content[0].text as string);
    expect(out.quit).toBe(true);
    expect(out.saved_count).toBe(0);
  });
});
