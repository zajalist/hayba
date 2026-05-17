import { LRUCache } from 'lru-cache';

export type ToolEffect = 'read' | 'write' | 'destructive';

export class ToolCache {
  // `{}` here is the TS "non-nullish" upper bound that lru-cache v11 requires
  // for stored values; we never cache `undefined` (see early return below).
  private cache: LRUCache<string, {}>;

  constructor(opts: { ttlSeconds: number; max?: number }) {
    this.cache = new LRUCache<string, {}>({ max: opts.max ?? 200, ttl: opts.ttlSeconds * 1000 });
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
    if (v !== undefined && v !== null) {
      this.cache.set(key, v as {});
    }
    return v;
  }
}
