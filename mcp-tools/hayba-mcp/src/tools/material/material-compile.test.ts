import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../tool-executor.js', () => ({
  executeCommand: vi.fn(async () => ({ errors: [], has_errors: false, saved: true })),
}));

import { executeCommand } from '../tool-executor.js';
import { materialCompileHandler } from './material-compile.js';

describe('material_compile', () => {
  beforeEach(() => vi.clearAllMocks());

  it('forwards material_compile with the material path', async () => {
    const r = await materialCompileHandler({ material_path: '/Game/M_Test' });
    expect(executeCommand).toHaveBeenCalledWith('material_compile', expect.objectContaining({ material_path: '/Game/M_Test' }));
    expect(r.isError).toBeFalsy();
  });

  it('rejects missing material_path', async () => {
    const r = await materialCompileHandler({});
    expect(r.isError).toBe(true);
    expect(executeCommand).not.toHaveBeenCalled();
  });
});
