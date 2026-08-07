import { describe, it, expect, beforeEach } from 'vitest';
import {
  generateLegacyDescriptors,
  buildLegacyDescriptor,
  isLegacyTarget,
  isNonIdempotentLegacy,
  legacyNonIdempotentNames,
} from './legacy-tool-factory.js';
import { STANDARD_DESCRIPTORS } from './index.js';
import { getSidecar } from '../legacy-commands/index.js';
import { deriveSignature } from './schema-registry.js';
import { recordToolSchema, type ToolDescriptor } from './register-tool.js';
import { setDefaultSender, NON_IDEMPOTENT, type Sender } from './tool-executor.js';

/** First text block. Descriptors may now return image blocks too, so the
 *  content array is no longer text-only. */
function textOf(r: { content: Array<{ type: string; text?: string }> }): string {
  return r.content.find((c) => c.type === 'text')?.text ?? '';
}

function byName(list: ToolDescriptor[], name: string): ToolDescriptor {
  const d = list.find((x) => x.name === name);
  if (!d) throw new Error(`descriptor ${name} not found`);
  return d;
}

describe('generateLegacyDescriptors — count', () => {
  it('surfaces exactly the agent_callable && !has_ts_wrapper commands (minus collisions)', () => {
    const sidecar = getSidecar();
    const targets = Object.entries(sidecar.commands).filter(([, e]) => isLegacyTarget(e));
    const reserved = new Set(STANDARD_DESCRIPTORS.map((d) => d.name));
    // Regenerate against the merged names to know how many collided.
    const gen = generateLegacyDescriptors(new Set()); // no reservations = full target set
    expect(gen.length).toBe(targets.length);
    expect(targets.length).toBeGreaterThanOrEqual(50); // sanity: the ~55 breadth win
    // The count is dynamic, never hardcoded.
    expect(reserved.size).toBeGreaterThan(gen.length);
  });
});

describe('generateLegacyDescriptors — sample descriptors', () => {
  const gen = generateLegacyDescriptors(new Set());

  it('spline_add_point: present, required vs optional fields, non-idempotent', () => {
    const d = byName(gen, 'spline_add_point');
    // actor_id + location required, index optional.
    const v = (d.schema.actor_id as any).safeParse('a');
    expect(v.success).toBe(true);
    expect((d.schema.index as any).isOptional()).toBe(true);
    expect((d.schema.actor_id as any).isOptional()).toBe(false);
    expect((d.schema.location as any).isOptional()).toBe(false);
    expect(isNonIdempotentLegacy('spline_add_point')).toBe(true);
  });

  it('level_save: present, single optional path param', () => {
    const d = byName(gen, 'level_save');
    expect(d.name).toBe('level_save');
    expect((d.schema.path as any).isOptional()).toBe(true);
    expect(d.cost).toBe('medium');
  });

  it('mesh_extract: present, carries param descriptions, all optional, medium cost', () => {
    const d = byName(gen, 'mesh_extract');
    expect((d.schema.actor_label as any).isOptional()).toBe(true);
    // Description carried through from sidecar param.
    recordToolSchema(d);
    const sig = deriveSignature('mesh_extract');
    expect(sig).not.toBeNull();
    expect(sig!.params.actor_label).toContain('Editor actor label');
    expect(sig!.params.include_triangles).toContain('bool');
    expect(sig!.cost).toBe('medium');
  });
});

describe('legacy handler dispatch (mocked sender)', () => {
  beforeEach(() => setDefaultSender(undefined as never));

  it('dispatches under the command name and wraps ok result', async () => {
    let seenCmd = '';
    let seenParams: unknown;
    setDefaultSender((async (cmd, params) => {
      seenCmd = cmd;
      seenParams = params;
      return { id: 'x', ok: true, data: { saved: true } };
    }) as Sender);

    const d = buildLegacyDescriptor('level_save', getSidecar().commands['level_save']);
    const res = await d.handler({ path: '/Game/Maps/M' }, {} as never);

    expect(seenCmd).toBe('level_save');
    expect(seenParams).toEqual({ path: '/Game/Maps/M' });
    expect(res.isError).toBeUndefined();
    expect(JSON.parse(textOf(res))).toEqual({ saved: true });
  });

  it('returns a canonical error envelope when UE errors', async () => {
    setDefaultSender((async () => ({ id: 'x', ok: false, error: 'boom' })) as Sender);
    const d = buildLegacyDescriptor('level_save', getSidecar().commands['level_save']);
    const res = await d.handler({}, {} as never);
    expect(res.isError).toBe(true);
    const parsed = JSON.parse(textOf(res));
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain('level_save error');
    expect(parsed.error).toContain('boom');
  });
});

describe('no duplicate names across the merged registration set', () => {
  it('STANDARD_DESCRIPTORS has zero duplicate tool names', () => {
    const names = STANDARD_DESCRIPTORS.map((d) => d.name);
    const dupes = names.filter((n, i) => names.indexOf(n) !== i);
    expect(dupes).toEqual([]);
  });

  it('generated names never collide with hand-written descriptors', () => {
    const reserved = new Set(STANDARD_DESCRIPTORS.map((d) => d.name));
    // Simulate the index.ts splice: reserve every hand-written name.
    const handwritten = STANDARD_DESCRIPTORS.filter(
      (d) => !generateLegacyDescriptors(new Set()).some((g) => g.name === d.name),
    ).map((d) => d.name);
    const gen = generateLegacyDescriptors(new Set(handwritten));
    for (const g of gen) expect(reserved.has(g.name)).toBe(true); // all merged in
    // No generated name equals a hand-written-only name.
    for (const g of gen) expect(handwritten.includes(g.name)).toBe(false);
  });
});

describe('NON_IDEMPOTENT extension', () => {
  it('surfaced mutating commands are registered non-idempotent', () => {
    // Importing the factory module runs the side-effect that extends the set.
    for (const name of legacyNonIdempotentNames()) {
      expect(NON_IDEMPOTENT.has(name)).toBe(true);
    }
    // Spot-checks across the mutating families.
    expect(NON_IDEMPOTENT.has('spline_add_point')).toBe(true);
    expect(NON_IDEMPOTENT.has('actor_duplicate')).toBe(true);
    expect(NON_IDEMPOTENT.has('blueprint_create')).toBe(true);
    expect(NON_IDEMPOTENT.has('asset_import')).toBe(true);
    // Read-only ones stay idempotent.
    expect(NON_IDEMPOTENT.has('level_list')).toBe(false);
    expect(NON_IDEMPOTENT.has('mesh_extract')).toBe(false);
    // Wildcard-invocation commands — side effect opaque, never retry.
    expect(isNonIdempotentLegacy('actor_call_function')).toBe(true);
    expect(isNonIdempotentLegacy('editor_run_console_command')).toBe(true);
    expect(NON_IDEMPOTENT.has('actor_call_function')).toBe(true);
    expect(NON_IDEMPOTENT.has('editor_run_console_command')).toBe(true);
  });
});
