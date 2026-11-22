import { afterEach, describe, expect, it, vi } from 'vitest';
import { setDefaultSender } from '../tool-executor.js';
import { fabTools } from './fab-tools.js';
import { isDestructiveToolName } from '../../chat/agent-loop.js';

afterEach(() => setDefaultSender(undefined as never));

describe('Fab native API boundary', () => {
  it('rejects oversized queries, arbitrary URLs and unsupported acquisition before dispatch', async () => {
    const send = vi.fn(); setDefaultSender(send);
    const search = fabTools.find(t => t.name === 'fab_search')!;
    for (const args of [{ query: 'x'.repeat(501) }, { limit: 25 }, { source: 'purchase' }, { url: 'https://evil.example' }]) {
      expect((await search.handler(args, {})).isError).toBe(true);
    }
    expect(send).not.toHaveBeenCalled();
    expect(fabTools.some(t => t.name === 'fab_open')).toBe(false);
  });

  it('starts a bounded native library query and preserves queued status', async () => {
    const send = vi.fn().mockResolvedValue({ id: 'test', ok: true, data: { job_id: 'fab_' + 'a'.repeat(32), status: 'running' } });
    setDefaultSender(send);
    const result = await fabTools.find(t => t.name === 'fab_search')!.handler({ query: 'stone', source: 'library', limit: 6 }, {});
    expect(send).toHaveBeenCalledWith('fab_search', { query: 'stone', source: 'library', limit: 6, cursor: '', free_only: false }, expect.anything());
    const content = result.content[0];
    expect(content.type === 'text' && JSON.parse(content.text)).toMatchObject({ status: 'running' });
    expect(fabTools.find(t => t.name === 'fab_search')!.meta.effects).toEqual([]);
    expect(fabTools.every(t => !isDestructiveToolName(t.name))).toBe(true);
    expect(fabTools.some(t => /install|purchase|download/.test(t.name))).toBe(false);
  });
});
