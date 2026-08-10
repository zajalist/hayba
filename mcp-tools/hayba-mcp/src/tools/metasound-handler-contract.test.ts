import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const handler = readFileSync(join(
  root, 'unreal', 'HaybaMCPMetaSound', 'Source', 'HaybaMCPMetaSound',
  'Private', 'HaybaMCPMetaSoundHandler.cpp',
), 'utf8');
const assetHandler = readFileSync(join(
  root, 'unreal', 'HaybaMCPToolkit', 'Source', 'HaybaMCPToolkit',
  'Private', 'handlers', 'HaybaMCPAssetHandler.cpp',
), 'utf8');

describe('editor-safe MetaSound handler contract', () => {
  it.each([
    'metasound_create', 'metasound_add_node', 'metasound_connect',
    'metasound_set_input', 'metasound_compile', 'metasound_inspect',
  ])('%s dispatches to a real implementation', (command) => {
    expect(handler).toContain(`Cmd == TEXT("${command}")`);
    expect(handler).not.toMatch(new RegExp(`${command}: pending MetaSoundFrontendDocumentBuilder`));
  });

  it('keeps graph edits in memory until the explicit compile/save boundary', () => {
    expect(handler).toMatch(/MSAddNode[\s\S]*MarkPackageDirty/);
    expect(handler).toMatch(/MSCompile[\s\S]*UPackage::SavePackage/);
  });

  it('normalizes package-only object paths with the asset basename', () => {
    expect(assetHandler).toContain('FPackageName::GetShortName(Path)');
    expect(assetHandler).not.toContain('Path += TEXT(".") + Path');
  });

  it('validates folders recursively and returns per-asset diagnostics', () => {
    expect(assetHandler).toContain('GetAssetsByPath(FName(*Path), ToValidate, /*bRecursive*/true)');
    expect(assetHandler).toContain('Settings.bCollectPerAssetDetails = true');
    expect(assetHandler).toContain('Results.AssetsDetails');
  });
});
