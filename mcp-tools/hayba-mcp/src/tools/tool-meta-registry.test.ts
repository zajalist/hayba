import { describe, it, expect, beforeEach } from 'vitest';
import { registerToolMeta, getToolMeta, resetToolMetaRegistry } from './tool-meta-registry.js';
import type { HaybaToolMeta } from './hayba-tool-meta.js';

const META: HaybaToolMeta = { cost: 'medium', effects: [], when: 'x', not_when: 'y' };

describe('tool-meta-registry', () => {
  beforeEach(() => resetToolMetaRegistry());

  it('stores and retrieves meta by command name', () => {
    registerToolMeta('actor_spawn', { ...META, cost: 'high' });
    expect(getToolMeta('actor_spawn')?.cost).toBe('high');
  });

  it('returns undefined for unknown command', () => {
    expect(getToolMeta('not_registered')).toBeUndefined();
  });

  it('last write wins on duplicate registration', () => {
    registerToolMeta('x', { ...META, cost: 'low' });
    registerToolMeta('x', { ...META, cost: 'high' });
    expect(getToolMeta('x')?.cost).toBe('high');
  });
});
