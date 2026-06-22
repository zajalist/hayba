import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../tool-executor.js', () => ({
  executeCommand: vi.fn(async () => ({ disconnected: true })),
}));

import { executeCommand } from '../tool-executor.js';
import { materialDisconnectHandler } from './material-disconnect.js';

describe('material_disconnect', () => {
  beforeEach(() => vi.clearAllMocks());

  it('disconnects a node input connection', async () => {
    const r = await materialDisconnectHandler({
      material_path: '/Game/M_Test',
      to_node: 'MaterialExpressionAdd_0',
      to_input: 'A',
    });
    expect(executeCommand).toHaveBeenCalledWith(
      'material_disconnect',
      expect.objectContaining({ material_path: '/Game/M_Test', to_node: 'MaterialExpressionAdd_0', to_input: 'A' }),
    );
    expect(r.isError).toBeFalsy();
  });

  it('disconnects a material output property', async () => {
    const r = await materialDisconnectHandler({
      material_path: '/Game/M_Test',
      to_property: 'base_color',
    });
    expect(executeCommand).toHaveBeenCalledWith(
      'material_disconnect',
      expect.objectContaining({ to_property: 'base_color' }),
    );
    expect(r.isError).toBeFalsy();
  });

  it('returns isError when neither to_node nor to_property is provided', async () => {
    const r = await materialDisconnectHandler({ material_path: '/Game/M_Test' });
    expect(r.isError).toBe(true);
    expect(executeCommand).not.toHaveBeenCalled();
  });
});
