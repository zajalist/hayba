import { describe, expect, it } from 'vitest';
import { romanize, deromanize, defaultRomanization } from './romanization.js';

describe('romanization', () => {
  it('applies single-segment rules', () => {
    const m = { languageId: 'x', rules: [['a','o'],['i','y']] as const };
    expect(romanize('ai', m as any)).toBe('oy');
  });

  it('prefers longer IPA matches (digraphs)', () => {
    const m = { languageId: 'x', rules: [['ʃ','sh'],['s','s'],['h','h']] as const };
    expect(romanize('ʃa', m as any)).toBe('sha');
  });

  it('round-trips with deromanize when rules are unambiguous', () => {
    const m = { languageId: 'x', rules: [['ʃ','sh'],['a','a']] as const };
    const written = romanize('ʃaʃa', m as any);
    expect(written).toBe('shasha');
    expect(deromanize(written, m as any)).toBe('ʃaʃa');
  });

  it('default romanization gives sensible Latin approximations', () => {
    const m = defaultRomanization('x', ['ʃ', 'ŋ', 'a', 'i', 'θ']);
    expect(romanize('ʃiŋa', m)).toBe('shinga');
    expect(romanize('θa', m)).toBe('tha');
  });
});
