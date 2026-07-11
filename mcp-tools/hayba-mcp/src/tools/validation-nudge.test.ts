// Validation-discoverability tests.
//
// Two complementary levers are covered here:
//   1. The post-mutation NUDGE — a scene-mutating tool's successful result
//      carries the validation hint; a read-only tool's result does NOT.
//   2. The LOUD tool guidance — the validation tools' descriptions carry the
//      strengthened USE_WHEN / WHY text so the agent knows when to reach for them.

import { describe, it, expect, beforeEach } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerTool, type ToolDescriptor } from './register-tool.js';
import { resetToolMetaRegistry } from './tool-meta-registry.js';
import {
  isSceneMutating,
  VALIDATION_NUDGE,
  type HaybaToolMeta,
} from './hayba-tool-meta.js';
import { withValidationNudge } from './tool-result.js';
import type { SessionManager, ToolResult } from './types.js';

function fakeServer() {
  const calls: Array<{
    name: string;
    handler: (p: Record<string, unknown>) => Promise<ToolResult>;
  }> = [];
  const server = {
    tool: (name: string, _d: string, _s: unknown, handler: (p: Record<string, unknown>) => Promise<ToolResult>) => {
      calls.push({ name, handler });
    },
  } as unknown as McpServer;
  return { server, calls };
}

const session = {} as SessionManager;

function descriptor(name: string, meta: HaybaToolMeta): ToolDescriptor {
  return {
    name,
    description: `desc for ${name}`,
    schema: {},
    meta,
    cost: meta.cost,
    returns: '{ok}',
    handler: async () => ({ content: [{ type: 'text', text: '{"ok":true}' }] }),
  };
}

describe('isSceneMutating', () => {
  it('recognizes scene/actor/level/world effect tags', () => {
    expect(isSceneMutating(['spawns_actor', 'modifies_level'])).toBe(true);
    expect(isSceneMutating(['mutates_scene'])).toBe(true);
    expect(isSceneMutating(['modifies_scene'])).toBe(true);
    expect(isSceneMutating(['actor_spawn'])).toBe(true);
    expect(isSceneMutating(['lighting_change'])).toBe(true);
    expect(isSceneMutating(['modifies-world'])).toBe(true);
  });

  it('does NOT flag pure asset/disk/read effects', () => {
    expect(isSceneMutating([])).toBe(false);
    expect(isSceneMutating(undefined)).toBe(false);
    expect(isSceneMutating(['modifies_asset'])).toBe(false);
    expect(isSceneMutating(['creates_asset'])).toBe(false);
    expect(isSceneMutating(['filesystem_write', 'asset_create'])).toBe(false);
    expect(isSceneMutating(['read'])).toBe(false);
  });
});

describe('withValidationNudge', () => {
  it('appends exactly one nudge block, idempotently', () => {
    const base: ToolResult = { content: [{ type: 'text', text: '{"ok":true}' }] };
    const once = withValidationNudge(base);
    expect(once.content).toHaveLength(2);
    expect(once.content[1].text).toBe(VALIDATION_NUDGE);
    // Original block untouched — additive, not mutating.
    expect(once.content[0].text).toBe('{"ok":true}');
    const twice = withValidationNudge(once);
    expect(twice.content).toHaveLength(2);
  });

  it('no-ops on error results', () => {
    const err: ToolResult = { content: [{ type: 'text', text: 'boom' }], isError: true };
    expect(withValidationNudge(err)).toBe(err);
  });
});

describe('post-mutation nudge via registerTool', () => {
  beforeEach(() => resetToolMetaRegistry());

  it("a scene-mutating tool's result carries the validation nudge", async () => {
    const { server, calls } = fakeServer();
    registerTool(server, session, descriptor('spawn_thing', {
      cost: 'medium', effects: ['spawns_actor', 'modifies_level'], when: '', not_when: '',
    }));
    const r = await calls[0].handler({});
    const texts = r.content.map((c) => c.text);
    expect(texts).toContain(VALIDATION_NUDGE);
  });

  it('a read-only tool does NOT carry the nudge', async () => {
    const { server, calls } = fakeServer();
    registerTool(server, session, descriptor('list_things', {
      cost: 'low', effects: [], when: '', not_when: '',
    }));
    const r = await calls[0].handler({});
    const texts = r.content.map((c) => c.text);
    expect(texts).not.toContain(VALIDATION_NUDGE);
    expect(r.content).toHaveLength(1);
  });
});

describe('validation tools carry strengthened when/USE_WHEN guidance', () => {
  // Read the source of the raw server.tool registrations to assert the copy.
  it('validator_run + plumb_validate descriptions are loud and directive', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const here = fileURLToPath(new URL('.', import.meta.url));
    const src = readFileSync(`${here}/index.ts`, 'utf8');

    // validator_run — loud, with an after-mutation + before-done USE_WHEN.
    expect(src).toContain('CATCHES SILENT WRONGNESS');
    expect(src).toMatch(/'validator_run',[\s\S]{0,600}USE_WHEN:[\s\S]{0,400}after ANY scene mutation/);
    expect(src).toMatch(/'validator_run',[\s\S]{0,900}before you declare a task done/);
    // plumb_validate
    expect(src).toContain('VERIFY PLACEMENT IS ACTUALLY CORRECT');
    expect(src).toMatch(/'plumb_validate',[\s\S]{0,900}USE_WHEN:/);
    // history + rules also gained USE_WHEN
    expect(src).toMatch(/'validator_history',[\s\S]{0,400}USE_WHEN:/);
    expect(src).toMatch(/'validator_rules',[\s\S]{0,400}USE_WHEN:/);
  });
});
