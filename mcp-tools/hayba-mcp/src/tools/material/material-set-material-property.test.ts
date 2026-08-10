import { beforeEach, describe, expect, it, vi } from 'vitest';
import { STANDARD_DESCRIPTORS } from '../index.js';

const executeCommandMock = vi.fn(async (_command?: string, params: Record<string, unknown> = {}) => {
  const properties = (params.properties ?? {}) as Record<string, unknown>;
  const canonicalEntries: Array<[string, unknown]> = Object.entries(properties).map(([key, value]) => [
    key === 'bUsedWithSplineMeshes' ? 'used_with_spline_meshes' : key,
    value,
  ]);
  const usage = Object.fromEntries(canonicalEntries.filter(([key]) => key.startsWith('used_with_'))) as Record<
    string,
    unknown
  >;
  const keys = canonicalEntries.map(([key]) => key);
  return {
    material_path: '/Game/M_Test.M_Test',
    applied: keys,
    changed: keys,
    dirty: true,
    saved: false,
    requires_compile: true,
    verified: true,
    readback: properties,
    usage_flags_verified: true,
    usage_flags: usage,
  } as unknown;
});

vi.mock('../tool-executor.js', () => ({
  executeCommand: (...args: unknown[]) => executeCommandMock(...(args as [string, Record<string, unknown>])),
}));

import { MATERIAL_USAGE_KEYS, materialSetMaterialPropertyHandler, schema } from './material-set-material-property.js';

describe('material_set_material_property', () => {
  beforeEach(() => executeCommandMock.mockClear());

  it('forwards strict ordinary properties', async () => {
    const result = await materialSetMaterialPropertyHandler({
      material_path: '/Game/M_Test',
      properties: { blend_mode: 'BLEND_Translucent', two_sided: true },
    });
    expect(executeCommandMock).toHaveBeenCalledWith(
      'material_set_property',
      expect.objectContaining({
        material_path: '/Game/M_Test',
        properties: { blend_mode: 'BLEND_Translucent', two_sided: true },
      }),
    );
    expect(result.isError).toBeFalsy();
  });

  it.each([
    { applied: [] },
    { changed: ['two_sided', 'extra'] },
    { material_path: '/Game/M_Other.M_Other' },
    { saved: true },
    { verified: false },
    { readback: { two_sided: false } },
  ])('rejects stale or partial ordinary-setting evidence %#', async (override) => {
    executeCommandMock.mockResolvedValueOnce({
      material_path: '/Game/M_Test.M_Test',
      applied: ['two_sided'],
      changed: ['two_sided'],
      dirty: true,
      saved: false,
      requires_compile: true,
      verified: true,
      readback: { two_sided: true },
      ...override,
    });
    const result = await materialSetMaterialPropertyHandler({
      material_path: '/Game/M_Test',
      properties: { two_sided: true },
    });
    expect(result.isError).toBe(true);
  });

  it.each(MATERIAL_USAGE_KEYS)('accepts and forwards boolean usage flag %s', async (key) => {
    for (const value of [true, false]) {
      const result = await materialSetMaterialPropertyHandler({
        material_path: '/Game/M_Test',
        properties: { [key]: value },
      });
      expect(result.isError).toBeFalsy();
      expect(executeCommandMock).toHaveBeenLastCalledWith('material_set_property', {
        material_path: '/Game/M_Test',
        properties: { [key]: value },
      });
    }
  });

  it('accepts the historical bUsedWithSplineMeshes spelling without deprecated reflection', async () => {
    for (const value of [true, false]) {
      const result = await materialSetMaterialPropertyHandler({
        material_path: '/Game/M_Test',
        properties: { bUsedWithSplineMeshes: value },
      });
      expect(result.isError).toBeFalsy();
      expect(executeCommandMock).toHaveBeenLastCalledWith('material_set_property', {
        material_path: '/Game/M_Test',
        properties: { bUsedWithSplineMeshes: value },
      });
    }
  });

  it.each(['true', 1, 0, null, [], {}])(
    'rejects non-boolean compatibility spline usage %j before transport',
    async (value) => {
      const result = await materialSetMaterialPropertyHandler({
        material_path: '/Game/M_Test',
        properties: { bUsedWithSplineMeshes: value },
      });
      expect(result.isError).toBe(true);
      expect(executeCommandMock).not.toHaveBeenCalled();
    },
  );

  it.each(['true', 1, 0, null, [], {}])('rejects non-boolean spline usage %j before transport', async (value) => {
    const result = await materialSetMaterialPropertyHandler({
      material_path: '/Game/M_Test',
      properties: { used_with_spline_meshes: value },
    });
    expect(result.isError).toBe(true);
    expect(executeCommandMock).not.toHaveBeenCalled();
  });

  it.each(['used_with_hovercrafts', 'bUsedWithHovercrafts', 'typo'])('rejects unknown property %s', async (key) => {
    const result = await materialSetMaterialPropertyHandler({
      material_path: '/Game/M_Test',
      properties: { [key]: true },
    });
    expect(result.isError).toBe(true);
    expect(executeCommandMock).not.toHaveBeenCalled();
  });

  it('rejects duplicate spline aliases before transport', async () => {
    const result = await materialSetMaterialPropertyHandler({
      material_path: '/Game/M_Test',
      properties: { used_with_spline_meshes: true, bUsedWithSplineMeshes: false },
    });
    expect(result.isError).toBe(true);
    expect(executeCommandMock).not.toHaveBeenCalled();
  });

  it('rejects mixed usage and ordinary settings to preserve atomicity', async () => {
    const result = await materialSetMaterialPropertyHandler({
      material_path: '/Game/M_Test',
      properties: { used_with_spline_meshes: true, two_sided: true },
    });
    expect(result.isError).toBe(true);
    expect(executeCommandMock).not.toHaveBeenCalled();
  });

  it('rejects missing path and empty properties', async () => {
    expect((await materialSetMaterialPropertyHandler({ properties: { two_sided: true } })).isError).toBe(true);
    expect((await materialSetMaterialPropertyHandler({ material_path: '/Game/M_Test', properties: {} })).isError).toBe(
      true,
    );
    expect(executeCommandMock).not.toHaveBeenCalled();
  });

  it.each([
    { usage_flags: undefined },
    { usage_flags_verified: false },
    { usage_flags: { used_with_spline_meshes: false } },
    { applied: [] },
    { material_path: '/Game/M_Other.M_Other' },
    { saved: true },
    { requires_compile: false },
  ])('rejects stale or inconsistent native usage evidence %#', async (override) => {
    (executeCommandMock as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      material_path: '/Game/M_Test.M_Test',
      applied: ['used_with_spline_meshes'],
      changed: ['used_with_spline_meshes'],
      dirty: true,
      saved: false,
      requires_compile: true,
      usage_flags_verified: true,
      usage_flags: { used_with_spline_meshes: true },
      ...override,
    });
    const result = await materialSetMaterialPropertyHandler({
      material_path: '/Game/M_Test',
      properties: { used_with_spline_meshes: true },
    });
    expect(result.isError).toBe(true);
  });

  it('accepts a repeated no-op that truthfully reports earlier staged work still pending', async () => {
    executeCommandMock.mockResolvedValueOnce({
      material_path: '/Game/M_Test.M_Test',
      applied: ['used_with_spline_meshes'],
      changed: [],
      dirty: true,
      saved: false,
      requires_compile: true,
      usage_flags_verified: true,
      usage_flags: { used_with_spline_meshes: true },
    });
    const result = await materialSetMaterialPropertyHandler({
      material_path: '/Game/M_Test',
      properties: { used_with_spline_meshes: true },
    });
    expect(result.isError).toBeFalsy();
  });

  it('uses the exported strict schema in the real public descriptor', () => {
    const descriptor = STANDARD_DESCRIPTORS.find((candidate) => candidate.name === 'material_set_property');
    expect(descriptor?.schema.properties).toBe(schema.shape.properties);
    expect(descriptor?.description).toContain('used_with_spline_meshes');
    const descriptorProperties = descriptor?.schema.properties as typeof schema.shape.properties;
    expect(() => descriptorProperties.parse({ used_with_spline_meshes: true })).not.toThrow();
    expect(() => descriptorProperties.parse({ used_with_spline_meshes: 'true' })).toThrow();
  });
});
