/**
 * a production project stall, 2026-11-06 00:39: a script's unreal.AutomationLibrary.take_high_res_screenshot ran
 * FinishLoadingBeforeScreenshot -> SubmitRemainingJobsForWorld + FinishAllCompilation and held the shared
 * editor's game thread for 10 minutes. python_exec_file must refuse such scripts before it runs them.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const cpp = readFileSync(
  join(here, '..', '..', '..', '..', '..', 'unreal', 'HaybaMCPToolkit', 'Source', 'HaybaMCPToolkit', 'Private', 'handlers',
    'HaybaMCPPythonHandler.cpp'),
  'utf8',
);
const execFile = cpp.slice(cpp.indexOf('FHaybaHandlerResult FHaybaMCPPythonHandler::ExecFile('));

describe('python_exec_file refuses scripts that block the game thread on every compile', () => {
  it('checks for the blocking calls before it executes anything', () => {
    const guard = execFile.indexOf('HCR-BLOCK-002');
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(execFile.indexOf('ExecPythonGuarded(PythonPlugin, &RunCmd'));
    for (const call of ['take_high_res_screenshot', 'finish_all_compilation']) {
      expect(execFile.slice(0, guard)).toContain(`TEXT("${call}")`);
    }
  });
});
