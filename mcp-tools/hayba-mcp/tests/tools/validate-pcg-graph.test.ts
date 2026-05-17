import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockSend = vi.fn();
vi.mock('../../src/tcp-client.js', () => ({
  ensureConnected: vi.fn(async () => ({ send: mockSend })),
}));

describe('validate-pcg-graph', () => {
  beforeEach(() => { mockSend.mockReset(); });

  it('rejects non-JSON graph string', async () => {
    const { validatePcgGraph } = await import('../../src/tools/validate-pcg-graph.js');
    const result = await validatePcgGraph({ graph: 'not-json' });
    expect(result.valid).toBe(false);
    expect(result.errors[0].detail).toBe('Invalid JSON');
  });

  it('rejects graph without nodes/edges', async () => {
    const { validatePcgGraph } = await import('../../src/tools/validate-pcg-graph.js');
    const result = await validatePcgGraph({ graph: '{}' });
    expect(result.valid).toBe(false);
    expect(result.errors[0].detail).toContain('Missing required fields');
  });

  it('forwards valid graph to UE and returns result', async () => {
    const { validatePcgGraph } = await import('../../src/tools/validate-pcg-graph.js');
    const graphData = { nodes: [{ id: 'n1' }], edges: [{ from: 'n1', to: 'n2' }] };
    mockSend.mockResolvedValue({ id: '1', ok: true, data: { valid: true, errors: [] } });
    const result = await validatePcgGraph({ graph: JSON.stringify(graphData) });
    expect(mockSend).toHaveBeenCalledWith('validate_graph', { graph: graphData });
    expect(result.valid).toBe(true);
  });

  it('surfaces UE-side validation errors', async () => {
    const { validatePcgGraph } = await import('../../src/tools/validate-pcg-graph.js');
    const graphData = { nodes: [{ id: 'n1' }], edges: [] };
    mockSend.mockResolvedValue({ id: '2', ok: true, data: { valid: false, errors: [{ type: 'connectivity', detail: 'Disconnected node' }] } });
    const result = await validatePcgGraph({ graph: JSON.stringify(graphData) });
    expect(result.valid).toBe(false);
    expect(result.errors[0].detail).toBe('Disconnected node');
  });

  it('handles TCP failure', async () => {
    const { validatePcgGraph } = await import('../../src/tools/validate-pcg-graph.js');
    const graphData = { nodes: [{ id: 'n1' }], edges: [] };
    mockSend.mockRejectedValue(new Error('Connection refused'));
    const result = await validatePcgGraph({ graph: JSON.stringify(graphData) });
    expect(result.valid).toBe(false);
    expect(result.errors[0].type).toBe('connection');
  });

  it('handles TCP response with error flag', async () => {
    const { validatePcgGraph } = await import('../../src/tools/validate-pcg-graph.js');
    const graphData = { nodes: [{ id: 'n1' }], edges: [] };
    mockSend.mockResolvedValue({ id: '3', ok: false, error: 'UE timeout' });
    const result = await validatePcgGraph({ graph: JSON.stringify(graphData) });
    expect(result.valid).toBe(false);
    expect(result.errors[0].detail).toContain('UE timeout');
  });
});
