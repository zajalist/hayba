import { describe, it, expect } from 'vitest';
import { appendNicheBriefing, NICHE_BRIEFINGS } from './niche-briefing.js';
import type { SessionManager, ToolResult } from './types.js';

function makeFakeSession(): SessionManager {
  const seen = new Set<string>();
  return {
    briefNicheOnce(domain: string): boolean {
      if (seen.has(domain)) return false;
      seen.add(domain);
      return true;
    },
  };
}

const baseResult: ToolResult = {
  content: [{ type: 'text', text: 'ok' }],
};

describe('appendNicheBriefing', () => {
  it('adds exactly one extra content item on first call', () => {
    const session = makeFakeSession();
    const result = appendNicheBriefing('material', session, baseResult);
    expect(result.content).toHaveLength(2);
    expect(result.content[1].text).toContain('MATERIAL TOOLSET');
    expect(result.content[1].text).toContain('material_compile');
    expect(result.content[0]).toEqual(baseResult.content[0]);
  });

  it('does not add content on second call for the same domain', () => {
    const session = makeFakeSession();
    appendNicheBriefing('material', session, baseResult); // first call
    const result = appendNicheBriefing('material', session, baseResult); // second call
    expect(result.content).toHaveLength(1);
  });

  it('is a no-op for an unknown domain', () => {
    const session = makeFakeSession();
    const result = appendNicheBriefing('unknown_domain', session, baseResult);
    expect(result.content).toHaveLength(1);
    expect(result).toEqual(baseResult);
  });

  it('is a no-op when session is undefined', () => {
    const result = appendNicheBriefing('material', undefined, baseResult);
    expect(result.content).toHaveLength(1);
    expect(result).toEqual(baseResult);
  });

  it('preserves isError flag', () => {
    const session = makeFakeSession();
    const errResult: ToolResult = { content: [{ type: 'text', text: 'fail' }], isError: true };
    const result = appendNicheBriefing('material', session, errResult);
    expect(result.isError).toBe(true);
    expect(result.content).toHaveLength(2);
  });
});

describe('NICHE_BRIEFINGS', () => {
  it('has a material entry that mentions all 17 tools', () => {
    const b = NICHE_BRIEFINGS['material'];
    expect(b).toBeDefined();
    const tools = [
      'material_create',
      'material_function_create',
      'material_add_node',
      'material_set_node',
      'material_set_property',
      'material_delete_node',
      'material_connect_nodes',
      'material_disconnect',
      'material_add_comment',
      'material_add_reroute_declaration',
      'material_add_reroute_usage',
      'material_compile',
      'material_create_instance',
      'material_set_param',
      'material_apply',
      'material_list',
      'material_get_info',
    ];
    for (const tool of tools) {
      expect(b).toContain(tool);
    }
  });

  it('mentions the deferred-compilation workflow note', () => {
    expect(NICHE_BRIEFINGS['material']).toContain('DEFER compilation');
  });
});
