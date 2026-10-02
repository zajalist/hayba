import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { setCachedSidecarHealth } from './visual/sidecar-client.js';

// Hoisted mutable flag so individual tests can flip between "ping succeeds"
// and "transport fails" without vi.resetModules()/vi.doMock() churn, which
// previously left later tests importing an unmocked (real, network-shelling)
// tcp-client and hanging.
const tcpState = vi.hoisted(() => ({ shouldFail: false, pingData: null as Record<string, unknown> | null }));

vi.mock('../tcp-client.js', () => ({
  ensureConnected: vi.fn(async () => {
    if (tcpState.shouldFail) throw new Error('ECONNREFUSED');
    return {
      send: async () => ({ ok: true, data: tcpState.pingData ?? { status: 'idle', ueVersion: '5.4' } }),
    };
  }),
}));

describe('checkUeStatus / sidecar fields', () => {
  beforeEach(() => setCachedSidecarHealth(null));
  afterEach(() => setCachedSidecarHealth(null));

  it('includes visual_embeddings_available + active_models from cached health', async () => {
    setCachedSidecarHealth({
      available: true,
      url: 'http://localhost:7821',
      models: { clip: true, owl_vit: true },
      active_models: ['clip', 'owl_vit'],
      checked_at: Date.now(),
    });

    const { checkUeStatus } = await import('./check-ue-status.js');
    const status = await checkUeStatus({ listProcesses: async () => [] });
    expect(status.connected).toBe(true);
    expect(status.visual_embeddings_available).toBe(true);
    expect(status.active_models).toEqual(['clip', 'owl_vit']);
    expect(status.sidecar_url).toBe('http://localhost:7821');
  });

  it('reports visual_embeddings_available=false when sidecar cache is unavailable', async () => {
    setCachedSidecarHealth({
      available: false,
      url: 'http://localhost:7821',
      models: {},
      active_models: [],
      error: 'ECONNREFUSED',
      checked_at: Date.now(),
    });

    const { checkUeStatus } = await import('./check-ue-status.js');
    const status = await checkUeStatus({ listProcesses: async () => [] });
    expect(status.visual_embeddings_available).toBe(false);
    expect(status.active_models).toEqual([]);
    expect(status.sidecar_error).toMatch(/ECONNREFUSED/);
  });
});

describe('checkUeStatus / process identity (issue #342)', () => {
  beforeEach(() => setCachedSidecarHealth({
    available: false, url: '', models: {}, active_models: [], checked_at: Date.now(),
  }));
  afterEach(() => setCachedSidecarHealth(null));

  it('GUI only, connected: reports gui identity, no ambiguity diagnostic', async () => {
    const { checkUeStatus } = await import('./check-ue-status.js');
    const status = await checkUeStatus({
      listProcesses: async () => [{ name: 'UnrealEditor.exe', pid: 1111 }],
    });
    expect(status.connected).toBe(true);
    expect(status.editor_process_detected).toBe(true);
    expect(status.ue_processes).toEqual({
      gui: [{ name: 'UnrealEditor.exe', pid: 1111 }],
      headless: [],
      crash_reporter: [],
    });
    expect(status.process_identity).toContain('GUI UnrealEditor.exe (PID 1111)');
    expect(status.diagnostic).toBeUndefined();
  });

  it('-Cmd only, connected: names the headless process and PID as the one answering the port', async () => {
    const { checkUeStatus } = await import('./check-ue-status.js');
    const status = await checkUeStatus({
      listProcesses: async () => [{ name: 'UnrealEditor-Cmd.exe', pid: 2222 }],
    });
    expect(status.connected).toBe(true);
    expect(status.editor_process_detected).toBe(false);
    expect(status.process_identity).toContain('headless UnrealEditor-Cmd.exe (PID 2222)');
    expect(status.diagnostic).toContain('UnrealEditor-Cmd.exe');
    expect(status.diagnostic).toContain('2222');
    expect(status.diagnostic).toMatch(/stray automation/i);
  });

  it('both GUI and -Cmd, connected: flags the ambiguity by name and PID', async () => {
    const { checkUeStatus } = await import('./check-ue-status.js');
    const status = await checkUeStatus({
      listProcesses: async () => [
        { name: 'UnrealEditor.exe', pid: 1111 },
        { name: 'UnrealEditor-Cmd.exe', pid: 2222 },
      ],
    });
    expect(status.connected).toBe(true);
    expect(status.editor_process_detected).toBe(true);
    expect(status.process_identity).toContain('GUI UnrealEditor.exe (PID 1111)');
    expect(status.process_identity).toContain('headless UnrealEditor-Cmd.exe (PID 2222)');
    expect(status.diagnostic).toContain('1111');
    expect(status.diagnostic).toContain('2222');
    expect(status.diagnostic).toMatch(/cannot tell/i);
  });

  it('neither GUI nor -Cmd, connected: no processes found, no diagnostic needed', async () => {
    const { checkUeStatus } = await import('./check-ue-status.js');
    const status = await checkUeStatus({ listProcesses: async () => [] });
    expect(status.connected).toBe(true);
    expect(status.editor_process_detected).toBe(false);
    expect(status.process_identity).toBe('none detected');
    expect(status.diagnostic).toBeUndefined();
  });
});

describe('checkUeStatus / process identity when disconnected (issue #342)', () => {
  beforeEach(() => {
    tcpState.shouldFail = true;
    setCachedSidecarHealth({
      available: false, url: '', models: {}, active_models: [], checked_at: Date.now(),
    });
  });
  afterEach(() => {
    tcpState.shouldFail = false;
    setCachedSidecarHealth(null);
  });

  it('-Cmd only, disconnected: message says a headless process may be blocking the next launch', async () => {
    const { checkUeStatus } = await import('./check-ue-status.js');
    const status = await checkUeStatus({
      listProcesses: async () => [{ name: 'UnrealEditor-Cmd.exe', pid: 3333 }],
    });
    expect(status.connected).toBe(false);
    expect(status.editor_process_detected).toBe(false);
    expect(status.process_identity).toContain('headless UnrealEditor-Cmd.exe (PID 3333)');
    expect(status.diagnostic).toContain('3333');
    expect(status.diagnostic).toMatch(/blocking a GUI editor|slow boot/i);
  });

  it('neither process, disconnected: falls back to the generic "no process found" message', async () => {
    const { checkUeStatus } = await import('./check-ue-status.js');
    const status = await checkUeStatus({ listProcesses: async () => [] });
    expect(status.connected).toBe(false);
    expect(status.editor_process_detected).toBe(false);
    expect(status.process_identity).toBe('none detected');
    expect(status.diagnostic).toMatch(/No UnrealEditor process found/);
  });
});

describe('parseTasklistCsv / parsePsOutput (issue #342 process listing)', () => {
  it('parses tasklist CSV rows for known UE process names, ignoring others', async () => {
    const { parseTasklistCsv } = await import('./check-ue-status.js');
    const csv = [
      '"UnrealEditor.exe","1234","Console","1","512,000 K"',
      '"UnrealEditor-Cmd.exe","5678","Console","1","400,000 K"',
      '"chrome.exe","9999","Console","1","100,000 K"',
      '"CrashReportClientEditor.exe","4321","Console","1","50,000 K"',
    ].join('\r\n');
    expect(parseTasklistCsv(csv)).toEqual([
      { name: 'UnrealEditor.exe', pid: 1234 },
      { name: 'UnrealEditor-Cmd.exe', pid: 5678 },
      { name: 'CrashReportClientEditor.exe', pid: 4321 },
    ]);
  });

  it('parses ps -eo pid,comm output for known UE process names', async () => {
    const { parsePsOutput } = await import('./check-ue-status.js');
    const text = ['  1234 UnrealEditor', '  5678 UnrealEditor-Cmd', '  9999 bash'].join('\n');
    expect(parsePsOutput(text)).toEqual([
      { name: 'UnrealEditor.exe', pid: 1234 },
      { name: 'UnrealEditor-Cmd.exe', pid: 5678 },
    ]);
  });
});

describe('checkUeStatus / onConnected hook', () => {
  beforeEach(async () => {
    const mod = await import('./check-ue-status.js');
    mod.__resetConnectedLatch();
    setCachedSidecarHealth({
      available: false, url: '', models: {}, active_models: [], checked_at: Date.now(),
    });
  });
  afterEach(() => setCachedSidecarHealth(null));

  it('fires onConnected exactly once across multiple successful polls', async () => {
    const onConnected = vi.fn(async () => {});
    const { checkUeStatus } = await import('./check-ue-status.js');
    const listProcesses = async () => [];
    await checkUeStatus({ onConnected, listProcesses });
    await checkUeStatus({ onConnected, listProcesses });
    await checkUeStatus({ onConnected, listProcesses });
    expect(onConnected).toHaveBeenCalledTimes(1);
  });
});

describe('checkUeStatus / editor restart diagnostic (ADR-0011)', () => {
  beforeEach(() => setCachedSidecarHealth({
    available: false, url: '', models: {}, active_models: [], checked_at: Date.now(),
  }));
  afterEach(() => {
    tcpState.pingData = null;
    setCachedSidecarHealth(null);
  });

  it('turns ping.editor_unsafe into a restart diagnostic naming the faulted command and time', async () => {
    tcpState.pingData = {
      status: 'ok',
      editor_unsafe: true,
      python_unhealthy: true,
      health: { cause: 'python_native_fault', faulted_command: 'python_run', faulted_at_utc: '2000-01-01T12:34:56Z' },
    };
    const { checkUeStatus } = await import('./check-ue-status.js');
    const status = await checkUeStatus({ listProcesses: async () => [{ name: 'UnrealEditor.exe', pid: 1111 }] });
    expect(status.connected).toBe(true);
    expect(status.editor_restart_required).toBe(true);
    expect(status.diagnostic).toContain("'python_run'");
    expect(status.diagnostic).toContain('2000-01-01T12:34:56Z');
    expect(status.diagnostic).toContain('Save your work (File > Save All) and restart the editor.');
  });

  it('tells the user not to save after an engine fatal during a package save', async () => {
    tcpState.pingData = {
      status: 'ok',
      editor_unsafe: true,
      health: { cause: 'stranded_package_save', faulted_command: 'level_save', faulted_at_utc: '2000-01-01T13:00:00Z' },
    };
    const { checkUeStatus } = await import('./check-ue-status.js');
    const status = await checkUeStatus({ listProcesses: async () => [] });
    expect(status.diagnostic).toContain('Do not save; restart the editor now.');
    expect(status.diagnostic).not.toContain('File > Save All');
  });

  it('adds nothing for a healthy editor', async () => {
    tcpState.pingData = { status: 'ok', editor_unsafe: false, health: { cause: 'none' } };
    const { checkUeStatus } = await import('./check-ue-status.js');
    const status = await checkUeStatus({ listProcesses: async () => [] });
    expect(status.editor_restart_required).toBeUndefined();
    expect(status.diagnostic).toBeUndefined();
  });
});
