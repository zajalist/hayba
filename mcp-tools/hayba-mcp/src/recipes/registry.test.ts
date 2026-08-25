import { describe, it, expect, beforeEach } from 'vitest';
import { ExecutorRegistry } from './registry.js';
import type { RecipeExecutor } from './types.js';

describe('ExecutorRegistry', () => {
  let reg: ExecutorRegistry;
  beforeEach(() => { reg = new ExecutorRegistry(); });

  it('register + get round-trips', () => {
    const fn: RecipeExecutor = async () => ({ ok: true });
    reg.register('composition.frame_target', fn);
    expect(reg.get('composition.frame_target')).toBe(fn);
  });

  it('returns undefined for unknown kind', () => {
    expect(reg.get('does.not.exist')).toBeUndefined();
  });

  it('throws on duplicate registration', () => {
    const fn: RecipeExecutor = async () => ({});
    reg.register('k', fn);
    expect(() => reg.register('k', fn)).toThrow(/already registered/);
  });

  it('lists registered kinds', () => {
    reg.register('a', async () => ({}));
    reg.register('b', async () => ({}));
    expect(reg.kinds().sort()).toEqual(['a', 'b']);
  });
});
