import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerDeferredRouting, type CapturedTool, ALWAYS_ON_META } from '../src/tools/routing/register.js';
import { recordSchema } from '../src/tools/schema-registry.js';
import { registerToolMeta } from '../src/tools/tool-meta-registry.js';
import { __resetSettingsCache } from '../src/tools/routing/settings-watcher.js';
import { __resetConnectedLatch } from '../src/tools/check-ue-status.js';

function fixtureCaptured(): Map<string, CapturedTool> {
  const captured = new Map<string, CapturedTool>();
  const tools: Array<[string, string | null]> = [
    ['actor_spawn',                 'actor'],
    ['actor_list',                  'actor'],
    ['scene_export',                'scene'],
    ['create_pcg_graph',            null],
    ['list_tool_categories',        'code-mode'],
    ['get_tool_signature',          'code-mode'],
    ['hayba_check_ue_status',       null],
    ['editor_capture_viewport',     'editor'],
    // Validator tools — captured under the validator dir so deferred routing
    // can re-register them as always-on via passthrough.
    ['validator_run',               'validator'],
    ['validator_history',           'validator'],
    ['validator_resolve',           'validator'],
    ['validator_clear',             'validator'],
    ['validator_rules',             'validator'],
    ['validator_set_rule_enabled',  'validator'],
    // PLUMB constraint subsystem — captured under the plumb dir, re-registered
    // as always-on via passthrough.
    ['plumb_primitives',            'plumb'],
    ['plumb_profile_bake',          'plumb'],
    ['plumb_profile_annotate',      'plumb'],
    ['plumb_profile_list',          'plumb'],
    ['plumb_profile_get',           'plumb'],
    ['plumb_constraint_define',     'plumb'],
    ['plumb_constraint_list',       'plumb'],
    ['plumb_constraint_remove',     'plumb'],
    ['plumb_constraint_propose',    'plumb'],
    ['plumb_validate',              'plumb'],
  ];
  for (const [name, dir] of tools) {
    const schema: z.ZodRawShape = { foo: z.string().optional() };
    recordSchema(name, { shape: schema, cost: 'low', returns: 'any' });
    registerToolMeta(name, { cost: 'low', effects: [], when: name, not_when: '' });
    captured.set(name, {
      schema,
      handler: (async () => ({ content: [{ type: 'text', text: `ok:${name}` }] })) as never,
      dir,
    });
  }
  return captured;
}

describe('routing integration (deferred)', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'hayba-int-'));
    process.env.HAYBA_SETTINGS_PATH = join(dir, 'settings.json');
    process.env.HAYBA_TOOL_INDEX_DIR = dir;
    __resetSettingsCache();
    __resetConnectedLatch();
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    delete process.env.HAYBA_SETTINGS_PATH;
    delete process.env.HAYBA_TOOL_INDEX_DIR;
  });

  it('registers exactly the always-on meta-tools when alwaysLoadPacks is empty', async () => {
    writeFileSync(process.env.HAYBA_SETTINGS_PATH!, JSON.stringify({
      toolRouting: 'deferred', alwaysLoadPacks: [],
    }));
    __resetSettingsCache();
    const server = new McpServer({ name: 'test', version: '0' });
    await registerDeferredRouting(server, fixtureCaptured(), dir);

    const registered = (server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools;
    const names = Object.keys(registered).sort();
    // Expected always-on: 4 new meta-tools + 3 always-on from captured (list_tool_categories, get_tool_signature, hayba_check_ue_status)
    expect(names).toEqual(Array.from(ALWAYS_ON_META).sort());
  });

  it('alwaysLoadPacks loads a domain pack at startup', async () => {
    writeFileSync(process.env.HAYBA_SETTINGS_PATH!, JSON.stringify({
      toolRouting: 'deferred', alwaysLoadPacks: ['actor'],
    }));
    __resetSettingsCache();
    const server = new McpServer({ name: 'test', version: '0' });
    await registerDeferredRouting(server, fixtureCaptured(), dir);

    const registered = (server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools;
    expect('actor_spawn' in registered).toBe(true);
    expect('actor_list' in registered).toBe(true);
    expect('scene_export' in registered).toBe(false);
  });

  it('editor pack auto-loads when the ue_connected hook fires', async () => {
    writeFileSync(process.env.HAYBA_SETTINGS_PATH!, JSON.stringify({
      toolRouting: 'deferred', alwaysLoadPacks: [],
    }));
    __resetSettingsCache();
    const server = new McpServer({ name: 'test', version: '0' });
    const handle = await registerDeferredRouting(server, fixtureCaptured(), dir);

    await handle.onUeConnected();
    const registered = (server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools;
    expect('editor_capture_viewport' in registered).toBe(true);
    expect(handle.registry.isLoaded('editor')).toBe(true);
  });

  it('hayba_invoke unknown_tool error path works', async () => {
    writeFileSync(process.env.HAYBA_SETTINGS_PATH!, JSON.stringify({
      toolRouting: 'deferred', alwaysLoadPacks: [],
    }));
    __resetSettingsCache();
    const server = new McpServer({ name: 'test', version: '0' });
    await registerDeferredRouting(server, fixtureCaptured(), dir);

    const registered = (server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools;
    const invoke = registered['hayba_invoke'] as unknown as { implementation?: (args: unknown) => Promise<unknown>; handler?: (args: unknown) => Promise<unknown> };
    const handler = invoke.implementation || invoke.handler;
    const res = await handler!({ name: 'nonexistent_tool', args: {} });
    const text = (res as { content: Array<{ text: string }> }).content[0].text;
    expect(text).toContain('unknown_tool');
  });
});
