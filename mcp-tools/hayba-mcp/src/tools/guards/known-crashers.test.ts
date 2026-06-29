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
});
