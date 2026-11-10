/**
 * a production project, 2026-11-10 17:14: editor_capture_viewport returned all-black frames with camera 0,0,0. It took the camera from
 * GEditor->GetActiveViewport(), the focused viewport, which is the PIE window or nothing while the editor is in the
 * background, so the capture sat at the origin. Pins the fix: the PIE player's view while PIE runs (captured in the
 * PIE world), else the last-used perspective level viewport, and an all-black frame is an error, not a result.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const priv = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..', 'unreal', 'HaybaMCPToolkit',
  'Source', 'HaybaMCPToolkit', 'Private');
const read = (...p: string[]) => readFileSync(join(priv, ...p), 'utf8').replace(/\r\n/g, '\n');
const editor = read('handlers', 'HaybaMCPEditorHandler.cpp');
const capture = editor.slice(editor.indexOf('FHaybaHandlerResult FHaybaMCPEditorHandler::CaptureViewport('),
  editor.indexOf('\n}\n', editor.indexOf('FHaybaHandlerResult FHaybaMCPEditorHandler::CaptureViewport(')));

describe('editor_capture_viewport captures what the user is looking at', () => {
  it('does not take its camera from the focused viewport', () => {
    expect(capture).not.toContain('GEditor->GetActiveViewport()');
  });

  it('uses the PIE player view in the PIE world, else the level viewport the user last worked in', () => {
    expect(capture).toContain('PC->GetPlayerViewPoint(CamLoc, CamRot);');
    expect(capture).toContain('GCurrentLevelEditingViewportClient');
    expect(capture).toContain('GetOrSpawnCaptureActor(CaptureWorld)');
    expect(capture).toContain('Result->SetStringField(TEXT("source"), Source);');
  });

  it('refuses an entirely black frame', () => {
    expect(read('HaybaMCPCaptureActor.cpp')).toContain('the capture is entirely black');
  });
});
