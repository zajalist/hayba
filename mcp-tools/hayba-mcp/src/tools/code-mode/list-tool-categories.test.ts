import { describe, it, expect, beforeAll } from 'vitest';
import { z } from 'zod';
import { listToolCategoriesHandler } from './list-tool-categories.js';
import { recordSchema } from '../schema-registry.js';
import { STANDARD_DESCRIPTORS } from '../index.js';

// Stubs that always return not_implemented_in_v1 from C++ and must not be
// advertised — even in the "unavailable" bucket — so agents are never misled
// into expecting these commands to work (HaybaMCPBlueprintHandler.cpp:345/350/465).
const KNOWN_STUBS = [
  'blueprint_add_node',
  'blueprint_connect_nodes',
  'blueprint_add_event',
];

async function parsedOutput(): Promise<Record<string, unknown>> {
  const res = await listToolCategoriesHandler({}, {} as never);
  const text = (res.content[0] as { type: string; text: string }).text;
  return JSON.parse(text) as Record<string, unknown>;
}

describe('list_tool_categories — catalog honesty', () => {
  it('does not advertise not_implemented_in_v1 stubs in callable or unavailable', async () => {
    const out = await parsedOutput();
    const domains = out.domains as Array<{
      domain: string;
      callable: string[];
      unavailable: string[];
    }>;

    for (const stub of KNOWN_STUBS) {
      for (const d of domains) {
        expect(d.callable, `stub ${stub} must not appear in callable[] of domain ${d.domain}`)
          .not.toContain(stub);
        expect(d.unavailable, `stub ${stub} must not appear in unavailable[] of domain ${d.domain}`)
          .not.toContain(stub);
      }
    }
  });

  it('blueprint domain still lists its working commands', async () => {
    const out = await parsedOutput();
    const domains = out.domains as Array<{ domain: string; callable: string[]; unavailable: string[] }>;
    const bp = domains.find(d => d.domain === 'blueprint');
    expect(bp).toBeDefined();
    // blueprint_compile is in the sidecar as agent_callable so must appear in callable
    const allBpCommands = [...(bp?.callable ?? []), ...(bp?.unavailable ?? [])];
    expect(allBpCommands).toContain('blueprint_compile');
    expect(allBpCommands).toContain('blueprint_create');
  });
});

// ── Coverage ────────────────────────────────────────────────────────────────
//
// A gap in this catalogue is not cosmetic: it is the tool an agent consults to
// learn what the system can do, so an omission reads as "that capability does
// not exist" and the agent stops looking.
//
// The domain list used to be written by hand and had drifted badly — by the time
// these tests were added, 176 of 245 registered tools were missing, including
// every UI tool after the first three. The callable half is now generated from
// the schema registry; these tests exist so it stays generated. Reintroduce a
// hand-maintained list and the first assertion fails as soon as it falls behind.

interface CatalogDomain {
  domain: string;
  command_count: number;
  callable_count: number;
  callable: string[];
  unavailable: string[];
}

async function catalog(): Promise<{ _legend: string; domains: CatalogDomain[]; total_commands: number; total_callable: number }> {
  const out = await parsedOutput();
  return out as unknown as { _legend: string; domains: CatalogDomain[]; total_commands: number; total_callable: number };
}

describe('list_tool_categories — coverage', () => {
  beforeAll(() => {
    // Mirror what the server does at startup; without it the registry is empty
    // and the catalogue has nothing legitimate to report.
    for (const d of STANDARD_DESCRIPTORS) {
      recordSchema(d.name, { shape: (d.schema ?? {}) as z.ZodRawShape, cost: 'low', returns: 'any' });
    }
  });

  it('reports every registered tool as callable', async () => {
    const c = await catalog();
    const listed = new Set(c.domains.flatMap((d) => d.callable));
    const missing = STANDARD_DESCRIPTORS.map((d) => d.name).filter((n) => !listed.has(n));

    expect(
      missing.length,
      `${missing.length} registered tools are absent from the catalogue, so an agent reading it ` +
        `would conclude they do not exist:\n  ${missing.slice(0, 25).join('\n  ')}` +
        (missing.length > 25 ? `\n  ...and ${missing.length - 25} more` : ''),
    ).toBe(0);
  });

  it('surfaces the whole UI toolset, not the first three tools', async () => {
    // The specific regression that prompted this: the catalogue reported ui as
    // three commands long after the toolset had grown past twenty.
    const c = await catalog();
    const ui = c.domains.find((d) => d.domain === 'ui');
    expect(ui, 'ui domain should be present').toBeDefined();
    expect(ui!.callable_count).toBeGreaterThan(15);
    for (const expected of ['ui_validate', 'ui_build_tree', 'ui_measure_text', 'ui_layout_snapshot']) {
      expect(ui!.callable, `${expected} missing from the ui domain`).toContain(expected);
    }
  });

  it('groups tools under the domain their name implies', async () => {
    const c = await catalog();
    const domainOf = new Map<string, string>();
    for (const d of c.domains) for (const t of d.callable) domainOf.set(t, d.domain);
    expect(domainOf.get('ui_validate')).toBe('ui');
    expect(domainOf.get('actor_spawn')).toBe('actor');
    expect(domainOf.get('material_compile')).toBe('material');
  });

  it('never reports the same command as both callable and unavailable', async () => {
    const c = await catalog();
    for (const d of c.domains) {
      const overlap = d.callable.filter((n) => d.unavailable.includes(n));
      expect(overlap, `${d.domain} reports contradictory availability for: ${overlap.join(', ')}`).toEqual([]);
    }
  });

  it('counts add up to the per-domain totals', async () => {
    const c = await catalog();
    for (const d of c.domains) {
      expect(d.callable_count).toBe(d.callable.length);
      expect(d.command_count).toBe(d.callable.length + d.unavailable.length);
    }
    expect(c.total_callable).toBe(c.domains.reduce((n, d) => n + d.callable_count, 0));
  });

  it('says in the legend that the callable list is generated', async () => {
    // The legend is what tells an agent how much to trust the list.
    const c = await catalog();
    expect(c._legend).toMatch(/generated|live/i);
  });
});
