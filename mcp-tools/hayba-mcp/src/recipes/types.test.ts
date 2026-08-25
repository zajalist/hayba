import { describe, it, expect } from 'vitest';
import { RecipeCycleError, RecipeDepthError, RecipeNotFoundError, RecipeValidationError } from './types.js';

describe('recipe error types', () => {
  it('RecipeCycleError carries the offending id and the call stack', () => {
    const err = new RecipeCycleError('com.hayba.a', ['com.hayba.b', 'com.hayba.a']);
    expect(err.name).toBe('RecipeCycleError');
    expect(err.id).toBe('com.hayba.a');
    expect(err.stack_ids).toEqual(['com.hayba.b', 'com.hayba.a']);
    expect(err.message).toContain('com.hayba.a');
  });

  it('RecipeDepthError reports the depth that was exceeded', () => {
    const err = new RecipeDepthError(8);
    expect(err.maxDepth).toBe(8);
    expect(err.message).toContain('8');
  });

  it('RecipeNotFoundError carries the missing id', () => {
    expect(new RecipeNotFoundError('com.x.y').id).toBe('com.x.y');
  });

  it('RecipeValidationError keeps the human reason', () => {
    expect(new RecipeValidationError('missing required param "target"').message).toContain('target');
  });
});
