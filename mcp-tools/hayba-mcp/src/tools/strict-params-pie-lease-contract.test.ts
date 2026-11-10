/**
 * Story, 2026-11-10 16:51: a "dry run" flag passed to editor_start_pie was silently ignored, and a real PIE started
 * inside another lane's EXCLUSIVE lease, which advisory enforcement only warned about. Pins both fixes: mutating
 * commands name and refuse parameters they don't take, and PIE is refused under another owner's exclusive global
 * lease even with advisory enforcement.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'unreal', 'HaybaMCPToolkit', 'Source',
  'HaybaMCPToolkit');
const read = (...p: string[]) => readFileSync(join(root, ...p), 'utf8').replace(/\r\n/g, '\n');
const between = (src: string, from: string, to: string) => src.slice(src.indexOf(from), src.indexOf(to, src.indexOf(from)));

describe('mutating commands refuse parameters they do not take', () => {
  it('has one helper that names the unknown keys', () => {
    expect(read('Public', 'HaybaMCPParams.h')).toContain('inline FString HaybaUnknownParamsError(');
  });

  for (const [file, cmd] of [
    ['HaybaMCPEditorHandler.cpp', 'editor_start_pie'],
    ['HaybaMCPEditorHandler.cpp', 'editor_stop_pie'],
    ['HaybaMCPBlueprintHandler.cpp', 'blueprint_create'],
    ['HaybaMCPBlueprintHandler.cpp', 'blueprint_add_component'],
    ['HaybaMCPBlueprintHandler.cpp', 'blueprint_add_variable'],
    ['HaybaMCPBlueprintHandler.cpp', 'blueprint_add_function'],
    ['HaybaMCPAssetHandler.cpp', 'asset_save'],
  ] as const) {
    it(`${cmd} checks its parameters`, () => {
      expect(read('Private', 'handlers', file)).toContain(`HaybaUnknownParamsError(P, TEXT("${cmd}")`);
    });
  }
});

describe('PIE never starts under another owner exclusive global lease', () => {
  it('refuses editor_start_pie on that conflict whatever the enforcement mode', () => {
    const check = between(read('Private', 'HaybaMCPLeaseManager.cpp'), 'FHaybaMCPLeaseManager::CheckCommand(', '\n}\n');
    expect(check).toContain('L.Key == TEXT("global") && L.Mode == HaybaMCPAccess::ELockMode::Exclusive');
    expect(check).toContain('(bHolderExclusiveGlobal && Cmd == TEXT("editor_start_pie"))');
  });
});
