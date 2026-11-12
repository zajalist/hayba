import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..');
const priv = join(root, 'unreal', 'HaybaMCPToolkit', 'Source', 'HaybaMCPToolkit', 'Private');
const handler = readFileSync(join(priv, 'handlers', 'HaybaMCPAssetHandler.cpp'), 'utf8');
const router = readFileSync(join(priv, 'HaybaMCPCommandHandler.cpp'), 'utf8');
const save = handler.slice(handler.indexOf('FHaybaHandlerResult FHaybaMCPAssetHandler::AssetSave('));

function before(earlier: string, later: string): void {
  expect(save.indexOf(earlier), earlier).toBeGreaterThan(-1);
  expect(save.indexOf(later), later).toBeGreaterThan(save.indexOf(earlier));
}

describe('asset_save is native and refuses unsafe saves', () => {
  it('is a plugin command, dispatched', () => {
    expect(handler).toContain('TEXT("asset_save"),');
    expect(handler).toContain('if (Cmd == TEXT("asset_save"))           return AssetSave(P);');
  });

  it('refuses PIE and a save already in flight before touching any package', () => {
    before('IsPlaySessionInProgress()', 'for (const TSharedPtr<FJsonValue>& V : *Paths)');
    before('UE::IsSavingPackage() || IsGarbageCollecting()', 'for (const TSharedPtr<FJsonValue>& V : *Paths)');
  });

  it('never saves maps, compiling Blueprints or read-only files, and never prompts', () => {
    before('Package->ContainsMap()', 'SavePackageNoError(');
    before('bBeingCompiled', 'SavePackageNoError(');
    before('FindReadOnlyPackageFiles(Package)', 'SavePackageNoError(');
    // The toolkit's one raw SavePackage, with SAVE_NoError (save-site-contract checks its body).
    expect(save).toContain('HaybaSaveVerify::Detail::SavePackageNoError(');
    expect(save).not.toContain('UPackage::SavePackage');
    expect(save).not.toContain('SaveDirtyPackages');
  });

  it('verifies the effect: clean in memory and a fresh file on disk', () => {
    before('SavePackageNoError(', '!Package->IsDirty() && Stamp != FDateTime::MinValue() && Stamp >= Before');
  });

  it('is plan-gated but never wrapped in an undo transaction', () => {
    expect(router).toContain('TEXT("asset_save"),');
    expect(router).toContain('if (Cmd == TEXT("asset_save")) return false;');
  });
});
