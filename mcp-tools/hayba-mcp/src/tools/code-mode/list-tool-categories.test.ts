import { describe, it, expect } from 'vitest';
import { listToolCategoriesHandler } from './list-tool-categories.js';

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
