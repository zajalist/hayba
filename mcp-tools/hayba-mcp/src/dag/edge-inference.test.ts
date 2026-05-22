// mcp-tools/hayba-mcp/src/dag/edge-inference.test.ts
import { describe, it, expect } from 'vitest';
import { inferReadsFromParams } from './edge-inference.js';

describe('inferReadsFromParams', () => {
  it('returns param values that are valid uris', () => {
    const reads = inferReadsFromParams({
      target: 'ue://Game/Maps/Demo.Actor_0',
      distance: 12,
      label: 'just a string',
    });
    expect(reads).toEqual(['ue://Game/Maps/Demo.Actor_0']);
  });

  it('ignores non-string and non-uri values', () => {
    expect(inferReadsFromParams({ a: 42, b: true, c: 'plain', d: null })).toEqual([]);
  });

  it('de-duplicates repeated uris and excludes already-declared reads', () => {
    const reads = inferReadsFromParams(
      { a: 'ue://X', b: 'ue://X', c: 'planet://snapshot/s' },
      ['planet://snapshot/s'],
    );
    expect(reads).toEqual(['ue://X']);
  });
});
