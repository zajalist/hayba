/**
 * 2026-11-09: story changed the notify tracks of five AnimMontages through editor Python
 * (AnimationLibrary.add_animation_notify_track / add_animation_notify_event). Those calls leave the package
 * clean, so asset_save answered "already saved (not dirty)" and the edits stayed in memory only. This pins the
 * fix in the handler: force:true saves regardless of the dirty flag, and every not-dirty skip is listed in
 * skipped_not_dirty so a caller notices.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const handler = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..', 'unreal', 'HaybaMCPToolkit', 'Source',
    'HaybaMCPToolkit', 'Private', 'handlers', 'HaybaMCPAssetHandler.cpp'),
  'utf8',
).replace(/\r\n/g, '\n');
const body = handler.slice(handler.indexOf('FHaybaHandlerResult FHaybaMCPAssetHandler::AssetSave('),
  handler.indexOf('\n}\n', handler.indexOf('FHaybaHandlerResult FHaybaMCPAssetHandler::AssetSave(')));

describe('asset_save never skips a save silently', () => {
  it('reads force and skips a clean package only without it', () => {
    expect(body).toContain('const bool bForce = R.OptionalBool(TEXT("force"), false);');
    expect(body).toContain('if (!bForce && !Package->IsDirty())');
  });

  it('lists every not-dirty skip by path', () => {
    expect(body).toContain('NotDirty.Add(MakeShared<FJsonValueString>(Path));');
    expect(body).toContain('Out->SetArrayField(TEXT("skipped_not_dirty"), NotDirty);');
  });
});
