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
  reportedProtocolVersion: 1,
  configuredClients: ['claude-code'],
  detectedClients: ['claude-code'],
  clientSearchRoot: 'D:/Proj',
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
  it('passes when both speak the same protocol, whatever the product numbers say', () => {
    // The plugin is on 0.3.0 and the npm package on 1.0.0. Comparing THOSE
    // flags every healthy install, which is how this check first behaved.
    const r = byName(facts({
      serverVersion: '1.0.0', reportedPluginVersion: '0.3.0', reportedProtocolVersion: 1,
    }));

    expect(r['versions']!.status).toBe('ok');
    expect(r['versions']!.detail).toMatch(/protocol v1 on both/);
    expect(r['versions']!.detail).toMatch(/plugin 0\.3\.0/);
  });

  it('says which side is behind, not just that they differ', () => {
    // "Update Hayba" is useless when there are two things to update and only
    // one of them is wrong.
    const behind = byName(facts({ reportedProtocolVersion: 0 }));
    expect(behind['versions']!.status).toBe('problem');
    expect(behind['versions']!.fix).toMatch(/Update the plugin/);

    const ahead = byName(facts({ reportedProtocolVersion: 99 }));
    expect(ahead['versions']!.fix).toMatch(/Update the npm server/);
  });

  it('treats silence as a mismatch, because only an old plugin is silent', () => {
    const r = byName(facts({ reportedProtocolVersion: null }));
    expect(r['versions']!.status).toBe('problem');
    expect(r['versions']!.fix).toMatch(/predates this check/);
  });

  it('says nothing when the editor is not running', () => {
    const r = byName(facts({ editorReachable: false }));
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

describe('client configuration', () => {
  it('is ok when a client already names this server', () => {
    expect(byName(facts())['client configured']?.status).toBe('ok');
  });

  it('is a PROBLEM when clients exist but none is configured', () => {
    const r = byName(facts({ configuredClients: [], detectedClients: ['cursor', 'vscode'] }))[
      'client configured'
    ];
    expect(r?.status).toBe('problem');
    expect(r?.fix).toContain('hayba-cli configure');
  });

  it('says the failure is silent, because that is the whole difficulty', () => {
    // Someone reading this report has an assistant showing no Hayba tools and
    // no error anywhere. The detail has to name that experience, or they will
    // keep looking for a stack trace that does not exist.
    const r = byName(facts({ configuredClients: [], detectedClients: ['cursor'] }))[
      'client configured'
    ];
    expect(r?.detail).toContain('no error');
  });

  it('names the directory it searched, in both failure modes', () => {
    // Running doctor from the wrong directory is indistinguishable from a
    // missing config unless the report says where it looked.
    const none = byName(facts({ configuredClients: [], detectedClients: [], clientSearchRoot: 'D:/Wrong' }))[
      'client configured'
    ];
    expect(none?.detail).toContain('D:/Wrong');
    const some = byName(facts({ configuredClients: [], detectedClients: ['cursor'], clientSearchRoot: 'D:/Wrong' }))[
      'client configured'
    ];
    expect(some?.detail).toContain('D:/Wrong');
    expect(some?.fix).toContain('D:/Wrong');
  });

  it('is UNKNOWN, not a problem, when no client is detected at all', () => {
    // Running doctor from the wrong directory is not a broken install.
    const r = byName(facts({ configuredClients: [], detectedClients: [] }))['client configured'];
    expect(r?.status).toBe('unknown');
    expect(r?.fix).toContain('--client');
  });

  it('catches the failure every other check declares healthy', () => {
    // This is the case that justifies the check existing: plugin present,
    // dependencies fine, editor answering, versions matched -- and the user
    // still has nothing, because no client was ever told to start the server.
    const f = facts({ configuredClients: [], detectedClients: ['claude-code'] });
    const results = diagnose(f);
    const others = results.filter((r) => r.name !== 'client configured');
    expect(others.every((r) => r.status === 'ok')).toBe(true);
    expect(exitCodeFor(results)).not.toBe(0);
  });

  it('is reported first', () => {
    // It is the cheapest to fix and the most likely to be the answer, so it
    // should not be the fifth thing someone reads.
    expect(diagnose(facts())[0]?.name).toBe('client configured');
  });
});
