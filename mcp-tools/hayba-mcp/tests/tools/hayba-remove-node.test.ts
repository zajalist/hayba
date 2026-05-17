import { describe, it, expect, vi } from 'vitest';
import { removeNodeHandler } from '../../src/tools/hayba-remove-node.js';
import type { SessionManager } from '../../src/gaea/session.js';

function makeSession(overrides: Partial<{ terrainPath: string | null }> = {}): SessionManager {
  return {
    terrainPath: '/tmp/test.terrain',
    client: { removeNode: vi.fn().mockResolvedValue(undefined) },
    enqueue: vi.fn((fn: () => Promise<unknown>) => fn()),
    ...overrides,
  } as unknown as SessionManager;
}

describe('hayba_remove_node handler', () => {
  it('returns error when no session is open', async () => {
    const result = await removeNodeHandler({ id: 'mt1' }, makeSession({ terrainPath: null }));
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('No session open');
  });

  it('returns error when id is missing', async () => {
    const result = await removeNodeHandler({}, makeSession());
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('id is required');
  });

  it('returns error when id is whitespace-only', async () => {
    const result = await removeNodeHandler({ id: '   ' }, makeSession());
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('id is required');
  });

  it('delegates to client.removeNode and returns success', async () => {
    const session = makeSession();
    const result = await removeNodeHandler({ id: 'mt1' }, session);
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain('Removed node "mt1"');
    expect(session.client.removeNode).toHaveBeenCalledWith('mt1');
  });

  it('returns error when client.removeNode throws', async () => {
    const session = makeSession();
    (session.client.removeNode as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('Node not found'));
    const result = await removeNodeHandler({ id: 'ghost' }, session);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Node not found');
  });
});
