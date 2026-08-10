import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { WorkflowPackParseError, deriveDomainPacks, loadWorkflowPacks, parseWorkflowPacks } from './pack-discovery.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

describe('pack-discovery', () => {
  it('derives domain packs from tool->dir mapping', () => {
    const toolDirs = new Map<string, string | null>([
      ['actor_spawn', 'actor'],
      ['actor_list', 'actor'],
      ['scene_export', 'scene'],
      ['create_pcg_graph', null], // root-level, no explicit pack
      ['hayba_planet_dynamo_field', null], // root-level
    ]);
    const explicitPacks = new Map<string, string>([['hayba_planet_dynamo_field', 'planet']]);
    const packs = deriveDomainPacks(toolDirs, explicitPacks);
    expect(packs.find((p) => p.name === 'actor')?.tools.sort()).toEqual(['actor_list', 'actor_spawn']);
    expect(packs.find((p) => p.name === 'scene')?.tools).toEqual(['scene_export']);
    expect(packs.find((p) => p.name === 'planet')?.tools).toEqual(['hayba_planet_dynamo_field']);
    expect(packs.find((p) => p.name === 'core')?.tools).toEqual(['create_pcg_graph']);
  });

  it('loads workflow packs from yaml', () => {
    const packs = loadWorkflowPacks(resolve(__dirname, 'packs.yaml'));
    expect(packs.map((pack) => pack.name)).toEqual(['biome', 'connectors', 'editor', 'python']);
    expect(packs.find((p) => p.name === 'biome')?.kind).toBe('workflow');
    expect(packs.find((p) => p.name === 'editor')?.autoLoadOn).toBe('ue_connected');
    expect(packs.find((p) => p.name === 'python')?.tools).toEqual(['python_run']);
  });

  it('parses workflow-pack fields with YAML 1.2 scalar semantics', () => {
    const packs = parseWorkflowPacks(
      ['packs:', '  - name: on', '    kind: workflow', '    description: yes', '    tools: [ping]'].join('\n'),
    );
    expect(packs[0]).toMatchObject({ name: 'on', description: 'yes', tools: ['ping'] });
  });

  it('rejects empty and malformed manifests with bounded secret-safe diagnostics', () => {
    expect(() => parseWorkflowPacks('')).toThrowError(
      expect.objectContaining<Partial<WorkflowPackParseError>>({
        message: 'workflow pack manifest is empty',
      }),
    );

    const secret = 'sk-secret-workflow-pack';
    expect(() => parseWorkflowPacks(`token: ${secret}\npacks: [`)).toThrowError(WorkflowPackParseError);
    try {
      parseWorkflowPacks(`token: ${secret}\npacks: [`);
    } catch (error) {
      expect((error as Error).message).not.toContain(secret);
      expect((error as Error).message).not.toContain('token');
    }
  });

  it('rejects structurally invalid manifests instead of dereferencing undefined', () => {
    expect(() => parseWorkflowPacks('not_packs: []')).toThrow(/must contain a "packs" array/);
    expect(() => parseWorkflowPacks('packs:\n  - kind: workflow')).toThrow(/pack\[0\]\.name/);
  });

  it('does not disclose a caller-supplied path when discovery cannot read it', () => {
    const secretPath = resolve(__dirname, 'sk-secret-do-not-echo.yaml');
    expect(() => loadWorkflowPacks(secretPath)).toThrowError(
      expect.objectContaining<Partial<WorkflowPackParseError>>({
        message: 'could not read workflow pack manifest',
      }),
    );
  });
});
