import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { buildHandsManifest, guardInboundToolCall, shapeToolResult, TOOL_RESULT_CAP_BYTES } from './hands-guard.js';

const perms = { 'tools.execute': true, 'facts.vision': false, 'facts.scene': false, python_run: false };
const shapes: Record<string, z.ZodRawShape> = {
  asset_delete: { path: z.string() },
  world_inspect: {},
  editor_run_console_command: { command: z.string() },
  level_query: { limit: z.number().default(10) },
  python_run: { script: z.string() },
};
const ctx = (over: Partial<Parameters<typeof guardInboundToolCall>[2]> = {}) => ({
  manifest: new Set(Object.keys(shapes)),
  permissions: perms,
  mode: 'production' as const,
  rawShape: (n: string) => shapes[n],
  ...over,
});

describe('guardInboundToolCall', () => {
  it('rejects tools outside the manifest', () => {
    expect(guardInboundToolCall('shell_exec', {}, ctx())).toMatchObject({ ok: false, code: 'unknown_tool' });
  });
  it('rejects schema-invalid args', () => {
    expect(guardInboundToolCall('asset_delete', { path: 7 }, ctx())).toMatchObject({ ok: false, code: 'invalid_args' });
  });
  it('blocks python tools without the local permission', () => {
    expect(guardInboundToolCall('python_run', { script: 'x' }, ctx())).toMatchObject({ ok: false, code: 'permission_denied' });
  });
  it('blocks everything when tools.execute is off', () => {
    expect(guardInboundToolCall('world_inspect', {}, ctx({ permissions: { ...perms, 'tools.execute': false } })))
      .toMatchObject({ ok: false, code: 'permission_denied' });
  });
  it('blocks mutations in explore mode', () => {
    expect(guardInboundToolCall('asset_delete', { path: '/Game/X' }, ctx({ mode: 'explore' })))
      .toMatchObject({ ok: false, code: 'read_only_mode' });
  });
  it('allows a valid manifest call', () => {
    expect(guardInboundToolCall('asset_delete', { path: '/Game/X' }, ctx())).toEqual({ ok: true, args: { path: '/Game/X' } });
  });
  it('hands back the Zod-parsed args (defaults applied, unknown keys dropped), not the raw ones', () => {
    expect(guardInboundToolCall('level_query', { sneaky: true }, ctx())).toEqual({ ok: true, args: { limit: 10 } });
  });
  it('blocks the py console command when python_run is off', () => {
    for (const command of ['py import os', 'PY print(1)', '  py.cmd x']) {
      expect(guardInboundToolCall('editor_run_console_command', { command }, ctx())).toMatchObject({ ok: false, code: 'permission_denied' });
    }
    expect(guardInboundToolCall('editor_run_console_command', { command: 'stat unit' }, ctx())).toMatchObject({ ok: true });
    expect(guardInboundToolCall('editor_run_console_command', { command: 'py print(1)' }, ctx({ permissions: { ...perms, python_run: true } })))
      .toMatchObject({ ok: true });
  });
});

describe('shapeToolResult', () => {
  it('redacts secrets before they leave the machine', () => {
    const out = shapeToolResult({ note: 'key sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' });
    expect(JSON.stringify(out.result)).not.toContain('sk-ant-api03-AAAA');
    expect(out.truncated).toBe(false);
  });
  it('caps huge results with a marker', () => {
    const out = shapeToolResult({ blob: 'lorem ipsum '.repeat(TOOL_RESULT_CAP_BYTES / 6) });
    expect(out.truncated).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(out.result))).toBeLessThanOrEqual(TOOL_RESULT_CAP_BYTES);
    expect(out.result).toMatchObject({ truncated: true });
  });
  const png = Buffer.alloc(9000, 7).toString('base64');
  it('R8: replaces MCP image content blocks with an omitted marker', () => {
    const out = shapeToolResult({ content: [{ type: 'text', text: 'captured' }, { type: 'image', data: png, mimeType: 'image/png' }] });
    expect(out.result).toEqual({ content: [{ type: 'text', text: 'captured' }, { omitted: 'image' }] });
    expect(out.truncated).toBe(false);
  });
  it('R8: strips image_base64 fields and data:image URLs', () => {
    const out = shapeToolResult({ image_base64: 'iVBORw0KGgo=', thumb: 'data:image/png;base64,iVBORw0KGgo=', path: '/Game/Shot' });
    expect(out.result).toEqual({ image_base64: { omitted: 'image' }, thumb: { omitted: 'image' }, path: '/Game/Shot' });
  });
  it('R8: strips long base64 strings anywhere, but keeps long ordinary text', () => {
    const text = 'a normal long log line. '.repeat(300);
    const out = shapeToolResult({ nested: [{ frame: png }], log: text });
    expect(out.result).toEqual({ nested: [{ frame: { omitted: 'image' } }], log: text });
    expect(JSON.stringify(out.result)).not.toContain(png.slice(0, 64));
  });
  // A long newline-separated token list (actor names, /Game paths) is text, not
  // base64 — even when its non-whitespace characters happen to be base64-legal.
  function tokenList(prefix: string, minBytes: number): string {
    const lines: string[] = [];
    for (let i = 0; lines.join('\n').length < minBytes; i++) lines.push(`${prefix}${i}`);
    let s = lines.join('\n');
    while (s.replace(/\s+/g, '').length % 4 !== 0) s += 'X'; // the old whitespace-stripping check called this base64
    return s;
  }
  const wrap = (s: string, n: number, eol = '\n') => s.match(new RegExp(`.{1,${n}}`, 'g'))!.join(eol);
  const bin = Buffer.from(Array.from({ length: 9000 }, (_, i) => (i * 37) % 256)).toString('base64');
  it('R8: keeps a 5 KB newline-separated actor-name list verbatim', () => {
    const actors = tokenList('StaticMeshActor_', 5 * 1024);
    expect(shapeToolResult({ actors }).result).toEqual({ actors });
  });
  it('R8: keeps a 5 KB newline-separated /Game path list verbatim', () => {
    const paths = tokenList('/Game/Props/SM_Rock_', 5 * 1024);
    expect(shapeToolResult({ paths }).result).toEqual({ paths });
  });
  it('R8: strips a real base64 PNG whether single-line, base64url, or MIME-wrapped at 76/64 columns', () => {
    const url = bin.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    for (const frame of [bin, url, wrap(bin, 76, '\r\n'), wrap(bin, 64), `${wrap(bin, 76)}\n`]) {
      expect(shapeToolResult({ frame }).result).toEqual({ frame: { omitted: 'image' } });
    }
  });
  it('R8: base64-legal text with irregular line breaks or spaces is kept', () => {
    const ragged = wrap(bin, 50);
    const spaced = wrap(bin, 76, ' ');
    expect(shapeToolResult({ ragged, spaced }).result).toEqual({ ragged, spaced });
  });
});

describe('buildHandsManifest', () => {
  it('keeps only public name/description/schema', () => {
    const m = buildHandsManifest([{ name: 'a', description: 'd', input_schema: { type: 'object', properties: {} } }]);
    expect(m).toEqual([{ name: 'a', description: 'd', input_schema: { type: 'object', properties: {} } }]);
  });
});
