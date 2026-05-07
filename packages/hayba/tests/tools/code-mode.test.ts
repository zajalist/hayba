import { describe, it, expect } from 'vitest';
import { listToolCategoriesHandler } from '../../src/tools/code-mode/list-tool-categories.js';
import { getToolSignatureHandler } from '../../src/tools/code-mode/get-tool-signature.js';

const fakeSession = {} as any;

describe('list_tool_categories', () => {
  it('returns 31 domains and ~157 commands', async () => {
    const r = await listToolCategoriesHandler({}, fakeSession);
    const payload = JSON.parse(r.content[0].text);
    expect(payload.domains.length).toBeGreaterThanOrEqual(30);
    expect(payload.total_commands).toBeGreaterThanOrEqual(150);
  });
});

describe('get_tool_signature', () => {
  it('returns schema for a known command', async () => {
    const r = await getToolSignatureHandler({ command: 'actor_spawn' }, fakeSession);
    const payload = JSON.parse(r.content[0].text);
    expect(payload.command).toBe('actor_spawn');
    expect(payload.params.class_path).toBeDefined();
  });

  it('returns no_schema_available for unknown', async () => {
    const r = await getToolSignatureHandler({ command: 'nonexistent_xyz' }, fakeSession);
    const payload = JSON.parse(r.content[0].text);
    expect(payload.status).toBe('no_schema_available');
  });

  it('errors on missing command param', async () => {
    const r = await getToolSignatureHandler({}, fakeSession);
    expect(r.isError).toBe(true);
  });
});
