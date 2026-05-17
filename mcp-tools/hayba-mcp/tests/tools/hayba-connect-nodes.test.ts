import { describe, it, expect, vi } from 'vitest';
import { connectNodesHandler } from '../../src/tools/hayba-connect-nodes.js';
import type { SessionManager } from '../../src/gaea/session.js';

function makeSession(overrides: Partial<{ terrainPath: string | null }> = {}): SessionManager {
  return {
    terrainPath: '/tmp/test.terrain',
    client: { connectNodes: vi.fn().mockResolvedValue(undefined) },
    enqueue: vi.fn((fn: () => Promise<unknown>) => fn()),
    ...overrides,
  } as unknown as SessionManager;
}

describe('hayba_connect_nodes handler', () => {
  it('returns error when no session is open', async () => {
    const result = await connectNodesHandler(
      { from_id: 'a', from_port: 'Out', to_id: 'b', to_port: 'In' },
      makeSession({ terrainPath: null })
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('No session open');
  });

  for (const field of ['from_id', 'from_port', 'to_id', 'to_port'] as const) {
    it(`returns error when ${field} is missing`, async () => {
      const args: Record<string, string> = { from_id: 'a', from_port: 'Out', to_id: 'b', to_port: 'In' };
      delete args[field];
      const result = await connectNodesHandler(args, makeSession());
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain(field);
    });
  }

  it('delegates to client.connectNodes and returns success', async () => {
    const session = makeSession();
    const result = await connectNodesHandler(
      { from_id: 'mt1', from_port: 'Out', to_id: 'er1', to_port: 'In' },
      session
    );
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain('mt1:Out → er1:In');
    expect(session.client.connectNodes).toHaveBeenCalledWith('mt1', 'Out', 'er1', 'In');
  });

  it('returns error when client.connectNodes throws', async () => {
    const session = makeSession();
    (session.client.connectNodes as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Node "x" not found'));
    const result = await connectNodesHandler(
      { from_id: 'x', from_port: 'Out', to_id: 'y', to_port: 'In' },
      session
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Node "x" not found');
  });
});
