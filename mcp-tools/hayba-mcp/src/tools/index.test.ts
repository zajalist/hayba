import { describe, it, expect } from 'vitest';
import { registerTools } from './index.js';

describe('Tools index', () => {
  it('should export registerTools function', () => {
    expect(typeof registerTools).toBe('function');
  });
});
