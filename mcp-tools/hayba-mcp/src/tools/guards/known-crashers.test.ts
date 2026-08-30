import { describe, it, expect } from 'vitest';
import { PYTHON_CRASH_RULES, scanPythonForCrashers, crashGuardMessage } from './known-crashers.js';

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

  it('mirrors every fatal rule family with a stable code and recovery contract', () => {
    for (const rule of PYTHON_CRASH_RULES) {
      expect(rule.code, rule.family).toMatch(/^HCR-[A-Z]+-\d{3}$/);
      for (const pattern of rule.patterns) {
        const hit = scanPythonForCrashers(`probe = 1\n${pattern}`);
        expect(hit, `${rule.code}: ${pattern}`).not.toBeNull();
        expect(hit?.code).toBe(rule.code);
        const message = crashGuardMessage(hit!);
        expect(message).toContain(`policy_blocked [${rule.code}]`);
        expect(message).toContain('Safe alternative:');
        expect(message).toContain('Retry unchanged: forbidden');
        expect(message).toContain('non-bypassable');
        expect(message).toContain('allow_unsafe is deprecated and ineffective');
        expect(message).toContain('#412/#415');
      }
    }
  });

  it('catches trivial case/whitespace and imported-name bypasses', () => {
    expect(scanPythonForCrashers('from TIME import SLEEP\nSLEEP ( 5 )')?.code).toBe('HCR-BLOCK-001');
    expect(scanPythonForCrashers('from THREADING import Thread\nThread(target=f).start()')?.code).toBe('HCR-LIFE-001');
    expect(scanPythonForCrashers('import os as process\nprocess._exit(1)')?.code).toBe('HCR-EXIT-001');
    expect(scanPythonForCrashers('import signal as sig\nsig.raise_signal(6)')?.code).toBe('HCR-EXIT-001');
    expect(scanPythonForCrashers('SYS . SETTRACE ( None )')?.code).toBe('HCR-TIME-001');
  });

  it('catches only loopback connections in the plugin port range', () => {
    expect(scanPythonForCrashers('client.connect(("localhost", 52347))')?.code).toBe('HCR-BLOCK-001');
    expect(scanPythonForCrashers('client.connect(("localhost", 52341))')).toBeNull();
    expect(scanPythonForCrashers('client.connect(("10.0.0.5", 52347))')).toBeNull();
  });

  it('blocks the historical duplicate-identity ListView crash path', () => {
    expect(scanPythonForCrashers('list_view.set_list_items(items + items)')?.code).toBe('HCR-UI-001');
    expect(scanPythonForCrashers('list_view.add_item(existing_item)')?.code).toBe('HCR-UI-001');
    expect(scanPythonForCrashers("list_view.set_editor_property('list_items', items)")?.code).toBe('HCR-UI-001');
    expect(scanPythonForCrashers('list_view.clear_list_items()')).toBeNull();
  });

  it('blocks reflective spellings that can hide a fatal call from preflight', () => {
    expect(scanPythonForCrashers("getattr(unreal.EditorLoadingAndSavingUtils, 'load_' + 'map')('/Game/X')")?.code).toBe(
      'HCR-DYNAMIC-001',
    );
    expect(scanPythonForCrashers("sys.__dict__['set' + 'trace'](None)")?.code).toBe('HCR-DYNAMIC-001');
    expect(scanPythonForCrashers('vars(sys)[name](None)')?.code).toBe('HCR-DYNAMIC-001');
  });

  it('uses callable boundaries instead of rejecting unrelated suffixes', () => {
    expect(scanPythonForCrashers('node.set_input("Gain", 1.0)')).toBeNull();
    expect(scanPythonForCrashers('blueprint.recompile()')).toBeNull();
    expect(scanPythonForCrashers('import timer')).toBeNull();
    expect(scanPythonForCrashers('input("blocks")')?.code).toBe('HCR-BLOCK-001');
    expect(scanPythonForCrashers('compile(source, "<x>", "exec")')?.code).toBe('HCR-DYNAMIC-001');
  });

  it('keeps specific blocking and deadline classifications ahead of broad dynamic guards', () => {
    expect(scanPythonForCrashers('builtins.input("blocks")')?.code).toBe('HCR-BLOCK-001');
    expect(
      scanPythonForCrashers(
        "import inspect\ninspect.currentframe().f_back.f_locals['_hb_deadline'] = 999999999",
      )?.code,
    ).toBe('HCR-TIME-001');
  });

  it('does not classify policy vocabulary inside inert string literals', () => {
    expect(scanPythonForCrashers("module_name = 'importlib.util'; similarly_named_inspector = 1")).toBeNull();
  });
});
