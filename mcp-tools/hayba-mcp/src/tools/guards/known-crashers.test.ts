import { describe, it, expect } from 'vitest';
import { scanPythonForCrashers, crashGuardMessage } from './known-crashers.js';

describe('known-crashers', () => {
  it('flags build_scale3d', () => {
    const hit = scanPythonForCrashers('mesh.build_scale3d(unreal.Vector(2,2,2))');
    expect(hit).not.toBeNull();
    expect(hit!.pattern).toBe('build_scale3d');
    expect(crashGuardMessage(hit!)).toContain('Safe alternative');
  });

  it('flags set_lod_build_settings', () => {
    expect(scanPythonForCrashers('x.set_lod_build_settings(0, s)')?.pattern).toBe('set_lod_build_settings');
  });

  it('returns null for safe scripts', () => {
    expect(scanPythonForCrashers('print(unreal.EditorLevelLibrary.get_all_level_actors())')).toBeNull();
  });

  it('flags world-switching calls (EditorEngine.cpp:1745 crash class)', () => {
    for (const script of [
      'unreal.EditorLoadingAndSavingUtils.new_blank_map(False)',
      'unreal.EditorLoadingAndSavingUtils.new_map_from_template(t, False)',
      'unreal.EditorLoadingAndSavingUtils.load_map("/Game/Maps/L1")',
      'unreal.LevelEditorSubsystem().new_level("/Game/Maps/New")',
      'unreal.EditorLevelLibrary.load_level("/Game/Maps/L1")',
    ]) {
      const hit = scanPythonForCrashers(script);
      expect(hit, script).not.toBeNull();
      expect(crashGuardMessage(hit!)).toMatch(/editor UI|editor_open_map/);
    }
  });

  it('does not flag a script that merely reads level actors (no world switch)', () => {
    expect(scanPythonForCrashers('actors = unreal.EditorActorSubsystem().get_all_level_actors()')).toBeNull();
  });
});
