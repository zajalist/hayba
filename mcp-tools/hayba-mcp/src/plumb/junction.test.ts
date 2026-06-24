import { describe, it, expect } from 'vitest';
import { junctionType } from './junction.js';

describe('junctionType', () => {
  it('imperial+imperial = PORTAL', () => expect(junctionType('imperial','imperial')).toBe('PORTAL'));
  it('native+native = BOOLEAN_UNION', () => expect(junctionType('native','native')).toBe('BOOLEAN_UNION'));
  it('native+imperial = CLASH (either order)', () => {
    expect(junctionType('native','imperial')).toBe('CLASH');
    expect(junctionType('imperial','native')).toBe('CLASH');
  });
});
