import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NON_IDEMPOTENT } from './tool-executor.js';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..', '..', '..');
const editor = readFileSync(join(
  repo, 'unreal', 'HaybaMCPToolkit', 'Source', 'HaybaMCPToolkit',
  'Private', 'handlers', 'HaybaMCPEditorHandler.cpp',
), 'utf8');
const commandHandler = readFileSync(join(
  repo, 'unreal', 'HaybaMCPToolkit', 'Source', 'HaybaMCPToolkit',
  'Private', 'HaybaMCPCommandHandler.cpp',
), 'utf8');
const sidecar = JSON.parse(readFileSync(join(
  here, '..', 'legacy-commands', 'sidecar.json',
), 'utf8')) as { commands: Record<string, { agent_callable: boolean; notes: string }> };

describe('verified editor save-and-quit contract', () => {
  it('is exposed, Plan-Mode gated, and duplicate-unsafe', () => {
    expect(sidecar.commands.editor_save_all_and_quit?.agent_callable).toBe(true);
    expect(commandHandler).toContain('TEXT("editor_save_all_and_quit")');
    expect(NON_IDEMPOTENT.has('editor_save_all_and_quit')).toBe(true);
  });

  it('refuses PIE/save failures and exits only after zero dirty-package verification', () => {
    expect(editor).toContain('GEditor->IsPlaySessionInProgress()');
    expect(editor).toContain('UEditorLoadingAndSavingUtils::SaveDirtyPackages');
    expect(editor).toContain('!bSaved || !DirtyAfter.IsEmpty()');
    expect(editor).toMatch(/!bSaved \|\| !DirtyAfter\.IsEmpty\(\)[\s\S]*?return FHaybaHandlerResult::Err/);
    expect(editor).toMatch(/AddTicker[\s\S]*?CollectSaveableDirtyPackageNames[\s\S]*?FPlatformMisc::RequestExit\(false\)/);
    expect(sidecar.commands.editor_save_all_and_quit!.notes).toContain('verify none remain');
  });
});
