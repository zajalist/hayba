import { describe, it, expect, vi, beforeEach } from 'vitest';

const executeCommandMock = vi.fn(async () => ({ errors: [], has_errors: false, saved: true }) as unknown);

vi.mock('../tool-executor.js', () => ({
  executeCommand: (...args: unknown[]) => executeCommandMock(...(args as [])),
}));

import { materialCompileHandler } from './material-compile.js';

describe('material_compile', () => {
  beforeEach(() => {
    executeCommandMock.mockReset();
    executeCommandMock.mockResolvedValue({ errors: [], has_errors: false, saved: true });
  });

  it('forwards material_compile with the material path', async () => {
    const r = await materialCompileHandler({ material_path: '/Game/M_Test' });
    expect(executeCommandMock).toHaveBeenCalledWith('material_compile', expect.objectContaining({ material_path: '/Game/M_Test' }));
    expect(r.isError).toBeFalsy();
  });

  it('rejects missing material_path', async () => {
    const r = await materialCompileHandler({});
    expect(r.isError).toBe(true);
    expect(executeCommandMock).not.toHaveBeenCalled();
  });

  it('returns only the JSON block when UE omits stats (old plugin builds)', async () => {
    const r = await materialCompileHandler({ material_path: '/Game/M_Test' });
    expect(r.content).toHaveLength(1);
    expect(r.content[0].text).toContain('"saved": true');
  });

  it('appends an optimization-feedback block when UE returns stats', async () => {
    executeCommandMock.mockResolvedValue({
      errors: [],
      has_errors: false,
      saved: true,
      stats: {
        shaders: [{ name: 'Base pass shader', instructions: 142 }],
        texture_samples: 4,
        samplers: 3,
        max_samplers: 16,
        interpolators_used: 8,
        interpolators_max: 16,
      },
    });
    const r = await materialCompileHandler({ material_path: '/Game/M_Test' });
    expect(r.content).toHaveLength(2);
    // First block is the raw JSON, second is the feedback.
    expect(r.content[0].text).toContain('"stats"');
    expect(r.content[1].text).toContain('OPTIMIZATION FEEDBACK');
    expect(r.content[1].text).toContain('Base pass shader: 142');
  });
});
