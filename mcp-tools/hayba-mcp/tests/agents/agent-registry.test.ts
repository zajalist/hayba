import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AgentRegistry, loadManifest, createRuntime } from '../../src/agents/agent-registry.js';
import { HaybaMemory } from '../../src/gaea/memory/hayba-memory.js';

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), 'hayba-agents-'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('loadManifest', () => {
  it('returns bundled defaults when hayba.agents.json is missing', () => {
    const m = loadManifest(tmp);
    expect(m.archetypes).toHaveLength(1);
    expect(m.archetypes[0].id).toBe('director');
  });

  it('parses a valid manifest', () => {
    writeFileSync(path.join(tmp, 'hayba.agents.json'), JSON.stringify({
      version: 1,
      shared_memory: 'mem.db',
      archetypes: [{ id: 'a', role: 'A', system_prompt: 's', tool_filter: ['actor_*'], memory_scope: 'shared' }],
    }));
    const m = loadManifest(tmp);
    expect(m.archetypes[0].id).toBe('a');
  });

  it('falls back to defaults on malformed JSON', () => {
    writeFileSync(path.join(tmp, 'hayba.agents.json'), '{ not valid json');
    const m = loadManifest(tmp);
    expect(m.archetypes[0].id).toBe('director');
  });
});

describe('createRuntime tool_filter', () => {
  const mem = new HaybaMemory(':memory:');
  const archetype = { id:'x', role:'X', system_prompt:'', tool_filter: ['actor_*', 'scene_export'], memory_scope: 'shared' as const };
  const rt = createRuntime(archetype, mem);

  it('matches glob patterns', () => {
    expect(rt.canUseTool('actor_spawn')).toBe(true);
    expect(rt.canUseTool('actor_list')).toBe(true);
    expect(rt.canUseTool('scene_export')).toBe(true);
  });

  it('rejects non-matching tools', () => {
    expect(rt.canUseTool('material_create')).toBe(false);
    expect(rt.canUseTool('python_run')).toBe(false);
  });

  it('star matches everything', () => {
    const all = createRuntime({ ...archetype, tool_filter: ['*'] }, mem);
    expect(all.canUseTool('anything_at_all')).toBe(true);
  });
});

describe('AgentRegistry', () => {
  it('loads manifest and instantiates runtimes', () => {
    writeFileSync(path.join(tmp, 'hayba.agents.json'), JSON.stringify({
      version: 1,
      shared_memory: 'mem.db',
      archetypes: [
        { id: 'a', role: 'A', system_prompt: 's', tool_filter: ['actor_*'], memory_scope: 'shared' },
        { id: 'b', role: 'B', system_prompt: 's', tool_filter: ['*'], memory_scope: 'shared' },
      ],
    }));
    const reg = new AgentRegistry(tmp);
    expect(reg.list()).toHaveLength(2);
    expect(reg.get('a')!.canUseTool('actor_spawn')).toBe(true);
    expect(reg.get('a')!.canUseTool('material_create')).toBe(false);
    expect(reg.get('b')!.canUseTool('material_create')).toBe(true);
    reg.close();
  });

  it('writes/reads through the shared memory', () => {
    writeFileSync(path.join(tmp, 'hayba.agents.json'), JSON.stringify({
      version: 1,
      shared_memory: 'mem.db',
      archetypes: [{ id: 'a', role: 'A', system_prompt: 's', tool_filter: ['*'], memory_scope: 'shared' }],
    }));
    const reg = new AgentRegistry(tmp);
    reg.memory.write({ agentRole: 'A', scope: 'shared', intent: 'test', content: '', accessedResources: [], tokenCost: 1 });
    expect(reg.memory.query({ scope: 'shared' })).toHaveLength(1);
    reg.close();
  });
});
