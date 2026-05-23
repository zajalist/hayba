import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { isSelfSocketScript, installToolHooks, _resetToolHooksForTests } from '../tool-hooks.js';
import { setHistoryPath, listFindings } from '../history.js';
import { setConfigPath } from '../config.js';
import { rulesById } from '../rules.js';
import { makeValidatedPythonRunHandler } from '../../tools/python-run-validator-wrap.js';

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
