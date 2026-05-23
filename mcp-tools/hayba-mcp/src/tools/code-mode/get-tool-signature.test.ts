import { describe, it, expect } from 'vitest';
import { getToolSignatureHandler } from './get-tool-signature.js';
import { listLegacyCommandNames } from '../../legacy-commands/index.js';

function parseResult(res: Awaited<ReturnType<typeof getToolSignatureHandler>>): Record<string, unknown> {
  const text = (res.content[0] as { type: string; text: string }).text;
  return JSON.parse(text) as Record<string, unknown>;
}

describe('get_tool_signature legacy stubs', () => {
  it('returns a sidecar stub for landscape_import instead of no_schema_available', async () => {
    const res = await getToolSignatureHandler({ command: 'landscape_import' }, {} as never);
    const parsed = parseResult(res);
    expect(parsed.command).toBe('landscape_import');
    expect(parsed.source).toBe('ue_legacy_stub');
    expect(parsed.params).toMatchObject({
      heightmapPath: expect.stringContaining('required'),
    });
  });

  it('returns a sidecar stub for describe_assets', async () => {
    const res = await getToolSignatureHandler({ command: 'describe_assets' }, {} as never);
    const parsed = parseResult(res);
    expect(parsed.command).toBe('describe_assets');
    expect(parsed.source).toBe('ue_legacy_stub');
  });

  it('returns a sidecar stub for pcg_create_graph', async () => {
    const res = await getToolSignatureHandler({ command: 'pcg_create_graph' }, {} as never);
    const parsed = parseResult(res);
    expect(parsed.source).toBe('ue_legacy_stub');
  });

  it('returns a sidecar stub for pcg_execute_graph', async () => {
    const res = await getToolSignatureHandler({ command: 'pcg_execute_graph' }, {} as never);
    const parsed = parseResult(res);
    expect(parsed.source).toBe('ue_legacy_stub');
  });

  it('surfaces the sidecar notes field when present (postmortem context)', async () => {
    const res = await getToolSignatureHandler({ command: 'execute_graph' }, {} as never);
    const parsed = parseResult(res);
    expect(parsed.source).toBe('ue_legacy_stub');
    expect(typeof parsed.notes).toBe('string');
    expect(parsed.notes as string).toMatch(/componentsExecuted|postmortem/i);
  });

  it('every legacy command in the sidecar (incl. aliases) resolves to a non-empty signature', async () => {
    const names = listLegacyCommandNames();
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      const res = await getToolSignatureHandler({ command: name }, {} as never);
      const parsed = parseResult(res);
      expect(parsed.command, `command ${name}`).toBe(name);
      expect(parsed.source, `command ${name}`).toBe('ue_legacy_stub');
      expect(typeof parsed.returns, `command ${name}`).toBe('string');
      expect(parsed.params, `command ${name}`).toBeDefined();
    }
  });

  it('still returns no_schema_available for genuinely unknown commands', async () => {
    const res = await getToolSignatureHandler({ command: 'utter_garbage_xyz' }, {} as never);
    const parsed = parseResult(res);
    expect(parsed.status).toBe('no_schema_available');
  });
});
