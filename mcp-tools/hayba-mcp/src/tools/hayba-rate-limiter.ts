export interface RateLimiterOptions {
  limit: number;
  windowMs: number;
  now?: () => number;
}
export interface RateCheck {
  allowed: boolean;
  remaining: number;
  resetMs: number;
}

export class RateLimiter {
  private hits = new Map<string, number[]>();
  private opts: Required<RateLimiterOptions>;

  constructor(opts: RateLimiterOptions) {
    this.opts = { now: () => Date.now(), ...opts };
  }

  check(key: string): RateCheck {
    const t = this.opts.now();
    const cutoff = t - this.opts.windowMs;
    const arr = (this.hits.get(key) ?? []).filter(x => x > cutoff);
    if (arr.length >= this.opts.limit) {
      return {
        allowed: false,
        remaining: 0,
        resetMs: arr[0] + this.opts.windowMs - t,
      };
    }
    arr.push(t);
    this.hits.set(key, arr);
    return {
      allowed: true,
      remaining: this.opts.limit - arr.length,
      resetMs: this.opts.windowMs,
    };
  }
}
