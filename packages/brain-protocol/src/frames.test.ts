import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseFrame, PROTOCOL_VERSION, argsHash } from './index.js';

const dir = (k: 'valid' | 'invalid') => fileURLToPath(new URL(`../fixtures/${k}/`, import.meta.url));

describe('brain protocol fixtures', () => {
  for (const f of readdirSync(dir('valid'))) {
    it(`accepts ${f}`, () => {
      const r = parseFrame(readFileSync(dir('valid') + f, 'utf8'));
      expect(r.ok, r.ok ? '' : r.error).toBe(true);
    });
  }
  for (const f of readdirSync(dir('invalid'))) {
    it(`rejects ${f}`, () => {
      expect(parseFrame(readFileSync(dir('invalid') + f, 'utf8')).ok).toBe(false);
    });
  }
});

describe('parseFrame', () => {
  it('rejects non-JSON without throwing', () => {
    expect(parseFrame('{nope').ok).toBe(false);
  });
  it('rejects a future protocol version', () => {
    const r = parseFrame(JSON.stringify({ v: 2, type: 'ping', session_id: 's', seq: 1 }));
    expect(r.ok).toBe(false);
  });
  it('pins the version', () => {
    expect(PROTOCOL_VERSION).toBe(1);
  });
});

describe('argsHash', () => {
  it('is key-order independent', () => {
    expect(argsHash({ b: 1, a: [2, { d: 1, c: 2 }] })).toBe(argsHash({ a: [2, { c: 2, d: 1 }], b: 1 }));
  });
});
