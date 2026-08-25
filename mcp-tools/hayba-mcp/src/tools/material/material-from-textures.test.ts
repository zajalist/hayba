import { describe, it, expect, vi, beforeEach } from 'vitest';

const executeCommandMock = vi.fn();
vi.mock('../tool-executor.js', () => ({
  executeCommand: (...args: unknown[]) => executeCommandMock(...(args as [])),
}));

const { materialFromTextures } = await import('./material-from-textures.js');

const AMBIENTCG = [
  'Rock023_2K-JPG_Color.jpg',
  'Rock023_2K-JPG_NormalGL.jpg',
  'Rock023_2K-JPG_Roughness.jpg',
];

/** Happy-path UE: create returns a path, each add returns a node id. */
function healthyEditor() {
  let n = 0;
  executeCommandMock.mockImplementation(async (cmd: string) => {
    if (cmd === 'material_create') return { path: '/Game/M/M_Rock' };
    if (cmd === 'material_add_node') return { node_id: `node_${n++}` };
    return {};
  });
}

beforeEach(() => executeCommandMock.mockReset());

describe('material_from_textures', () => {
  it('creates one sampler per map and connects each to its input', async () => {
    healthyEditor();

    const r = await materialFromTextures({
      textures: AMBIENTCG, package_path: '/Game/M', name: 'M_Rock',
    });

    expect(r.ok).toBe(true);
    expect(r.wired.sort()).toEqual(['base_color', 'normal', 'roughness']);

    const connects = executeCommandMock.mock.calls
      .filter(([cmd]) => cmd === 'material_connect_nodes')
      .map(([, p]) => (p as { to_property: string }).to_property);
    expect(connects.sort()).toEqual(['BaseColor', 'Normal', 'Roughness']);
  });

  it('gives each sampler the right colour space', async () => {
    healthyEditor();

    await materialFromTextures({ textures: AMBIENTCG, package_path: '/Game/M', name: 'M_Rock' });

    const samplers = executeCommandMock.mock.calls
      .filter(([cmd]) => cmd === 'material_add_node')
      .map(([, p]) => (p as { properties: { texture: string; SamplerType: string } }).properties);

    // A roughness map sampled as sRGB compiles and looks wrong, and nothing
    // reports it -- so this is the assertion that earns its keep.
    // PascalCase key and prefixed enum value: `sampler_type` is accepted by
    // material_add_node, ignored, and reported only in unknown_props -- with
    // ok:true. Confirmed against a live editor.
    expect(samplers.find((s) => s.texture.includes('Roughness'))?.SamplerType).toBe('SAMPLERTYPE_LinearColor');
    expect(samplers.find((s) => s.texture.includes('NormalGL'))?.SamplerType).toBe('SAMPLERTYPE_Normal');
    expect(samplers.find((s) => s.texture.includes('Color.jpg'))?.SamplerType).toBe('SAMPLERTYPE_Color');
  });

  it('compiles once, at the end', async () => {
    healthyEditor();

    await materialFromTextures({ textures: AMBIENTCG, package_path: '/Game/M', name: 'M_Rock' });

    const cmds = executeCommandMock.mock.calls.map(([c]) => c);
    // The per-edit handlers save without recompiling, so exactly one translate
    // at the end is the contract. More would be slow; none would ship an
    // assembled-but-untranslated material.
    expect(cmds.filter((c) => c === 'material_compile')).toHaveLength(1);
    expect(cmds[cmds.length - 1]).toBe('material_compile');
  });

  it('does not touch the editor on a dry run', async () => {
    const r = await materialFromTextures({
      textures: AMBIENTCG, package_path: '/Game/M', name: 'M_Rock', dry_run: true,
    });

    expect(r.dry_run).toBe(true);
    expect(r.plan.nodes).toHaveLength(3);
    expect(executeCommandMock).not.toHaveBeenCalled();
  });

  it('refuses when nothing looks like a texture map', async () => {
    const r = await materialFromTextures({
      textures: ['readme.txt', 'Preview.png'], package_path: '/Game/M', name: 'M_X',
    });

    expect(r.ok).toBe(false);
    expect(executeCommandMock).not.toHaveBeenCalled();
    expect(r.errors[0]).toMatch(/nothing to wire/);
  });

  it('reports a partly-wired material as a failure, not a success', async () => {
    let n = 0;
    executeCommandMock.mockImplementation(async (cmd: string, p: unknown) => {
      if (cmd === 'material_create') return { path: '/Game/M/M_Rock' };
      if (cmd === 'material_add_node') {
        const props = (p as { properties: { texture: string } }).properties;
        if (props.texture.includes('Roughness')) throw new Error('sampler limit reached');
        return { node_id: `node_${n++}` };
      }
      return {};
    });

    const r = await materialFromTextures({
      textures: AMBIENTCG, package_path: '/Game/M', name: 'M_Rock',
    });

    // The asset exists either way. Calling this ok because two of three maps
    // landed would leave someone with a material that is quietly incomplete.
    expect(r.ok).toBe(false);
    expect(r.wired.sort()).toEqual(['base_color', 'normal']);
    expect(r.errors.join(' ')).toMatch(/roughness.*sampler limit/i);
    expect(r.material).toBe('/Game/M/M_Rock');
  });

  it('says so when a node is added but yields no id', async () => {
    executeCommandMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'material_create') return { path: '/Game/M/M_Rock' };
      if (cmd === 'material_add_node') return {}; // no id came back
      return {};
    });

    const r = await materialFromTextures({
      textures: ['x_Color.png'], package_path: '/Game/M', name: 'M_Rock',
    });

    expect(r.ok).toBe(false);
    expect(r.errors[0]).toMatch(/no id came back/);
    // It must not have tried to connect a node it cannot name.
    expect(executeCommandMock.mock.calls.some(([c]) => c === 'material_connect_nodes')).toBe(false);
  });

  it('treats a silently unapplied property as a failure', async () => {
    // material_add_node returns ok:true when a property name matched nothing,
    // reporting it only in unknown_props. That is how the first version of this
    // tool shipped a wrong SamplerType and called it success.
    executeCommandMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'material_create') return { path: '/Game/M/M_Rock' };
      if (cmd === 'material_add_node') {
        return { node_id: 'node_0', applied_props: ['texture'], unknown_props: ['SamplerType'] };
      }
      return {};
    });

    const r = await materialFromTextures({
      textures: ['x_Roughness.png'], package_path: '/Game/M', name: 'M_Rock',
    });

    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toMatch(/SamplerType did not apply/);
  });

  it('carries the classification through so the caller can see the gaps', async () => {
    healthyEditor();

    const r = await materialFromTextures({
      textures: [...AMBIENTCG, 'licence.txt'], package_path: '/Game/M', name: 'M_Rock',
    });

    expect(r.plan.unrecognised).toEqual(['licence.txt']);
    expect(r.plan.missing).toContain('metallic');
  });
});
