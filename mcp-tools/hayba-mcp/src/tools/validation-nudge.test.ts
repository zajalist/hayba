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
  appendMeta,
  isSceneMutating,
  VALIDATION_NUDGE,
  type HaybaToolMeta,
} from './hayba-tool-meta.js';
import { withValidationNudge } from './tool-result.js';
import type { SessionManager, ToolResult } from './types.js';
import { PLUMB_DESCRIPTORS, VALIDATOR_DESCRIPTORS } from './index.js';

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
  // Asserted against the DESCRIPTION THE AGENT RECEIVES, not against source text.
  //
  // This previously grepped index.ts for `USE_WHEN:` sitting inline in the
  // description literal, which tied the copy review to one registration style.
  // The validator tools are now ToolDescriptors, so the guidance lives in
  // meta.when and appendMeta renders it — same words reach the agent, and the
  // assertion no longer breaks when a tool changes how it is registered.
  it('validator descriptions are loud and directive as rendered', () => {
    const rendered = new Map(VALIDATOR_DESCRIPTORS.map((d) => [d.name, appendMeta(d.description, d.meta)]));

    const run = rendered.get('validator_run')!;
    expect(run).toContain('CATCHES SILENT WRONGNESS');
    expect(run).toMatch(/USE_WHEN:[\s\S]{0,400}after ANY scene mutation/);
    expect(run).toContain('before you declare a task done');

    // history + rules carry USE_WHEN too — they are the tools an agent reaches
    // for by mistake, so the NOT_WHEN pointing at validator_run matters.
    expect(rendered.get('validator_history')!).toMatch(/USE_WHEN:/);
    expect(rendered.get('validator_rules')!).toMatch(/USE_WHEN:/);
    expect(rendered.get('validator_history')!).toMatch(/NOT_WHEN:[\s\S]{0,200}validator_run/);
  });

  it('every validator tool that persists state declares an effect', () => {
    // The hand-written form had nowhere to put effects, so the tools that write
    // config and history declared none and sat outside the evidence contract.
    for (const name of ['validator_resolve', 'validator_clear', 'validator_set_rule_enabled', 'validator_strictness']) {
      const d = VALIDATOR_DESCRIPTORS.find((x) => x.name === name)!;
      expect(d.meta.effects.length, `${name} persists state but declares no effect`).toBeGreaterThan(0);
    }
    // ...and the pure reads still declare none, so they get no spurious warning.
    for (const name of ['validator_history', 'validator_rules']) {
      expect(VALIDATOR_DESCRIPTORS.find((x) => x.name === name)!.meta.effects).toEqual([]);
    }
  });

  it('plumb_validate copy is still loud as rendered', () => {
    const d = PLUMB_DESCRIPTORS.find((x) => x.name === 'plumb_validate')!;
    const rendered = appendMeta(d.description, d.meta);
    expect(rendered).toContain('VERIFY PLACEMENT IS ACTUALLY CORRECT');
    expect(rendered).toMatch(/USE_WHEN:[\s\S]{0,300}after placing/);
    // The WHY clause is what makes an agent reach for this instead of assuming.
    expect(rendered).toContain('provably grounded and non-overlapping');
  });

  it('plumb tools declare effects by what they DO, not by their verb', () => {
    const eff = (n: string) => PLUMB_DESCRIPTORS.find((x) => x.name === n)!.meta.effects;
    // Reads like a query, but persists a lesson via upsertLesson.
    expect(eff('plumb_study_take').length).toBeGreaterThan(0);
    // Read like authoring tools, but compute and store nothing.
    expect(eff('plumb_constraint_propose')).toEqual([]);
    expect(eff('plumb_segment')).toEqual([]);
    expect(eff('plumb_grammar_expand')).toEqual([]);
    // Every remove/define/add does persist.
    for (const n of PLUMB_DESCRIPTORS.map((d) => d.name).filter((n) => /_(add|define|remove|bake|annotate)$/.test(n))) {
      expect(eff(n).length, `${n} mutates a store but declares no effect`).toBeGreaterThan(0);
    }
  });
});
