// mcp-tools/hayba-mcp/src/tools/blueprint/spec-builder/spec-parse.test.ts
// Ported from bpgraph.test.mjs (the first consumer project's spec tool)
// (lines 249-255), plus the parser behaviour check() relies on.
import { describe, expect, it } from 'vitest';
import { CATEGORY_OF_KIND, parseSpecText, parseType } from './spec-parse.js';

describe('parseType', () => {
  // bpgraph.test.mjs:249-255
  it('follows the Hayba grammar', () => {
    expect(parseType('Float')).toEqual({ kind: 'real', path: '', array: false });
    expect(parseType(' linear_color ')).toEqual({ kind: 'struct', path: '/Script/CoreUObject.LinearColor', array: false });
    expect(parseType('array<object:/Script/Engine.Actor>')).toEqual({ kind: 'object', path: '/Script/Engine.Actor', array: true });
    expect(parseType('enum:/Game/Enums/E_State')).toEqual({ kind: 'enum', path: '/Game/Enums/E_State', array: false });
    expect('error' in parseType('')).toBe(true);
  });

  it('refuses what the plugin would refuse later with a worse message', () => {
    expect(parseType('vector3')).toMatchObject({ error: expect.stringMatching(/unknown type 'vector3'/) });
    expect(parseType('obj:/Script/Engine.Actor')).toMatchObject({ error: expect.stringMatching(/unknown reference kind 'obj'/) });
    expect(parseType('object:Engine.Actor')).toMatchObject({ error: expect.stringMatching(/needs a full path/) });
    expect(parseType('array<float')).toMatchObject({ error: expect.stringMatching(/never closes/) });
    expect(parseType('array<array<int>>')).toMatchObject({ error: expect.stringMatching(/arrays of arrays/) });
    expect(parseType('object:/Game/UI/WBP_Title')).toMatchObject({ error: expect.stringMatching(/ends in \.Name_C/) });
    expect(parseType(3)).toEqual({ error: 'type must be a string' });
  });

  it('maps every kind to the pin category blueprint_get_info reports', () => {
    expect(CATEGORY_OF_KIND.real).toBe('real');
    expect(CATEGORY_OF_KIND.enum).toBe('byte');
    expect(CATEGORY_OF_KIND.soft_object).toBe('softobject');
  });
});

describe('parseSpecText', () => {
  // bpgraph.test.mjs:257-259
  it('reports line and column', () => {
    expect(() => parseSpecText('{\n  "a": tru\n}')).toThrow(/line 2, column 8/);
  });

  it('names every duplicate key instead of silently keeping the last', () => {
    const r = parseSpecText('{"graphs":[{"nodes":{"g":{"get":"Glow"},"g":{"branch":true}}}]}');
    expect(r.duplicates).toEqual(['graphs[0].nodes: duplicate key "g"']);
  });

  it('accepts // and /* */ comments and a byte-order mark', () => {
    const r = parseSpecText('\uFEFF// header\n{ /* the package */ "asset": "/Game/X" }');
    expect(r.value).toEqual({ asset: '/Game/X' });
    expect(r.duplicates).toEqual([]);
  });

  it('refuses trailing commas and trailing text', () => {
    expect(() => parseSpecText('{"asset": "/Game/X", }')).toThrow(/trailing comma at line 1/);
    expect(() => parseSpecText('{} x')).toThrow(/unexpected text after the JSON value/);
  });

  it('does not let a "__proto__" key reach the prototype', () => {
    const r = parseSpecText('{"__proto__": {"polluted": true}}');
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.keys(r.value as object)).toEqual(['__proto__']);
  });
});
