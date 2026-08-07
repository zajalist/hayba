import { describe, it, expect, beforeEach } from 'vitest';
import { buildOrientation, shouldOrient, __resetOrientation } from './orientation.js';
import { PackRegistry, type PackDef } from './pack-registry.js';

function registry(spec: Array<[string, number, 'domain' | 'workflow']>): PackRegistry {
  const packs: PackDef[] = spec.map(([name, count, kind]) => ({
    name,
    kind,
    description: '',
    tools: Array.from({ length: count }, (_, i) => `${name}_${i}`),
  }));
  return new PackRegistry(packs, () => {});
}

const CORE = [
  'hayba_search_tools',
  'hayba_invoke',
  'hayba_pack_list',
  'hayba_pack_load',
  'hayba_check_ue_status',
  'list_tool_categories',
  'get_tool_signature',
];

describe('orientation latch', () => {
  beforeEach(() => __resetOrientation());

  it('fires once and then never again', () => {
    expect(shouldOrient()).toBe(true);
    expect(shouldOrient()).toBe(false);
    expect(shouldOrient()).toBe(false);
  });
});

describe('orientation content', () => {
  const reg = registry([
    ['ui', 26, 'domain'],
    ['material', 17, 'domain'],
    ['actor', 12, 'domain'],
    ['worldbuilding', 2, 'workflow'],
  ]);

  const text = buildOrientation({ totalTools: 133, loadedTools: CORE, registry: reg });

  it('states the real numbers, not a hardcoded claim', () => {
    expect(text).toContain('133 tools exist');
    expect(text).toContain('7 are registered');
    // 133 - 7: the agent should be told how much it is NOT seeing.
    expect(text).toContain('126');
  });

  it('names the discovery loop', () => {
    expect(text).toContain('hayba_search_tools');
    expect(text).toContain('hayba_invoke');
    expect(text).toContain('hayba_pack_load');
    expect(text).toMatch(/search .*invoke/);
  });

  it('says plainly that pack loading is optional', () => {
    // The single most likely misunderstanding of a small surface is that the
    // hidden tools need enabling before they can be used.
    expect(text).toMatch(/never a\s+prerequisite|no pack load required/);
  });

  it('lists domains largest first with counts', () => {
    expect(text).toContain('ui (26)');
    expect(text).toContain('material (17)');
    expect(text.indexOf('ui (26)')).toBeLessThan(text.indexOf('material (17)'));
  });

  it('separates workflow packs from domain packs', () => {
    expect(text).toContain('Workflow packs');
    expect(text).toContain('worldbuilding');
  });

  it('warns about the UE connection precondition', () => {
    expect(text).toContain('hayba_check_ue_status');
    expect(text).toMatch(/connected/);
  });

  it('omits the workflow line entirely when there are none', () => {
    const noWorkflow = buildOrientation({
      totalTools: 10,
      loadedTools: CORE,
      registry: registry([['ui', 3, 'domain']]),
    });
    expect(noWorkflow).not.toContain('Workflow packs');
  });

  it('reports an accurate overflow count when domains exceed the headline limit', () => {
    const many: Array<[string, number, 'domain' | 'workflow']> = Array.from(
      { length: 15 },
      (_, i) => [`d${i}`, 15 - i, 'domain'],
    );
    const t = buildOrientation({ totalTools: 200, loadedTools: CORE, registry: registry(many) });
    // 15 domains, 12 named.
    expect(t).toContain('and 3 more');
  });

  it('wraps the domain list instead of emitting one very long line', () => {
    const many: Array<[string, number, 'domain' | 'workflow']> = Array.from(
      { length: 12 },
      (_, i) => [`averylongdomainname${i}`, 12 - i, 'domain'],
    );
    const t = buildOrientation({ totalTools: 200, loadedTools: CORE, registry: registry(many) });
    for (const line of t.split('\n')) {
      expect(line.length, `line too long: ${line}`).toBeLessThan(100);
    }
  });
});
