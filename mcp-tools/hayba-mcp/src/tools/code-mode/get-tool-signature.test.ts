import { describe, it, expect } from 'vitest';
import { getToolSignatureHandler } from './get-tool-signature.js';

function parseResult(res: Awaited<ReturnType<typeof getToolSignatureHandler>>): Record<string, unknown> {
  const text = (res.content[0] as { type: string; text: string }).text;
  return JSON.parse(text) as Record<string, unknown>;
}

describe('get_tool_signature legacy stubs', () => {
  it('returns a manual stub for landscape_import instead of no_schema_available', async () => {
    const res = await getToolSignatureHandler({ command: 'landscape_import' }, {} as never);
    const parsed = parseResult(res);
    expect(parsed.command).toBe('landscape_import');
    expect(parsed.source).toBe('ue_legacy_stub');
    expect(parsed.params).toMatchObject({
      heightmapPath: expect.stringContaining('required'),
    });
  });

  it('returns a manual stub for describe_assets', async () => {
    const res = await getToolSignatureHandler({ command: 'describe_assets' }, {} as never);
    const parsed = parseResult(res);
    expect(parsed.command).toBe('describe_assets');
    expect(parsed.source).toBe('ue_legacy_stub');
  });

  it('returns a manual stub for pcg_create_graph', async () => {
    const res = await getToolSignatureHandler({ command: 'pcg_create_graph' }, {} as never);
    const parsed = parseResult(res);
    expect(parsed.source).toBe('ue_legacy_stub');
  });

  it('returns a manual stub for pcg_execute_graph', async () => {
    const res = await getToolSignatureHandler({ command: 'pcg_execute_graph' }, {} as never);
    const parsed = parseResult(res);
    expect(parsed.source).toBe('ue_legacy_stub');
  });

  it('still returns no_schema_available for genuinely unknown commands', async () => {
    const res = await getToolSignatureHandler({ command: 'utter_garbage_xyz' }, {} as never);
    const parsed = parseResult(res);
    expect(parsed.status).toBe('no_schema_available');
  });
});
