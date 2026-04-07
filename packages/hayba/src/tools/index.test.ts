import { describe, it, expect } from 'vitest';

describe('Tools index', () => {
  it('should export registerTools function', async () => {
    const { registerTools } = await import('./index.js');
    expect(typeof registerTools).toBe('function');
  });
});
