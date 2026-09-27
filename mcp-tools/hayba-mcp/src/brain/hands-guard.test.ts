import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { buildHandsManifest, guardInboundToolCall, shapeToolResult, TOOL_RESULT_CAP_BYTES } from './hands-guard.js';

const perms = { 'tools.execute': true, 'facts.vision': false, 'facts.scene': false, python_run: false };
const shapes: Record<string, z.ZodRawShape> = {
  asset_delete: { path: z.string() },
  world_inspect: {},
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
    expect(guardInboundToolCall('asset_delete', { path: '/Game/X' }, ctx())).toEqual({ ok: true });
  });
});

describe('shapeToolResult', () => {
  it('redacts secrets before they leave the machine', () => {
    const out = shapeToolResult({ note: 'key sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' });
    expect(JSON.stringify(out.result)).not.toContain('sk-ant-api03-AAAA');
    expect(out.truncated).toBe(false);
  });
  it('caps huge results with a marker', () => {
    const out = shapeToolResult({ blob: 'x'.repeat(TOOL_RESULT_CAP_BYTES * 2) });
    expect(out.truncated).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(out.result))).toBeLessThanOrEqual(TOOL_RESULT_CAP_BYTES);
    expect(out.result).toMatchObject({ truncated: true });
  });
});

describe('buildHandsManifest', () => {
  it('keeps only public name/description/schema', () => {
    const m = buildHandsManifest([{ name: 'a', description: 'd', input_schema: { type: 'object', properties: {} } }]);
    expect(m).toEqual([{ name: 'a', description: 'd', input_schema: { type: 'object', properties: {} } }]);
  });
});
