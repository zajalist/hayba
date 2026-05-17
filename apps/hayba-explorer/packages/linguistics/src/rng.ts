/**
 * SplitMix64 PRNG — TS port of `packages/hayba-seeds/src/lib.rs`.
 *
 * Bit-exact with the Rust reference: same input seed → identical 64-bit
 * stream. We return numbers as bigint to keep determinism across V8 versions;
 * call `nextU32()` for a JS-Number-safe 32-bit value or `nextUnit()` for a
 * uniform double in [0, 1).
 */

const MASK64 = (1n << 64n) - 1n;

function step(state: bigint): bigint {
  let z = (state + 0x9E3779B97F4A7C15n) & MASK64;
  z = ((z ^ (z >> 30n)) * 0xBF58476D1CE4E5B9n) & MASK64;
  z = ((z ^ (z >> 27n)) * 0x94D049BB133111EBn) & MASK64;
  return z ^ (z >> 31n);
}

export class SplitMix64 {
  private state: bigint;

  constructor(seed: bigint | number) {
    this.state = BigInt(seed) & MASK64;
  }

  nextU64(): bigint {
    this.state = (this.state + 0x9E3779B97F4A7C15n) & MASK64;
    return step(this.state - 0x9E3779B97F4A7C15n);
  }

  nextU32(): number {
    return Number(this.nextU64() & 0xFFFFFFFFn);
  }

  /** Uniform double in [0, 1). 53 bits of entropy. */
  nextUnit(): number {
    const u = this.nextU64() >> 11n;
    return Number(u) / 9007199254740992; // 2^53
  }

  pick<T>(arr: readonly T[]): T {
    if (arr.length === 0) throw new Error('hayba: pick() on empty array');
    return arr[Math.floor(this.nextUnit() * arr.length)]!;
  }
}

/** FNV-1a 64-bit hash of a UTF-8 string — used to derive scope sub-seeds. */
export function fnv1a64(s: string): bigint {
  let hash = 0xCBF29CE484222325n;
  const prime = 0x100000001B3n;
  for (let i = 0; i < s.length; i++) {
    hash = (hash ^ BigInt(s.charCodeAt(i))) & MASK64;
    hash = (hash * prime) & MASK64;
  }
  return hash;
}

/**
 * Derive a child seed from `(master, ...scope)`. Same arguments → same child
 * seed, forever. Use for `(master, lang_id, "place_name", index)` style
 * scoping per the brief.
 */
export function deriveSeed(master: bigint | number, ...scope: string[]): bigint {
  let mixer = new SplitMix64(BigInt(master) ^ 0x243F6A8885A308D3n);
  // Mix in each scope element so order matters and `("a", "b") !== ("b", "a")`.
  for (const tag of scope) {
    mixer = new SplitMix64(mixer.nextU64() ^ fnv1a64(tag));
  }
  return mixer.nextU64();
}
