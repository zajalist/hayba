import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runAfterTool } from '../runner.js';
import { setHistoryPath, listFindings } from '../history.js';
import { setConfigPath, setRuleDisabled } from '../config.js';
import { installToolHooks, _resetToolHooksForTests } from '../tool-hooks.js';
import type { UeProbe } from '../ue-probe.js';

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

/** A probe that behaves like the real counter script: one stdout JSON object. */
function stubProbe(count: number): UeProbe {
  return async () => ({ ok: true, stdout: JSON.stringify({ total: count, actors: 1 }) });
}

describe('runAfterTool', () => {
  it('emits pcg_zero_instances finding when count is 0', async () => {
    const probe = stubProbe(0);
    const findings = await runAfterTool({
      toolName: 'hayba_execute_pcg_graph',
      toolArgs: { assetPath: '/Game/Foo' },
      toolResult: { componentsExecuted: 1 },
      probe,
      scratchDir: tmpDir,
    });
    const ids = findings.map((f) => f.ruleId);
    expect(ids).toContain('pcg_zero_instances_after_execute');

    // history should now contain the finding
    const hist = await listFindings();
    expect(hist.find((f) => f.ruleId === 'pcg_zero_instances_after_execute')).toBeDefined();
  });

  it('does NOT emit pcg_zero_instances when count > 0', async () => {
    const probe = stubProbe(42);
    const findings = await runAfterTool({
      toolName: 'hayba_execute_pcg_graph',
      toolArgs: { assetPath: '/Game/Foo' },
      toolResult: { componentsExecuted: 1 },
      probe,
      scratchDir: tmpDir,
    });
    expect(findings.find((f) => f.ruleId === 'pcg_zero_instances_after_execute')).toBeUndefined();
  });

  it('emits pcg_execute_no_component_in_world from error text', async () => {
    const findings = await runAfterTool({
      toolName: 'pcg_execute_graph',
      toolArgs: { assetPath: '/Game/Foo' },
      toolResult: 'No PCGComponents found using this graph',
      probe: null,
      scratchDir: tmpDir,
    });
    expect(findings.map((f) => f.ruleId)).toContain('pcg_execute_no_component_in_world');
  });

  it('emits pcg_asset_not_found from error text', async () => {
    const findings = await runAfterTool({
      toolName: 'hayba_export_pcg_graph',
      toolArgs: { assetPath: '/Game/MissingGraph' },
      toolResult: { ok: false, error: 'could not load asset /Game/MissingGraph' },
      probe: null,
      scratchDir: tmpDir,
    });
    const f = findings.find((x) => x.ruleId === 'pcg_asset_not_found');
    expect(f).toBeDefined();
    expect(f?.data?.assetPath).toBe('/Game/MissingGraph');
  });

  it('emits asset_browse_describe_assets_missing from error text', async () => {
    const findings = await runAfterTool({
      toolName: 'hayba_asset_browse',
      toolArgs: {},
      toolResult: { error: 'Unknown command: describe_assets' },
      probe: null,
      scratchDir: tmpDir,
    });
    expect(findings.map((f) => f.ruleId)).toContain('asset_browse_describe_assets_missing');
  });

  it('skips disabled rules', async () => {
    setRuleDisabled('pcg_execute_no_component_in_world', true);
    const findings = await runAfterTool({
      toolName: 'pcg_execute_graph',
      toolArgs: { assetPath: '/Game/Foo' },
      toolResult: 'No PCGComponents found using this graph',
      probe: null,
      scratchDir: tmpDir,
    });
    expect(findings.map((f) => f.ruleId)).not.toContain('pcg_execute_no_component_in_world');
  });

  it('persists findings to history', async () => {
    await runAfterTool({
      toolName: 'pcg_execute_graph',
      toolArgs: { assetPath: '/Game/Foo' },
      toolResult: 'No PCGComponents found using this graph',
      probe: null,
      scratchDir: tmpDir,
    });
    expect(existsSync(join(tmpDir, 'history.jsonl'))).toBe(true);
    const hist = await listFindings();
    expect(hist.length).toBeGreaterThan(0);
  });
});
