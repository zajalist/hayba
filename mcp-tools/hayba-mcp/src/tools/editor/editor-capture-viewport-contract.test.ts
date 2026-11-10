/**
 * a production project, 2026-11-10 17:14: editor_capture_viewport returned all-black frames with camera 0,0,0. Every viewport command
 * took its viewport from GEditor->GetActiveViewport(), the FOCUSED one, which is the PIE window or nothing while the
 * editor is in the background (and the bookmark commands static_cast its client to FEditorViewportClient). Pins the
 * fix: one resolver (HaybaMCPViewport.h). Reading the view takes the PIE player's while PIE runs, else the level
 * viewport the user last worked in; changing the level camera or view mode takes that level viewport and is refused
 * during PIE; an all-black capture is an error.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const priv = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..', 'unreal', 'HaybaMCPToolkit',
  'Source', 'HaybaMCPToolkit', 'Private');
const read = (...p: string[]) => readFileSync(join(priv, ...p), 'utf8').replace(/\r\n/g, '\n');
const code = (src: string) => src.replace(/\/\/.*$/gm, '');   // comments may name the old call
const editor = read('handlers', 'HaybaMCPEditorHandler.cpp');
const level = read('handlers', 'HaybaMCPLevelHandler.cpp');
const fn = (src: string, name: string) => src.slice(src.indexOf(name), src.indexOf('\n}\n', src.indexOf(name)));

describe('viewport commands resolve the viewport in one place', () => {
  it('no handler takes the focused viewport or casts a viewport client blindly', () => {
    for (const file of readdirSync(join(priv, 'handlers')).filter((f) => f.endsWith('.cpp'))) {
      const src = code(read('handlers', file));
      expect(src, file).not.toContain('GetActiveViewport()');
      expect(src, file).not.toContain('static_cast<FEditorViewportClient*>');
    }
  });

  it('the resolver reads the PIE player view first, else the last-used level viewport', () => {
    const resolver = read('HaybaMCPViewport.h');
    expect(resolver).toContain('PC->GetPlayerViewPoint(Out.Location, Out.Rotation);');
    expect(resolver).toContain('GCurrentLevelEditingViewportClient');
  });

  it('capture and set-bookmark read the current view', () => {
    expect(fn(editor, 'FHaybaHandlerResult FHaybaMCPEditorHandler::CaptureViewport(')).toContain('HaybaViewport::CurrentView(View, ViewError)');
    expect(fn(editor, 'FHaybaHandlerResult FHaybaMCPEditorHandler::CaptureViewport(')).toContain('GetOrSpawnCaptureActor(CaptureWorld)');
    expect(fn(level, 'FHaybaHandlerResult FHaybaMCPLevelHandler::LevelSetBookmark(')).toContain('HaybaViewport::CurrentView(View, ViewError)');
  });

  for (const [src, name, cmd] of [
    [editor, 'FHaybaHandlerResult FHaybaMCPEditorHandler::SetCamera(', 'editor_set_camera'],
    [editor, 'FHaybaHandlerResult FHaybaMCPEditorHandler::FocusActor(', 'editor_focus_actor'],
    [editor, 'FHaybaHandlerResult FHaybaMCPEditorHandler::SetViewportMode(', 'editor_set_viewport_mode'],
    [level, 'FHaybaHandlerResult FHaybaMCPLevelHandler::LevelGotoBookmark(', 'level_goto_bookmark'],
  ] as const) {
    it(`${cmd} changes the level viewport through the resolver`, () => {
      expect(fn(src, name)).toContain(`HaybaViewport::LevelViewportToChange(TEXT("${cmd}"), ViewportError)`);
    });
  }

  it('refuses an entirely black capture', () => {
    expect(read('HaybaMCPCaptureActor.cpp')).toContain('the capture is entirely black');
  });
});
