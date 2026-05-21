import { describe, it, expect } from 'vitest';
import { SliverCycleError, SliverDepthError, SliverNotFoundError, SliverValidationError } from './types.js';

describe('sliver error types', () => {
  it('SliverCycleError carries the offending id and the call stack', () => {
    const err = new SliverCycleError('com.hayba.a', ['com.hayba.b', 'com.hayba.a']);
    expect(err.name).toBe('SliverCycleError');
    expect(err.id).toBe('com.hayba.a');
    expect(err.stack_ids).toEqual(['com.hayba.b', 'com.hayba.a']);
    expect(err.message).toContain('com.hayba.a');
  });

  it('SliverDepthError reports the depth that was exceeded', () => {
    const err = new SliverDepthError(8);
    expect(err.maxDepth).toBe(8);
    expect(err.message).toContain('8');
  });

  it('SliverNotFoundError carries the missing id', () => {
    expect(new SliverNotFoundError('com.x.y').id).toBe('com.x.y');
  });

  it('SliverValidationError keeps the human reason', () => {
    expect(new SliverValidationError('missing required param "target"').message).toContain('target');
  });
});
