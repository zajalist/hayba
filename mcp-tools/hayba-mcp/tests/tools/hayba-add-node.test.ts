import { describe, it, expect, vi } from 'vitest';
import { addNodeHandler } from '../../src/tools/hayba-add-node.js';
import type { SessionManager } from '../../src/gaea/session.js';

function makeSession(overrides: Partial<{ terrainPath: string | null }> = {}): SessionManager {
  const addNodeMock = vi.fn().mockResolvedValue(undefined);
  return {
    terrainPath: '/tmp/test.terrain',
    client: { addNode: addNodeMock },
    enqueue: vi.fn((fn: () => Promise<unknown>) => fn()),
    ...overrides,
  } as unknown as SessionManager;
}

describe('hayba_add_node handler', () => {
  it('returns error when no session is open', async () => {
    const result = await addNodeHandler({ type: 'Mountain', id: 'mt1' }, makeSession({ terrainPath: null }));
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('No session open');
  });

  it('returns error when type is missing', async () => {
    const result = await addNodeHandler({ id: 'mt1' }, makeSession());
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('type is required');
  });

  it('returns error when id is missing', async () => {
    const result = await addNodeHandler({ type: 'Mountain' }, makeSession());
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('id is required');
  });

  it('returns error when id is empty string', async () => {
    const result = await addNodeHandler({ type: 'Mountain', id: '  ' }, makeSession());
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('id is required');
  });

  it('delegates to client.addNode with params and position', async () => {
    const session = makeSession();
    const result = await addNodeHandler(
      { type: 'Mountain', id: 'mt1', params: { Seed: 42 }, position: { X: 100, Y: 200 } },
      session
    );
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain('Added Mountain node "mt1"');
    expect(session.client.addNode).toHaveBeenCalledWith('Mountain', 'mt1', { Seed: 42 }, { X: 100, Y: 200 });
  });

  it('passes empty params when not provided', async () => {
    const session = makeSession();
    await addNodeHandler({ type: 'Erosion', id: 'er1' }, session);
    expect(session.client.addNode).toHaveBeenCalledWith('Erosion', 'er1', {}, undefined);
  });
});
