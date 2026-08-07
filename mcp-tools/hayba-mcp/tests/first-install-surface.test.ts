import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  registerDeferredRouting,
  type CapturedTool,
  ALWAYS_ON_META,
  CORE_META,
} from '../src/tools/routing/register.js';
import { recordSchema } from '../src/tools/schema-registry.js';
import { registerToolMeta } from '../src/tools/tool-meta-registry.js';
import { __resetSettingsCache } from '../src/tools/routing/settings-watcher.js';
import { __resetConnectedLatch } from '../src/tools/check-ue-status.js';

/** Lexical-only index — see the same constant in routing-integration.test.ts.
 *  The default backend probe reaches the network and blows the test timeout on
 *  a cold model cache. */
const NO_EMBEDDINGS = { selectBackend: async () => null };

// The first-install surface is a product decision, not an implementation
// detail, so it gets asserted rather than left to drift.
//
// Two failure modes are guarded here, and they pull in opposite directions:
//
//   1. Too many tools registered up front. Every always-on tool costs context on
//      every request forever, and a large default set defeats discovery — there
//      is no reason to search a catalog when 50 tools are already in front of
//      you, so the rest never get found. This is what the surface cap catches.
//
//   2. A tool that is neither registered NOR reachable. Shrinking the default
//      set is only safe because search + invoke reach everything else. If a tool
//      falls out of the captured map it becomes genuinely unreachable, which is
//      strictly worse than being noisy. This is what the reachability tests
//      catch, and it is the bug that hid 11 subsystem tools from the index.

/** Upper bound on what a fresh install may register. Raising this is a product
 *  decision: justify it in the PR, do not nudge it to make a test pass. */
const MAX_FIRST_INSTALL_TOOLS = 8;

function fixtureCaptured(): Map<string, CapturedTool> {
  const captured = new Map<string, CapturedTool>();
  const tools: Array<[string, string | null]> = [
    // Core / meta.
    ['list_tool_categories', 'code-mode'],
    ['get_tool_signature', 'code-mode'],
    ['hayba_check_ue_status', null],
    // Domain tools that must NOT be registered up front.
    ['actor_spawn', 'actor'],
    ['actor_list', 'actor'],
    ['ui_validate', 'ui'],
    ['ui_build_tree', 'ui'],
    ['plumb_validate', 'plumb'],
    ['plumb_constraint_define', 'plumb'],
    ['validator_run', 'validator'],
    ['world_generate', null],
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

function registeredNamesOf(server: McpServer): string[] {
  const registered = (server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools;
  return Object.keys(registered);
}

async function bootFreshInstall(dir: string): Promise<{ server: McpServer; captured: Map<string, CapturedTool> }> {
  // A fresh install has no settings file at all — not an empty one. Reading the
  // defaults is part of what is being tested.
  __resetSettingsCache();
  const server = new McpServer({ name: 'test', version: '0' });
  const captured = fixtureCaptured();
  await registerDeferredRouting(server, captured, dir, NO_EMBEDDINGS);
  return { server, captured };
}

describe('first-install tool surface', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'hayba-surface-'));
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

  it('registers no more than the cap on a fresh install', async () => {
    const { server } = await bootFreshInstall(dir);
    const names = registeredNamesOf(server);
    expect(
      names.length,
      `fresh install registered ${names.length} tools: ${names.sort().join(', ')}`,
    ).toBeLessThanOrEqual(MAX_FIRST_INSTALL_TOOLS);
  });

  it('registers exactly the core bootstrap set', async () => {
    const { server } = await bootFreshInstall(dir);
    expect(registeredNamesOf(server).sort()).toEqual([...CORE_META].sort());
  });

  it('keeps ALWAYS_ON_META and CORE_META in agreement', () => {
    // ALWAYS_ON_META is the name other call sites use; it must not quietly
    // grow past the curated core.
    expect([...ALWAYS_ON_META].sort()).toEqual([...CORE_META].sort());
  });

  it('does not register domain tools up front', async () => {
    const { server } = await bootFreshInstall(dir);
    const names = new Set(registeredNamesOf(server));
    for (const hidden of ['actor_spawn', 'ui_validate', 'plumb_validate', 'validator_run', 'world_generate']) {
      expect(names.has(hidden), `${hidden} should not be registered on a fresh install`).toBe(false);
    }
  });

  it('leaves every unregistered tool reachable through the captured map', async () => {
    // This is the invariant that makes a small surface safe: hayba_invoke
    // resolves from `captured`, so a tool being absent from the server is a
    // context saving, not a capability loss.
    const { server, captured } = await bootFreshInstall(dir);
    const registered = new Set(registeredNamesOf(server));

    for (const name of ['actor_spawn', 'ui_validate', 'plumb_validate', 'validator_run', 'world_generate']) {
      expect(registered.has(name)).toBe(false);
      expect(captured.has(name), `${name} must stay in the captured map to remain invokable`).toBe(true);
    }
  });

  it('makes a hidden tool callable through hayba_invoke without loading its pack', async () => {
    const { server } = await bootFreshInstall(dir);
    const registered = (server as unknown as {
      _registeredTools: Record<string, { implementation?: (a: unknown) => Promise<unknown>; handler?: (a: unknown) => Promise<unknown> }>;
    })._registeredTools;

    expect(Object.keys(registered)).not.toContain('ui_validate');

    const invoke = registered['hayba_invoke']!;
    const handler = invoke.implementation ?? invoke.handler;
    const res = await handler!({ name: 'ui_validate', args: {} });
    const text = (res as { content: Array<{ text: string }> }).content[0]!.text;

    expect(text).toContain('ok:ui_validate');
  });

  it('loads a domain pack on demand', async () => {
    const { server } = await bootFreshInstall(dir);
    const registered = (server as unknown as {
      _registeredTools: Record<string, { implementation?: (a: unknown) => Promise<unknown>; handler?: (a: unknown) => Promise<unknown> }>;
    })._registeredTools;

    expect(Object.keys(registered)).not.toContain('actor_spawn');

    const load = registered['hayba_pack_load']!;
    const handler = load.implementation ?? load.handler;
    await handler!({ name: 'actor' });

    expect(Object.keys(registered)).toContain('actor_spawn');
  });

  it('still honours alwaysLoadPacks for users who opt in', async () => {
    writeFileSync(
      process.env.HAYBA_SETTINGS_PATH!,
      JSON.stringify({ toolRouting: 'deferred', alwaysLoadPacks: ['ui'] }),
    );
    __resetSettingsCache();
    const server = new McpServer({ name: 'test', version: '0' });
    await registerDeferredRouting(server, fixtureCaptured(), dir, NO_EMBEDDINGS);

    const names = registeredNamesOf(server);
    expect(names).toContain('ui_validate');
    expect(names).toContain('ui_build_tree');
    // Opting into one pack must not drag in others.
    expect(names).not.toContain('actor_spawn');
  });
});
