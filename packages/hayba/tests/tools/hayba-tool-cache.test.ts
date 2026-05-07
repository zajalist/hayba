import { describe, it, expect } from 'vitest';
import { ToolCache } from '../../src/tools/hayba-tool-cache.js';

describe('ToolCache', () => {
  it('caches read results within TTL', async () => {
    const cache = new ToolCache({ ttlSeconds: 5 });
    let calls = 0;
    const exec = async () => ({ data: ++calls });
    expect((await cache.run('actor_list', { x: 1 }, 'read', exec)).data).toBe(1);
    expect((await cache.run('actor_list', { x: 1 }, 'read', exec)).data).toBe(1);
    expect(calls).toBe(1);
  });

  it('different params bypass cache', async () => {
    const cache = new ToolCache({ ttlSeconds: 5 });
    let calls = 0;
    const exec = async () => ({ data: ++calls });
    await cache.run('actor_list', { x: 1 }, 'read', exec);
    await cache.run('actor_list', { x: 2 }, 'read', exec);
    expect(calls).toBe(2);
  });

  it('write effect invalidates all cached reads', async () => {
    const cache = new ToolCache({ ttlSeconds: 5 });
    await cache.run('actor_list', {}, 'read', async () => ({ a: 1 }));
    await cache.run('actor_spawn', {}, 'write', async () => ({ ok: true }));
    let calls = 0;
    await cache.run('actor_list', {}, 'read', async () => ({ a: ++calls }));
    expect(calls).toBe(1);
  });
});
