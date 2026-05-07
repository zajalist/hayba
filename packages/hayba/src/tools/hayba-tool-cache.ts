import { LRUCache } from 'lru-cache';

export type ToolEffect = 'read' | 'write' | 'destructive';

export class ToolCache {
  private cache: LRUCache<string, unknown>;

  constructor(opts: { ttlSeconds: number; max?: number }) {
    this.cache = new LRUCache({ max: opts.max ?? 200, ttl: opts.ttlSeconds * 1000 });
  }

  async run<T>(
    cmd: string,
    params: unknown,
    effect: ToolEffect,
    exec: () => Promise<T>,
  ): Promise<T> {
    if (effect !== 'read') {
      this.cache.clear();
      return exec();
    }
    const key = `${cmd}:${JSON.stringify(params)}`;
    const hit = this.cache.get(key) as T | undefined;
    if (hit !== undefined) return hit;
    const v = await exec();
    this.cache.set(key, v);
    return v;
  }
}
