// mcp-tools/hayba-mcp/src/dag/uri.test.ts
import { describe, it, expect } from 'vitest';
import { parseUri, isUri, DAG_NAMESPACES } from './uri.js';

describe('uri', () => {
  it('parses each known namespace', () => {
    expect(parseUri('ue://Game/Cameras/CamA')).toEqual({ ok: true, namespace: 'ue', rest: 'Game/Cameras/CamA' });
    expect(parseUri('planet://snapshot/seed_4242')).toEqual({ ok: true, namespace: 'planet', rest: 'snapshot/seed_4242' });
    expect(parseUri('file:///C:/tmp/h.png')).toEqual({ ok: true, namespace: 'file', rest: '/C:/tmp/h.png' });
    expect(parseUri('sliver://run/abc123')).toEqual({ ok: true, namespace: 'sliver', rest: 'run/abc123' });
  });

  it('rejects unknown namespaces and malformed strings', () => {
    expect(parseUri('http://example.com').ok).toBe(false);
    expect(parseUri('not-a-uri').ok).toBe(false);
    expect(parseUri('ue://').ok).toBe(false);
    expect(parseUri('').ok).toBe(false);
  });

  it('isUri is a boolean shortcut for parseUri().ok', () => {
    expect(isUri('ue://Game/X')).toBe(true);
    expect(isUri('plain string')).toBe(false);
  });

  it('exposes the known namespace list', () => {
    expect([...DAG_NAMESPACES].sort()).toEqual(['file', 'planet', 'sliver', 'ue']);
  });
});
