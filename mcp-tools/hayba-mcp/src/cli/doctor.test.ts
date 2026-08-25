import { describe, it, expect } from 'vitest';
import { diagnose, exitCodeFor, formatReport, type DoctorFacts } from './doctor.js';

const healthy: DoctorFacts = {
  projectPath: 'D:/Proj/Game.uproject',
  pluginDir: 'D:/Proj/Plugins/HaybaMCPToolkit',
  pluginVersion: '1.0.0',
  declaredDependencies: ['PCG', 'PythonScriptPlugin', 'WebBrowserWidget'],
  enabledPlugins: [],
  editorReachable: true,
  port: 52342,
  serverVersion: '1.0.0',
  reportedPluginVersion: '1.0.0',
};

const facts = (over: Partial<DoctorFacts> = {}): DoctorFacts => ({ ...healthy, ...over });
const byName = (f: DoctorFacts) => Object.fromEntries(diagnose(f).map((r) => [r.name, r]));

describe('a working install', () => {
  it('passes every check', () => {
    expect(diagnose(healthy).every((r) => r.status === 'ok')).toBe(true);
    expect(exitCodeFor(diagnose(healthy))).toBe(0);
  });
});

describe('npm installed but the plugin never copied', () => {
  const r = byName(facts({ pluginDir: null, pluginVersion: null, editorReachable: false }));

  it('names the actual problem', () => {
    expect(r['plugin installed']!.status).toBe('problem');
    // This is THE common failure: the npm package is half the install, and
    // nothing about the symptom says so.
    expect(r['plugin installed']!.fix).toMatch(/only half the install/);
  });

  it('does not tell you to start an editor that has nothing to load', () => {
    expect(r['editor reachable']!.fix).toMatch(/install the plugin first/);
  });

  it('does not report checks it could not run', () => {
    expect(r['plugin dependencies enabled']!.status).toBe('unknown');
    expect(r['versions']!.status).toBe('unknown');
  });
});

describe('plugin present, editor closed', () => {
  const r = byName(facts({ editorReachable: false, reportedPluginVersion: null }));

  it('says to start the editor', () => {
    expect(r['editor reachable']!.status).toBe('problem');
    expect(r['editor reachable']!.fix).toMatch(/start the Unreal editor/);
  });
});

describe('dependencies', () => {
  it('takes a loaded plugin as proof they resolved', () => {
    // UE refuses to load a plugin whose declared dependencies are missing, so
    // a reachable editor settles the question. An earlier version of this
    // check read the .uproject, which lists only hand-toggled plugins, and
    // reported PCG as "not enabled" on an install that had been running PCG
    // commands all day.
    const r = byName(facts({ enabledPlugins: [] }));
    expect(r['plugin dependencies enabled']!.status).toBe('ok');
    expect(r['plugin dependencies enabled']!.detail).toMatch(/the plugin loaded, so they resolved/);
  });

  it('says it cannot tell when the editor is down', () => {
    const r = byName(facts({ editorReachable: false, reportedPluginVersion: null }));
    expect(r['plugin dependencies enabled']!.status).toBe('unknown');
    expect(r['plugin dependencies enabled']!.detail).toMatch(/cannot tell us/);
  });

  it('names what the plugin declares, rather than a list held elsewhere', () => {
    const r = byName(facts({ declaredDependencies: ['PCG', 'EnhancedInput'] }));
    expect(r['plugin dependencies enabled']!.detail).toMatch(/PCG, EnhancedInput/);
  });
});

describe('versions', () => {
  it('reports both without calling a healthy install broken', () => {
    // The plugin and the npm package have never shared a numbering scheme, so
    // an equality test flags every install as skewed. The first live run of
    // this tool did exactly that against a working setup.
    const r = byName(facts({ serverVersion: '1.0.0', reportedPluginVersion: '0.3.0' }));

    expect(r['versions']!.status).toBe('ok');
    expect(r['versions']!.detail).toMatch(/server 1\.0\.0, plugin 0\.3\.0/);
  });

  it('says why it cannot judge, rather than staying quiet about it', () => {
    const r = byName(facts({ serverVersion: '1.0.0', reportedPluginVersion: '0.3.0' }));
    expect(r['versions']!.detail).toMatch(/shared protocol version/);
  });

  it('says nothing at all when the editor did not report one', () => {
    const r = byName(facts({ reportedPluginVersion: null }));
    expect(r['versions']!.status).toBe('unknown');
  });
});

describe('no project given', () => {
  const r = byName(facts({ projectPath: null, pluginDir: null }));

  it('asks for one instead of guessing', () => {
    expect(r['plugin installed']!.status).toBe('unknown');
    expect(r['plugin installed']!.fix).toMatch(/--project/);
  });

  it('is not treated as a failure', () => {
    // "I could not check" is not "this is broken".
    expect(exitCodeFor(diagnose(facts({ projectPath: null, pluginDir: null, editorReachable: true }))))
      .toBe(0);
  });
});

describe('the report', () => {
  it('puts the fix under the thing it fixes', () => {
    const text = formatReport(diagnose(facts({ pluginDir: null })));
    const lines = text.split('\n');
    const i = lines.findIndex((l) => l.includes('plugin installed'));
    expect(lines[i + 1]).toMatch(/→/);
  });

  it('ends by saying whether anything needs doing', () => {
    expect(formatReport(diagnose(healthy))).toMatch(/Everything checked out/);
    expect(formatReport(diagnose(facts({ editorReachable: false })))).toMatch(/needs fixing/);
  });
});
