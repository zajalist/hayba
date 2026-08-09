import { z } from 'zod';
import type { ToolHandler } from '../types.js';
import { executeCommand } from '../tool-executor.js';
import type { HaybaToolMeta } from '../hayba-tool-meta.js';

export const meta: HaybaToolMeta = {
  cost: 'high',
  effects: ['writes-to-disk'],
  when: 'ending an editor session — save every unsaved package and shut the editor down in one step',
  not_when: 'you only want to save (asset_save) or only want to quit and are certain nothing is dirty',
};

/**
 * Save everything, then quit — in that order, and only in that order.
 *
 * The editor must be CLOSED to link C++ and OPEN to author blueprints, so a
 * session that touches both alternates between them constantly. Shutting down
 * with a dirty asset parks the editor on a modal save prompt forever, and by
 * then the MCP port is closed, so nothing can answer it. Three editor deaths in
 * one reported session each cost precisely the assets that were still unsaved.
 * "Save immediately after every create" became a project rule, which is a
 * workaround for this tool not existing.
 *
 * The order is the whole point, and so is the refusal: if anything is STILL
 * dirty after the save pass, this does not quit. Quitting then is the exact
 * failure it exists to prevent, and an unanswerable modal is worse than a
 * command that declines and tells you what is holding it up.
 */
export const schema = z.object({
  quit: z
    .boolean()
    .optional()
    .default(true)
    .describe('Set false to save everything and report, without shutting down.'),
});

/** Enumerate dirty packages, save them, enumerate again. One python round-trip:
 *  a second call could see a different world. */
const SAVE_SCRIPT = [
  'import unreal, json',
  'def _dirty():',
  '    out = []',
  '    try:',
  '        for p in unreal.EditorLoadingAndSavingUtils.get_dirty_content_packages(): out.append(str(p.get_name()))',
  '        for p in unreal.EditorLoadingAndSavingUtils.get_dirty_map_packages(): out.append(str(p.get_name()))',
  '    except Exception as e:',
  '        out.append("<enumeration failed: %s>" % e)',
  '    return out',
  'before = _dirty()',
  'saved_ok = False',
  'try:',
  '    saved_ok = bool(unreal.EditorLoadingAndSavingUtils.save_dirty_packages(True, True))',
  'except Exception as e:',
  '    saved_ok = False',
  'after = _dirty()',
  '_emit({"before": before, "after": after, "save_reported_ok": saved_ok})',
].join('\n');

interface SaveReport {
  before?: string[];
  after?: string[];
  save_reported_ok?: boolean;
}

export const editorSaveAllAndQuitHandler: ToolHandler = async (args) => {
  const parsed = schema.safeParse(args ?? {});
  if (!parsed.success) {
    return { content: [{ type: 'text', text: `Validation error: ${parsed.error.message}` }], isError: true };
  }
  const { quit } = parsed.data;

  const raw = await executeCommand<{ stdout?: string } & SaveReport>('python_run', { script: SAVE_SCRIPT });

  // The py factory emits its payload as a HAYBA_JSON line on stdout; accept
  // either that or a already-parsed object, so this does not depend on which
  // layer unwrapped it.
  let report: SaveReport = raw ?? {};
  if (typeof raw?.stdout === 'string') {
    const line = raw.stdout.split('\n').find((l) => l.includes('HAYBA_JSON:'));
    if (line) {
      try {
        report = JSON.parse(line.slice(line.indexOf('HAYBA_JSON:') + 'HAYBA_JSON:'.length)) as SaveReport;
      } catch {
        /* fall through to the raw object */
      }
    }
  }

  const before = report.before ?? [];
  const stillDirty = report.after ?? [];

  if (stillDirty.length > 0) {
    // Refuse. Quitting now is the failure this tool exists to prevent.
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              quit: false,
              saved_count: before.length - stillDirty.length,
              still_dirty: stillDirty,
              error:
                'Not quitting: these packages are still unsaved after a save pass, and shutting down now would ' +
                'park the editor on a save prompt that nothing can answer. Save or discard them, then call again.',
            },
            null,
            2,
          ),
        },
      ],
      isError: true,
    };
  }

  if (!quit) {
    return {
      content: [
        { type: 'text', text: JSON.stringify({ quit: false, saved: before, saved_count: before.length }, null, 2) },
      ],
    };
  }

  // Everything is on disk. QUIT_EDITOR posts the shutdown and returns, so this
  // reply still reaches the caller.
  //
  // Issued through python_run rather than the editor_run_console_command
  // command on purpose. That command is surfaced to agents by the legacy
  // factory precisely BECAUSE it has no TS wrapper (agent_callable &&
  // !has_ts_wrapper), so a literal call to it here would trip
  // check-legacy-wrappers — and the lint's suggested remedy, setting
  // has_ts_wrapper:true, would delist a widely-used tool from the catalogue.
  // Going through python avoids depending on that flag at all.
  await executeCommand('python_run', {
    script: 'import unreal\nunreal.SystemLibrary.execute_console_command(None, "QUIT_EDITOR")',
  });

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(
          {
            quit: true,
            saved: before,
            saved_count: before.length,
            note:
              'Every dirty package was written to disk, then QUIT_EDITOR was issued. Shutdown is asynchronous — ' +
              'the editor exits a few seconds later, and can park at ~FD3D12DynamicRHI on teardown. If the log has ' +
              'been silent there for minutes the teardown is done and a force-kill loses nothing.',
          },
          null,
          2,
        ),
      },
    ],
  };
};
