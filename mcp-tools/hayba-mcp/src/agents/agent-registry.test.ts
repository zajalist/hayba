import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadAgentsManifest,
  getAgentsManifest,
  getArchetype,
  defaultManifestPath,
  __resetAgentsManifestCacheForTests,
} from './agent-registry.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hayba-agents-test-'));
  __resetAgentsManifestCacheForTests();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeManifest(name: string, content: string): string {
  const p = join(dir, name);
  writeFileSync(p, content, 'utf-8');
  return p;
}

const VALID_MANIFEST = {
  version: 1,
  shared_memory: 'hayba-memory.db',
  archetypes: [
    {
      id: 'director',
      role: 'Director',
      system_prompt: 'Directs.',
      tool_filter: ['*'],
      memory_scope: 'shared',
    },
    {
      id: 'asset-manager',
      role: 'Asset Manager',
      system_prompt: 'Manages assets.',
      tool_filter: ['asset_*', 'scene_*'],
      memory_scope: 'shared',
    },
    {
      id: 'pattern-expert',
      role: 'Pattern Expert',
      system_prompt: 'Applies patterns.',
      tool_filter: ['scene_*', 'level_*'],
      memory_scope: 'shared',
    },
    {
      id: 'node-expert',
      role: 'Node Expert',
      system_prompt: 'Explains nodes.',
      tool_filter: ['docs_*', 'pcg_*'],
      memory_scope: 'shared',
    },
    {
      id: 'blueprint-generator',
      role: 'Blueprint Generator',
      system_prompt: 'Builds blueprints.',
      tool_filter: ['*'],
      memory_scope: 'private+shared',
    },
  ],
};

describe('agent-registry: loadAgentsManifest', () => {
  it('the real shipped hayba.agents.json loads and exposes all five archetypes', () => {
    // No path override: exercises the actual file at the package root, so a
    // regression that breaks the shipped file (not just a test fixture) is
    // caught here too.
    const manifest = loadAgentsManifest(defaultManifestPath());
    expect(manifest.archetypes).toHaveLength(5);
    const ids = manifest.archetypes.map((a) => a.id).sort();
    expect(ids).toEqual(
      ['asset-manager', 'blueprint-generator', 'director', 'node-expert', 'pattern-expert'].sort(),
    );
  });

  it('a valid fixture file loads all five archetypes with their tool_filter intact', () => {
    const p = writeManifest('valid.json', JSON.stringify(VALID_MANIFEST));
    const manifest = loadAgentsManifest(p);
    expect(manifest.archetypes).toHaveLength(5);
    const assetManager = manifest.archetypes.find((a) => a.id === 'asset-manager');
    expect(assetManager?.tool_filter).toEqual(['asset_*', 'scene_*']);
  });

  it('a missing file fails loudly, naming the path', () => {
    const p = join(dir, 'does-not-exist.json');
    expect(() => loadAgentsManifest(p)).toThrowError(/not found at .*does-not-exist\.json/);
  });

  it('malformed JSON fails loudly, naming the file and that it is not valid JSON', () => {
    const p = writeManifest('broken.json', '{ "version": 1, "archetypes": [ ');
    expect(() => loadAgentsManifest(p)).toThrowError(/broken\.json.*not valid JSON/s);
  });

  it('a schema-violating entry fails loudly, naming the failing field', () => {
    const bad = {
      ...VALID_MANIFEST,
      archetypes: [
        { ...VALID_MANIFEST.archetypes[0], tool_filter: 'not-an-array' }, // wrong type
        ...VALID_MANIFEST.archetypes.slice(1),
      ],
    };
    const p = writeManifest('bad-field.json', JSON.stringify(bad));
    expect(() => loadAgentsManifest(p)).toThrowError(/archetypes\.0\.tool_filter/);
  });

  it('an invalid memory_scope value fails loudly, naming the field', () => {
    const bad = {
      ...VALID_MANIFEST,
      archetypes: [
        { ...VALID_MANIFEST.archetypes[0], memory_scope: 'public' }, // not in the enum
        ...VALID_MANIFEST.archetypes.slice(1),
      ],
    };
    const p = writeManifest('bad-scope.json', JSON.stringify(bad));
    expect(() => loadAgentsManifest(p)).toThrowError(/archetypes\.0\.memory_scope/);
  });

  it('a missing required field fails loudly, naming the field', () => {
    const bad = {
      ...VALID_MANIFEST,
      archetypes: [
        { id: 'director', role: 'Director', tool_filter: ['*'], memory_scope: 'shared' }, // no system_prompt
        ...VALID_MANIFEST.archetypes.slice(1),
      ],
    };
    const p = writeManifest('missing-field.json', JSON.stringify(bad));
    expect(() => loadAgentsManifest(p)).toThrowError(/archetypes\.0\.system_prompt/);
  });

  it('a duplicate archetype id fails loudly', () => {
    const dup = {
      ...VALID_MANIFEST,
      archetypes: [VALID_MANIFEST.archetypes[0], VALID_MANIFEST.archetypes[0]],
    };
    const p = writeManifest('dup.json', JSON.stringify(dup));
    expect(() => loadAgentsManifest(p)).toThrowError(/archetype id "director" more than once/);
  });
});

describe('agent-registry: getArchetype / getAgentsManifest', () => {
  it('a known id resolves to the expected tool_filter and system_prompt', () => {
    const p = writeManifest('valid.json', JSON.stringify(VALID_MANIFEST));
    const archetype = getArchetype('asset-manager', p);
    expect(archetype.tool_filter).toEqual(['asset_*', 'scene_*']);
    expect(archetype.system_prompt).toBe('Manages assets.');
  });

  it('an unknown archetype id is a clear error naming the id and the known ids', () => {
    const p = writeManifest('valid.json', JSON.stringify(VALID_MANIFEST));
    expect(() => getArchetype('not-a-real-id', p)).toThrowError(
      /unknown archetype id "not-a-real-id".*director/s,
    );
  });

  it('getAgentsManifest caches per path — a second call does not require the file to still exist', () => {
    const p = writeManifest('valid.json', JSON.stringify(VALID_MANIFEST));
    const first = getAgentsManifest(p);
    rmSync(p);
    const second = getAgentsManifest(p);
    expect(second).toBe(first);
  });

  it('__resetAgentsManifestCacheForTests forces a re-read', () => {
    const p = writeManifest('valid.json', JSON.stringify(VALID_MANIFEST));
    getAgentsManifest(p);
    rmSync(p);
    __resetAgentsManifestCacheForTests();
    expect(() => getAgentsManifest(p)).toThrowError(/not found/);
  });
});
