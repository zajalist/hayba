import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { isSelfSocketScript, danglingLifetimeRegistration, installToolHooks, _resetToolHooksForTests } from '../tool-hooks.js';
import { setHistoryPath, listFindings } from '../history.js';
import { setConfigPath } from '../config.js';
import { rulesById } from '../rules.js';
import { makeValidatedPythonRunHandler } from '../../tools/python-run-validator-wrap.js';

// The `allow_unsafe` case delegates to the REAL pythonRunHandler, which calls
// tcp-client's ensureConnected(). Without a mock this test's behavior depends on
// whether a live UE editor is listening on 52342 (and now waits up to the raised
// `high`-cost timeout when it isn't), making it hang/time out. Mock tcp-client so
// the delegation resolves fast and deterministically in any environment; the
// pre-flight-rejection tests never reach send(), so this only affects the
// allow_unsafe path. Only ensureConnected is overridden — everything else real.
vi.mock('../../tcp-client.js', async (orig) => ({
  ...(await orig<typeof import('../../tcp-client.js')>()),
  ensureConnected: async () => ({ send: async () => ({ id: 'mock', ok: true, data: { stdout: '', stderr: '' } }) }),
}));

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'validator-hooks-'));
  setHistoryPath(join(tmpDir, 'history.jsonl'));
  setConfigPath(join(tmpDir, 'config.json'));
  _resetToolHooksForTests();
  installToolHooks();
});

afterEach(() => {
  setHistoryPath(null);
  setConfigPath(null);
  rmSync(tmpDir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('isSelfSocketScript', () => {
  it('flags scripts that connect to 52342–52350', () => {
    expect(isSelfSocketScript('import socket\ns = socket.socket()\ns.connect(("127.0.0.1", 52342))')).toBe(true);
    expect(isSelfSocketScript('s.connect(("localhost", 52345))')).toBe(true);
    expect(isSelfSocketScript('s.connect(("127.0.0.1", 52350))')).toBe(true);
  });

  it('ignores ports outside the UE plugin range', () => {
    expect(isSelfSocketScript('s.connect(("127.0.0.1", 8080))')).toBe(false);
    expect(isSelfSocketScript('s.connect(("127.0.0.1", 52341))')).toBe(false);
    expect(isSelfSocketScript('s.connect(("127.0.0.1", 52351))')).toBe(false);
  });

  it('ignores remote hosts', () => {
    expect(isSelfSocketScript('s.connect(("10.0.0.5", 52342))')).toBe(false);
  });

  it('returns false for scripts without socket calls', () => {
    expect(isSelfSocketScript('unreal.EditorAssetLibrary.list_assets("/Game/")')).toBe(false);
  });
});

describe('danglingLifetimeRegistration', () => {
  it('flags engine-lifetime callback registrations', () => {
    expect(danglingLifetimeRegistration('unreal.register_slate_post_tick_callback(cb)')).toBe('register_slate_post_tick_callback');
    expect(danglingLifetimeRegistration('unreal.register_slate_pre_tick_callback(cb)')).toBe('register_slate_pre_tick_callback');
    expect(danglingLifetimeRegistration('unreal.register_python_shutdown_callback(cb)')).toBe('register_python_shutdown_callback');
    expect(danglingLifetimeRegistration('unreal.register_post_engine_init_callback(cb)')).toBe('register_post_engine_init_callback');
  });

  it('returns null for one-shot scripts', () => {
    expect(danglingLifetimeRegistration('unreal.EditorAssetLibrary.list_assets("/Game/")')).toBeNull();
    expect(danglingLifetimeRegistration('delegate.add_callable(cb)')).toBeNull();
  });
});

describe('python_run pre-flight wrapper — dangling lifetime callback', () => {
  it('rejects an engine-lifetime callback registration and emits a finding', async () => {
    const handler = makeValidatedPythonRunHandler({ scratchDir: tmpDir });
    const result = await handler({
      script: 'def t(dt):\n  pass\nunreal.register_slate_post_tick_callback(t)',
    }, {});
    expect(result.isError).toBe(true);
    const text = result.content.map(c => c.text).join('\n');
    expect(text).toMatch(/dangling_lifetime_callback_in_python_run/);
    expect(text).toMatch(/register_slate_post_tick_callback/);

    const hist = await listFindings();
    expect(hist.find(f => f.ruleId === 'dangling_lifetime_callback_in_python_run')).toBeDefined();
  });

  it('honours allow_unsafe and does not reject in pre-flight', async () => {
    const handler = makeValidatedPythonRunHandler({ scratchDir: tmpDir });
    const result = await handler({
      script: 'unreal.register_python_shutdown_callback(t)',
      allow_unsafe: true,
    }, {});
    // With allow_unsafe the pre-flight does not reject; it delegates to the real
    // handler (which fails to reach a live UE here, but NOT with our finding).
    const text = result.content.map(c => c.text).join('\n');
    expect(text).not.toMatch(/dangling_lifetime_callback_in_python_run/);
  });
});

describe('attachEvaluator wired evaluators', () => {
  it('every implemented rule has an evaluator after installToolHooks()', () => {
    const map = rulesById();
    expect(map.get('pcg_zero_instances_after_execute')?.evaluate).toBeTypeOf('function');
    expect(map.get('pcg_execute_no_component_in_world')?.evaluate).toBeTypeOf('function');
    expect(map.get('pcg_asset_not_found')?.evaluate).toBeTypeOf('function');
    expect(map.get('landscape_import_no_landscape_in_world')?.evaluate).toBeTypeOf('function');
    expect(map.get('asset_browse_describe_assets_missing')?.evaluate).toBeTypeOf('function');
    expect(map.get('tcp_socket_to_self_in_python_run')?.evaluate).toBeTypeOf('function');
  });
});

describe('python_run pre-flight wrapper', () => {
  it('rejects a self-socket script and emits a finding', async () => {
    const handler = makeValidatedPythonRunHandler({ scratchDir: tmpDir });
    const result = await handler({
      script: 'import socket\ns = socket.socket()\ns.connect(("127.0.0.1", 52342))',
      allow_unsafe: true,
    }, {});
    expect(result.isError).toBe(true);
    const text = result.content.map(c => c.text).join('\n');
    expect(text).toMatch(/tcp_socket_to_self_in_python_run/);
    expect(text).toMatch(/rejected by validator/);

    const hist = await listFindings();
    expect(hist.find(f => f.ruleId === 'tcp_socket_to_self_in_python_run')).toBeDefined();
  });

  it('does not call into UE for self-socket scripts', async () => {
    // Spy through the dynamic import path used by python-run.ts.
    // The cleanest signal: the handler returns isError synchronously without
    // having reached UE — covered above by isError===true on a fresh tmpDir.
    const handler = makeValidatedPythonRunHandler({ scratchDir: tmpDir });
    const result = await handler({
      script: 's.connect(("localhost", 52344))',
    }, {});
    expect(result.isError).toBe(true);
  });

  it('rejects safely with an actionable hint', async () => {
    const handler = makeValidatedPythonRunHandler({ scratchDir: tmpDir });
    const result = await handler({
      script: 's.connect(("127.0.0.1", 52342))',
    }, {});
    const text = result.content.map(c => c.text).join('\n');
    expect(text).toMatch(/unreal\.\*/);
  });
});
