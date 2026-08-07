// Response-evidence contract tests.
//
// The central case is deliberately adversarial: the plugin is made to LIE —
// to answer a mutation with a bare {"ok": true} — and the assertion is that the
// caller is not handed that as success. Every silent-success bug found in this
// toolkit had exactly that shape, and none of them threw, so a test that only
// exercises healthy responses would have passed while all of them were live.

import { describe, it, expect, beforeEach } from 'vitest';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerTool, type ToolDescriptor } from './register-tool.js';
import { resetToolMetaRegistry } from './tool-meta-registry.js';
import { appendMeta, VALIDATION_NUDGE, type HaybaToolMeta } from './hayba-tool-meta.js';
import {
  UNVERIFIED_MUTATION_WARNING,
  guardHandlerWithEvidence,
  hasMutationEvidence,
  isUnderEvidenceContract,
  parseEffectsFromDescription,
  withEvidenceWarning,
} from './response-evidence.js';
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

function text(payload: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
}

function descriptor(name: string, meta: HaybaToolMeta, payload: unknown): ToolDescriptor {
  return {
    name,
    description: `desc for ${name}`,
    schema: {},
    meta,
    cost: meta.cost,
    returns: '{ok}',
    handler: async () => text(payload),
  };
}

const mutating: HaybaToolMeta = {
  cost: 'low',
  effects: ['modifies_asset'],
  when: 'w',
  not_when: 'nw',
};
const readOnly: HaybaToolMeta = { cost: 'low', effects: [], when: 'w', not_when: 'nw' };

function warned(r: ToolResult): boolean {
  return r.content.some((c) => c.type === 'text' && (c.text ?? '').includes(UNVERIFIED_MUTATION_WARNING));
}

beforeEach(() => resetToolMetaRegistry());

describe('hasMutationEvidence', () => {
  it('rejects a payload that is only bookkeeping', () => {
    expect(hasMutationEvidence({ ok: true })).toBe(false);
    expect(hasMutationEvidence({ ok: true, message: 'done', elapsed_ms: 4 })).toBe(false);
    expect(hasMutationEvidence({ success: true, status: 'complete', command: 'ui_set_property' })).toBe(false);
  });

  it('accepts any substantive key, however small', () => {
    expect(hasMutationEvidence({ ok: true, changed_keys: ['Text'] })).toBe(true);
    expect(hasMutationEvidence({ ok: true, path: '/Game/Foo' })).toBe(true);
    expect(hasMutationEvidence({ ok: true, instances_removed: 0 })).toBe(true);
  });

  it('treats an explicit empty result as evidence, not as absence', () => {
    // {"changed_keys": []} is the most useful answer a mutation can give: it
    // says nothing applied. Demanding a non-empty value would suppress exactly
    // the report this contract exists to surface.
    expect(hasMutationEvidence({ ok: true, changed_keys: [] })).toBe(true);
    expect(hasMutationEvidence({ ok: true, unchanged_keys: [], changed_keys: [] })).toBe(true);
  });

  it('treats a non-object payload as self-evident', () => {
    expect(hasMutationEvidence([{ actor: 'A' }])).toBe(true);
    expect(hasMutationEvidence('/Game/Written/Path')).toBe(true);
    expect(hasMutationEvidence(null)).toBe(false);
  });

  it('is case-insensitive about bookkeeping keys', () => {
    expect(hasMutationEvidence({ OK: true, Status: 'done' })).toBe(false);
  });
});

describe('withEvidenceWarning', () => {
  it('annotates an evidence-free success', () => {
    expect(warned(withEvidenceWarning(text({ ok: true })))).toBe(true);
  });

  it('leaves a response that describes its change alone', () => {
    expect(warned(withEvidenceWarning(text({ ok: true, changed_keys: ['A'] })))).toBe(false);
  });

  it('preserves the original payload block untouched', () => {
    const r = withEvidenceWarning(text({ ok: true }));
    expect(JSON.parse(r.content[0]!.text!)).toEqual({ ok: true });
  });

  it('stays quiet on errors — a failure is already an honest report', () => {
    const err: ToolResult = { content: [{ type: 'text', text: '{"ok":false,"error":"boom"}' }], isError: true };
    expect(warned(withEvidenceWarning(err))).toBe(false);
  });

  it('stays quiet on non-JSON and on image results', () => {
    const prose: ToolResult = { content: [{ type: 'text', text: 'Spawned the actor near the ridge.' }] };
    expect(warned(withEvidenceWarning(prose))).toBe(false);
    const image = { content: [{ type: 'image', data: 'x', mimeType: 'image/png' }] } as unknown as ToolResult;
    expect(warned(withEvidenceWarning(image))).toBe(false);
  });

  it('is idempotent', () => {
    const once = withEvidenceWarning(text({ ok: true }));
    const twice = withEvidenceWarning(once);
    const count = twice.content.filter((c) => (c.text ?? '').includes(UNVERIFIED_MUTATION_WARNING)).length;
    expect(count).toBe(1);
  });
});

describe('the registration seam', () => {
  it('warns when a mutating tool reports success with nothing to show for it', async () => {
    const { server, calls } = fakeServer();
    registerTool(server, session, descriptor('t_mutate', mutating, { ok: true }));
    expect(warned(await calls[0]!.handler({}))).toBe(true);
  });

  it('does not warn a read-only tool — it never claimed to change anything', async () => {
    const { server, calls } = fakeServer();
    registerTool(server, session, descriptor('t_read', readOnly, { ok: true }));
    expect(warned(await calls[0]!.handler({}))).toBe(false);
  });

  it('does not warn a mutating tool that reports what it applied', async () => {
    const { server, calls } = fakeServer();
    registerTool(server, session, descriptor('t_good', mutating, { ok: true, changed_keys: ['Text'] }));
    expect(warned(await calls[0]!.handler({}))).toBe(false);
  });

  it('coexists with the validation nudge rather than displacing it', async () => {
    const { server, calls } = fakeServer();
    const sceneMeta: HaybaToolMeta = { cost: 'low', effects: ['spawns_actor'], when: 'w', not_when: 'nw' };
    registerTool(server, session, descriptor('t_scene', sceneMeta, { ok: true }));
    const r = await calls[0]!.handler({});
    expect(warned(r)).toBe(true);
    expect(r.content.some((c) => (c.text ?? '').includes(VALIDATION_NUDGE))).toBe(true);
  });
});

describe('effects recovered from a rendered description', () => {
  // The hand-written sites in index.ts never register a meta object, so this
  // parse is the only thing keeping them inside the contract.
  it('reads effects back out of an appendMeta description', () => {
    const d = appendMeta('Do a thing.', mutating);
    expect(parseEffectsFromDescription(d)).toEqual(['modifies_asset']);
    expect(isUnderEvidenceContract(parseEffectsFromDescription(d))).toBe(true);
  });

  it('reads an empty effects list as read-only', () => {
    const d = appendMeta('Read a thing.', readOnly);
    expect(parseEffectsFromDescription(d)).toEqual([]);
    expect(isUnderEvidenceContract(parseEffectsFromDescription(d))).toBe(false);
  });

  it('returns undefined — not [] — when the marker is absent', () => {
    // "unknown" and "no effects" must stay distinguishable: silently treating an
    // unparseable tool as read-only is the same class of bug as the one the
    // contract is here to catch.
    expect(parseEffectsFromDescription('a bare description')).toBeUndefined();
    expect(parseEffectsFromDescription(undefined)).toBeUndefined();
  });

  it('survives multi-tag effect lists', () => {
    const d = appendMeta('x', { ...mutating, effects: ['spawns_actor', 'modifies_level'] });
    expect(parseEffectsFromDescription(d)).toEqual(['spawns_actor', 'modifies_level']);
  });
});

describe('guardHandlerWithEvidence', () => {
  it('warns on an evidence-free result from a raw handler', async () => {
    const guarded = guardHandlerWithEvidence(async () => text({ ok: true }));
    expect(warned((await guarded()) as ToolResult)).toBe(true);
  });

  it('passes through anything that is not a tool result, rather than throwing', async () => {
    // A contract that can break a working tool is worse than one with a gap.
    for (const odd of [undefined, null, 42, 'plain', {}]) {
      const guarded = guardHandlerWithEvidence(async () => odd);
      await expect(guarded()).resolves.toEqual(odd);
    }
  });
});
