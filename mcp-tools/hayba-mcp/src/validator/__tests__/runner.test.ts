import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runAfterTool } from '../runner.js';
import { setHistoryPath, listFindings } from '../history.js';
import { setConfigPath, setRuleDisabled } from '../config.js';
import { installToolHooks, _resetToolHooksForTests } from '../tool-hooks.js';
import type { UETcpClient } from '../../tcp-client.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'validator-runner-'));
  setHistoryPath(join(tmpDir, 'history.jsonl'));
  setConfigPath(join(tmpDir, 'config.json'));
  _resetToolHooksForTests();
  installToolHooks();
});

afterEach(() => {
  setHistoryPath(null);
  setConfigPath(null);
  rmSync(tmpDir, { recursive: true, force: true });
});

/** Build a minimal stub UE client that replies to python_run with ok and writes
 *  a zero-instance count to the validator scratch file. */
function stubUe(opts: { writeCount: number; scratchDir: string }): UETcpClient {
  return {
    async send(_cmd: string, _params: Record<string, unknown>) {
      // Simulate the script writing its output file.
      mkdirSync(opts.scratchDir, { recursive: true });
      writeFileSync(
        join(opts.scratchDir, 'validator_pcg_instance_count.json'),
        JSON.stringify({ total: opts.writeCount, actors: 1 }),
      );
      return { id: 'x', ok: true, data: { stdout: JSON.stringify({ total: opts.writeCount }) } };
    },
  } as unknown as UETcpClient;
}

describe('runAfterTool', () => {
  it('emits pcg_zero_instances finding when count is 0', async () => {
    const ue = stubUe({ writeCount: 0, scratchDir: tmpDir });
    const findings = await runAfterTool({
      toolName: 'hayba_execute_pcg_graph',
      toolArgs: { assetPath: '/Game/Foo' },
      toolResult: { componentsExecuted: 1 },
      ue,
      scratchDir: tmpDir,
    });
    const ids = findings.map(f => f.ruleId);
    expect(ids).toContain('pcg_zero_instances_after_execute');

    // history should now contain the finding
    const hist = await listFindings();
    expect(hist.find(f => f.ruleId === 'pcg_zero_instances_after_execute')).toBeDefined();
  });

  it('does NOT emit pcg_zero_instances when count > 0', async () => {
    const ue = stubUe({ writeCount: 42, scratchDir: tmpDir });
    const findings = await runAfterTool({
      toolName: 'hayba_execute_pcg_graph',
      toolArgs: { assetPath: '/Game/Foo' },
      toolResult: { componentsExecuted: 1 },
      ue,
      scratchDir: tmpDir,
    });
    expect(findings.find(f => f.ruleId === 'pcg_zero_instances_after_execute')).toBeUndefined();
  });

  it('emits pcg_execute_no_component_in_world from error text', async () => {
    const findings = await runAfterTool({
      toolName: 'pcg_execute_graph',
      toolArgs: { assetPath: '/Game/Foo' },
      toolResult: 'No PCGComponents found using this graph',
      ue: null,
      scratchDir: tmpDir,
    });
    expect(findings.map(f => f.ruleId)).toContain('pcg_execute_no_component_in_world');
  });

  it('emits pcg_asset_not_found from error text', async () => {
    const findings = await runAfterTool({
      toolName: 'hayba_export_pcg_graph',
      toolArgs: { assetPath: '/Game/MissingGraph' },
      toolResult: { ok: false, error: 'could not load asset /Game/MissingGraph' },
      ue: null,
      scratchDir: tmpDir,
    });
    const f = findings.find(x => x.ruleId === 'pcg_asset_not_found');
    expect(f).toBeDefined();
    expect(f?.context?.assetPath).toBe('/Game/MissingGraph');
  });

  it('emits asset_browse_describe_assets_missing from error text', async () => {
    const findings = await runAfterTool({
      toolName: 'hayba_asset_browse',
      toolArgs: {},
      toolResult: { error: 'Unknown command: describe_assets' },
      ue: null,
      scratchDir: tmpDir,
    });
    expect(findings.map(f => f.ruleId)).toContain('asset_browse_describe_assets_missing');
  });

  it('skips disabled rules', async () => {
    setRuleDisabled('pcg_execute_no_component_in_world', true);
    const findings = await runAfterTool({
      toolName: 'pcg_execute_graph',
      toolArgs: { assetPath: '/Game/Foo' },
      toolResult: 'No PCGComponents found using this graph',
      ue: null,
      scratchDir: tmpDir,
    });
    expect(findings.map(f => f.ruleId)).not.toContain('pcg_execute_no_component_in_world');
  });

  it('persists findings to history', async () => {
    await runAfterTool({
      toolName: 'pcg_execute_graph',
      toolArgs: { assetPath: '/Game/Foo' },
      toolResult: 'No PCGComponents found using this graph',
      ue: null,
      scratchDir: tmpDir,
    });
    expect(existsSync(join(tmpDir, 'history.jsonl'))).toBe(true);
    const hist = await listFindings();
    expect(hist.length).toBeGreaterThan(0);
  });
});
