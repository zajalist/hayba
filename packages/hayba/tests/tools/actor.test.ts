import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockSend = vi.fn();
vi.mock('../../src/tcp-client.js', () => ({
  ensureConnected: vi.fn(async () => ({ send: mockSend })),
}));

beforeEach(() => { mockSend.mockReset(); });

import { actorSpawnHandler } from '../../src/tools/actor/actor-spawn.js';
import { actorDeleteHandler } from '../../src/tools/actor/actor-delete.js';
import { actorTransformHandler } from '../../src/tools/actor/actor-transform.js';
import { actorListHandler } from '../../src/tools/actor/actor-list.js';

const fakeSession = {} as any;

describe('actor_spawn', () => {
  it('rejects missing class_path', async () => {
    const r = await actorSpawnHandler({}, fakeSession);
    expect(r.isError).toBe(true);
  });
  it('forwards to TCP and returns ok payload', async () => {
    mockSend.mockResolvedValue({ id: '1', ok: true, data: { actor_id: 'X1' } });
    const r = await actorSpawnHandler({ class_path: '/Engine/BasicShapes/Cube.Cube_C', location: [0, 0, 0] }, fakeSession);
    expect(mockSend).toHaveBeenCalledWith('actor_spawn', expect.objectContaining({ class_path: '/Engine/BasicShapes/Cube.Cube_C' }));
    expect(r.isError).toBeFalsy();
  });
  it('surfaces TCP error', async () => {
    mockSend.mockResolvedValue({ id: '2', ok: false, error: 'boom' });
    const r = await actorSpawnHandler({ class_path: '/X' }, fakeSession);
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain('boom');
  });
});

describe('actor_delete', () => {
  it('rejects missing actor_id', async () => {
    const r = await actorDeleteHandler({}, fakeSession);
    expect(r.isError).toBe(true);
  });
  it('forwards correct cmd name', async () => {
    mockSend.mockResolvedValue({ id: '1', ok: true, data: {} });
    await actorDeleteHandler({ actor_id: 'A1' }, fakeSession);
    expect(mockSend).toHaveBeenCalledWith('actor_delete', { actor_id: 'A1' });
  });
  it('surfaces TCP error', async () => {
    mockSend.mockResolvedValue({ id: '2', ok: false, error: 'gone' });
    const r = await actorDeleteHandler({ actor_id: 'A1' }, fakeSession);
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain('gone');
  });
});

describe('actor_transform', () => {
  it('rejects missing actor_id', async () => {
    const r = await actorTransformHandler({}, fakeSession);
    expect(r.isError).toBe(true);
  });
  it('forwards correct cmd name', async () => {
    mockSend.mockResolvedValue({ id: '1', ok: true, data: {} });
    await actorTransformHandler({ actor_id: 'A1', location: [1, 2, 3] }, fakeSession);
    expect(mockSend).toHaveBeenCalledWith('actor_transform', expect.objectContaining({ actor_id: 'A1', location: [1, 2, 3] }));
  });
  it('surfaces TCP error', async () => {
    mockSend.mockResolvedValue({ id: '2', ok: false, error: 'nope' });
    const r = await actorTransformHandler({ actor_id: 'A1' }, fakeSession);
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain('nope');
  });
});

describe('actor_list', () => {
  it('happy path with no args', async () => {
    mockSend.mockResolvedValue({ id: '1', ok: true, data: { actors: [] } });
    const r = await actorListHandler({}, fakeSession);
    expect(mockSend).toHaveBeenCalledWith('actor_list', {});
    expect(r.isError).toBeFalsy();
  });
  it('passes filters', async () => {
    mockSend.mockResolvedValue({ id: '1', ok: true, data: {} });
    await actorListHandler({ class_filter: 'StaticMeshActor', tag: 'rock' }, fakeSession);
    expect(mockSend).toHaveBeenCalledWith('actor_list', { class_filter: 'StaticMeshActor', tag: 'rock' });
  });
  it('surfaces TCP error', async () => {
    mockSend.mockResolvedValue({ id: '2', ok: false, error: 'fail' });
    const r = await actorListHandler({}, fakeSession);
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toContain('fail');
  });
});
