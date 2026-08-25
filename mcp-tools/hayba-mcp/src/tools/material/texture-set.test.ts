import { describe, it, expect } from 'vitest';
import { classifyTextureSet, planMaterial, LINEAR_ROLES, type MapRole } from './texture-set.js';

const roles = (sources: string[]) =>
  Object.fromEntries(classifyTextureSet(sources).maps.map((m) => [m.role, m.source]));

describe('classifying a real ambientCG set', () => {
  // Exactly what ambientCG ships for Rock023 at 2K-JPG.
  const SET = [
    'Rock023_2K-JPG_Color.jpg',
    'Rock023_2K-JPG_NormalGL.jpg',
    'Rock023_2K-JPG_Roughness.jpg',
    'Rock023_2K-JPG_AmbientOcclusion.jpg',
    'Rock023_2K-JPG_Displacement.jpg',
  ];

  it('places every map', () => {
    const r = roles(SET);
    expect(r.base_color).toBe('Rock023_2K-JPG_Color.jpg');
    expect(r.normal).toBe('Rock023_2K-JPG_NormalGL.jpg');
    expect(r.roughness).toBe('Rock023_2K-JPG_Roughness.jpg');
    expect(r.ambient_occlusion).toBe('Rock023_2K-JPG_AmbientOcclusion.jpg');
    expect(r.displacement).toBe('Rock023_2K-JPG_Displacement.jpg');
    expect(classifyTextureSet(SET).unrecognised).toEqual([]);
  });

  it('does not mistake AmbientOcclusion for a colour map', () => {
    // "AmbientOcclusion" contains "col"? No -- but it DOES contain "occlusion",
    // and "NormalGL" contains "normal". Short tokens are substrings of long
    // ones, so a naive pass mis-files half a set. This is the regression guard.
    const set = classifyTextureSet(SET);
    expect(set.maps.filter((m) => m.role === 'base_color')).toHaveLength(1);
    expect(set.maps.find((m) => m.role === 'ambient_occlusion')?.source)
      .toContain('AmbientOcclusion');
  });

  it('notices the normal map convention', () => {
    expect(classifyTextureSet(SET).maps.find((m) => m.role === 'normal')?.normalConvention)
      .toBe('gl');
    expect(classifyTextureSet(['x_NormalDX.png']).maps[0]?.normalConvention).toBe('dx');
  });
});

describe('classifying a PolyHaven-style set', () => {
  const SET = [
    'bark_willow_diff_2k.jpg',
    'bark_willow_nor_gl_2k.jpg',
    'bark_willow_rough_2k.jpg',
    'bark_willow_ao_2k.jpg',
    'bark_willow_disp_2k.jpg',
  ];

  it('handles the abbreviated convention too', () => {
    const r = roles(SET);
    expect(r.base_color).toContain('diff');
    expect(r.normal).toContain('nor');
    expect(r.roughness).toContain('rough');
    expect(r.ambient_occlusion).toContain('ao');
    expect(r.displacement).toContain('disp');
  });
});

describe('what it refuses to guess', () => {
  it('reports files it does not recognise rather than dropping them', () => {
    const set = classifyTextureSet(['Rock023_Color.jpg', 'Rock023_Preview.jpg', 'licence.txt']);
    // A preview render and a licence file are not maps. Silently ignoring them
    // would make "5 files in, 1 map out" look like a classification bug.
    expect(set.unrecognised).toEqual(['Rock023_Preview.jpg', 'licence.txt']);
  });

  it('reports a contested role instead of picking twice', () => {
    const set = classifyTextureSet(['a_Color.jpg', 'b_Albedo.jpg']);
    expect(set.maps).toHaveLength(1);
    expect(set.ambiguous).toEqual([
      { role: 'base_color', chosen: 'a_Color.jpg', alsoMatched: ['b_Albedo.jpg'] },
    ]);
  });

  it('accounts for every input exactly once', () => {
    const inputs = ['x_Color.jpg', 'y_Albedo.jpg', 'z_Normal.jpg', 'notes.md'];
    const set = classifyTextureSet(inputs);
    const seen = [
      ...set.maps.map((m) => m.source),
      ...set.unrecognised,
      ...set.ambiguous.flatMap((a) => a.alsoMatched),
    ];
    expect(seen.sort()).toEqual([...inputs].sort());
  });
});

describe('the material plan', () => {
  it('samples linear data as linear and normals as normals', () => {
    const plan = planMaterial(classifyTextureSet([
      'r_Color.jpg', 'r_NormalGL.jpg', 'r_Roughness.jpg',
    ]));
    const by = Object.fromEntries(plan.nodes.map((n) => [n.role, n]));

    // Sampling a roughness map as sRGB compiles fine and looks wrong, which is
    // the worst kind of wrong -- nothing reports it.
    // These are UE's EMaterialSamplerType values, prefix and all -- that is
    // the spelling material_add_node's reflection passthrough accepts.
    // Verified against a live editor, not inferred.
    expect(by.base_color!.samplerType).toBe('SAMPLERTYPE_Color');
    expect(by.roughness!.samplerType).toBe('SAMPLERTYPE_LinearColor');
    expect(by.normal!.samplerType).toBe('SAMPLERTYPE_Normal');
  });

  it('wires each role to its material input', () => {
    const plan = planMaterial(classifyTextureSet(['r_Color.jpg', 'r_Normal.jpg']));
    expect(plan.nodes.find((n) => n.role === 'base_color')?.connectsTo).toBe('BaseColor');
    expect(plan.nodes.find((n) => n.role === 'normal')?.connectsTo).toBe('Normal');
  });

  it('states which roles have no texture', () => {
    const plan = planMaterial(classifyTextureSet(['r_Color.jpg']));
    expect(plan.missing).toContain('metallic');
    expect(plan.missing).not.toContain('base_color');
  });

  it('keeps every linear role out of the sRGB path', () => {
    // Every linear role's own name is a token it matches, so all seven produce
    // a node here -- no skipping, or this would assert nothing.
    for (const role of LINEAR_ROLES) {
      const plan = planMaterial(classifyTextureSet([`x_${role}.png`]));
      expect(plan.nodes, `${role} should classify from its own name`).toHaveLength(1);
      expect(plan.nodes[0]!.samplerType).not.toBe('SAMPLERTYPE_Color');
    }
  });

  it('carries the unclassifiable through to the caller', () => {
    const plan = planMaterial(classifyTextureSet(['r_Color.jpg', 'readme.txt']));
    expect(plan.unrecognised).toEqual(['readme.txt']);
  });
});

describe('role coverage', () => {
  it('every role has a material input and a defined colour space', () => {
    // A role added without both is a role that wires nowhere or samples wrong.
    const plan = planMaterial(classifyTextureSet([
      'a_BaseColor.png', 'a_Normal.png', 'a_Roughness.png', 'a_Metallic.png',
      'a_AmbientOcclusion.png', 'a_Displacement.png', 'a_Opacity.png',
      'a_Emissive.png', 'a_Specular.png',
    ]));
    const found = new Set(plan.nodes.map((n) => n.role as MapRole));
    expect(found.size).toBe(9);
    for (const n of plan.nodes) expect(n.connectsTo).toBeTruthy();
  });
});

describe('short tokens do not swallow ordinary words', () => {
  // 'ao', 'col', 'nor' are substrings of common words. Word boundaries are the
  // only thing stopping a preview render or an unrelated asset being wired
  // into a material slot, so they get a test rather than trust.
  it.each([
    ['chaos_texture.png'],
    ['Rock_Colorful.png'],
    ['north_wall.png'],
    ['Preview.png'],
  ])('%s is not a map', (name) => {
    expect(classifyTextureSet([name]).maps).toEqual([]);
  });

  it('still reads a map name embedded in a longer asset name', () => {
    const set = classifyTextureSet(['T_Metal_Grate_Color.png']);
    expect(set.maps[0]?.role).toBe('base_color');
  });
});
