import { describe, it, expect, vi } from 'vitest';
import { RateLimiter } from '../../src/tools/hayba-rate-limiter.js';

describe('RateLimiter', () => {
  it('allows up to N requests per window then blocks', () => {
    const rl = new RateLimiter({ limit: 3, windowMs: 60_000 });
    expect(rl.check('s1').allowed).toBe(true);
    expect(rl.check('s1').allowed).toBe(true);
    expect(rl.check('s1').allowed).toBe(true);
    expect(rl.check('s1').allowed).toBe(false);
  });

  it('expires entries after window', () => {
    const now = vi.fn(() => 0);
    const rl = new RateLimiter({ limit: 1, windowMs: 1000, now });
    expect(rl.check('s1').allowed).toBe(true);
    expect(rl.check('s1').allowed).toBe(false);
    now.mockReturnValue(2000);
    expect(rl.check('s1').allowed).toBe(true);
  });

  it('keys are independent', () => {
    const rl = new RateLimiter({ limit: 1, windowMs: 60_000 });
    expect(rl.check('a').allowed).toBe(true);
    expect(rl.check('b').allowed).toBe(true);
    expect(rl.check('a').allowed).toBe(false);
  });
});
