import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../tool-executor.js', () => ({
  executeCommand: vi.fn(async () => ({ applied: ['blend_mode'] })),
}));

import { executeCommand } from '../tool-executor.js';
import { materialSetMaterialPropertyHandler } from './material-set-material-property.js';

describe('material_set_material_property', () => {
  beforeEach(() => vi.clearAllMocks());

  it('forwards material_set_property with properties', async () => {
    const r = await materialSetMaterialPropertyHandler({
      material_path: '/Game/M_Test',
      properties: { blend_mode: 'BLEND_Translucent', two_sided: true },
    });
    expect(executeCommand).toHaveBeenCalledWith('material_set_property', expect.objectContaining({
      material_path: '/Game/M_Test',
      properties: expect.objectContaining({ blend_mode: 'BLEND_Translucent', two_sided: true }),
    }));
    expect(r.isError).toBeFalsy();
  });

  it('rejects missing material_path', async () => {
    const r = await materialSetMaterialPropertyHandler({ properties: { two_sided: true } });
    expect(r.isError).toBe(true);
  });

  it('rejects empty properties', async () => {
    const r = await materialSetMaterialPropertyHandler({ material_path: '/Game/M_Test', properties: {} });
    expect(r.isError).toBe(true);
  });
});
